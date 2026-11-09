import asyncio
import fcntl
import os
import pty
import pwd
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import uuid


def _attach_controlling_terminal(slave_fd):
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)


SUPPORTED_FALLBACK_SHELL = "/bin/bash"


def resolve_shell():
    """Pick the shell: SHELL_APP_SHELL, then the account's login shell, then $SHELL."""
    candidates = [os.environ.get("SHELL_APP_SHELL")]
    try:
        candidates.append(pwd.getpwuid(os.geteuid()).pw_shell)
    except KeyError:
        pass
    candidates.append(os.environ.get("SHELL"))
    for candidate in candidates:
        if not candidate:
            continue
        path = candidate if os.path.isabs(candidate) else shutil.which(candidate)
        if (
            path
            and os.access(path, os.X_OK)
            and os.path.basename(path) not in {"nologin", "false", "fish"}
        ):
            return path
    return SUPPORTED_FALLBACK_SHELL


class TerminalSession:
    def __init__(self, session_id, send_output):
        self.master_fd = None
        self.process = None
        self.session_id = session_id
        self.send_output = send_output
        self.loop = None
        self.prompt_token = uuid.uuid4().hex
        self.rc_dir = None

    async def start(self):
        self.master_fd, slave_fd = pty.openpty()
        self.resize(cols=80, rows=24)
        try:
            terminal_settings = termios.tcgetattr(slave_fd)
            terminal_settings[3] |= termios.ECHO
            termios.tcsetattr(slave_fd, termios.TCSANOW, terminal_settings)

            shell = resolve_shell()
            shell_name = os.path.basename(shell)
            environment = os.environ.copy()
            environment["PS1"] = ""
            environment["TERM"] = "dumb"
            marker = f"\\036SHELL_APP_PROMPT:{self.prompt_token}:"

            if shell_name == "zsh":
                self.rc_dir = tempfile.mkdtemp(prefix="shell-app-zsh-")
                with open(os.path.join(self.rc_dir, ".zshrc"), "w") as rc:
                    rc.write(
                        "PS1=''\nPROMPT=''\nRPROMPT=''\n"
                        "precmd() { local s=$?; "
                        f"printf '{marker}%s\\037' \"$s\"; stty -echo; }}\n"
                        "preexec() { stty echo; }\n"
                    )
                environment["ZDOTDIR"] = self.rc_dir
                argv = [shell, "-i", "-o", "no_zle"]
            elif shell_name == "bash":
                environment["PROMPT_COMMAND"] = (
                    "__shell_app_status=$?; "
                    "stty -echo; "
                    "trap 'stty echo' DEBUG; "
                    f"printf '{marker}%s\\037' \"$__shell_app_status\""
                )
                argv = [shell, "--noprofile", "--norc", "-i"]
            else:
                # sh, dash, ksh, busybox ash...: expand the status inside PS1.
                environment["PS1"] = f"\x1eSHELL_APP_PROMPT:{self.prompt_token}:$?\x1f"
                environment["ENV"] = os.devnull
                argv = [shell, "-i"]

            self.process = subprocess.Popen(
                argv,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                close_fds=True,
                env=environment,
                preexec_fn=lambda: _attach_controlling_terminal(slave_fd),
            )
        finally:
            os.close(slave_fd)

        self.loop = asyncio.get_running_loop()
        self.loop.add_reader(self.master_fd, self.read_output)

    def read_output(self):
        try:
            data = os.read(self.master_fd, 4096)
        except OSError:
            if self.loop and self.master_fd is not None:
                self.loop.remove_reader(self.master_fd)
            return

        if not data:
            if self.loop and self.master_fd is not None:
                self.loop.remove_reader(self.master_fd)
            return

        if self.loop:
            self.loop.create_task(
                self.send_output(self.session_id, data.decode(errors="ignore"))
            )

    def resize(self, cols, rows):
        if self.master_fd is None:
            return

        fcntl.ioctl(
            self.master_fd,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", rows, cols, 0, 0),
        )

    async def write(self, data):
        if self.master_fd is not None:
            await asyncio.to_thread(os.write, self.master_fd, data.encode())

    async def close(self):
        if self.master_fd is not None:
            if self.loop:
                self.loop.remove_reader(self.master_fd)
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None

        if self.process:
            if self.process.poll() is None:
                try:
                    os.killpg(self.process.pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass
            try:
                await asyncio.to_thread(self.process.wait, timeout=1)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                await asyncio.to_thread(self.process.wait)
            self.process = None

        if self.rc_dir:
            shutil.rmtree(self.rc_dir, ignore_errors=True)
            self.rc_dir = None
