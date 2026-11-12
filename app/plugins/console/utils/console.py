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


class ConsoleSession:
    def __init__(self, session_id, send_output):
        self.master_fd = None
        self.process = None
        self.session_id = session_id
        self.send_output = send_output
        self.loop = None
        self.prompt_token = uuid.uuid4().hex
        self.rc_dir = None
        self.cwd = os.getcwd()

    def get_cwd(self) -> str:
        if self.process is not None and self.process.poll() is None:
            candidate_pids = []
            if self.master_fd is not None:
                try:
                    fg_pgid = os.tcgetpgrp(self.master_fd)
                    if fg_pgid > 0:
                        candidate_pids.append(fg_pgid)
                except OSError:
                    pass
            if self.process.pid not in candidate_pids:
                candidate_pids.append(self.process.pid)

            for pid in candidate_pids:
                proc_cwd = f"/proc/{pid}/cwd"
                try:
                    if os.path.exists(proc_cwd):
                        resolved = os.readlink(proc_cwd)
                        if resolved and os.path.isdir(resolved):
                            self.cwd = resolved
                            return self.cwd
                except OSError:
                    pass

                try:
                    completed = subprocess.run(
                        ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                        capture_output=True,
                        text=True,
                        timeout=0.5,
                        check=False,
                    )
                    if completed.returncode == 0:
                        for line in completed.stdout.splitlines():
                            if line.startswith("n") and len(line) > 1:
                                candidate = line[1:]
                                if os.path.isdir(candidate):
                                    self.cwd = candidate
                                    return self.cwd
                except Exception:
                    pass

        return self.cwd or os.getcwd()

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
                        "su() { if [ $# -eq 0 ]; then command su -; "
                        "elif [ $# -eq 1 ] && [ \"${1#-}\" = \"$1\" ]; then command su - \"$1\"; "
                        "else command su \"$@\"; fi; }\n"
                        "precmd() { local s=$?; "
                        f"printf '{marker}%s\\037' \"$s\"; stty -echo; }}\n"
                        "preexec() { stty echo; }\n"
                    )
                environment["ZDOTDIR"] = self.rc_dir
                argv = [shell, "-i", "-o", "no_zle"]
            elif shell_name == "bash":
                environment["BASH_FUNC_su%%"] = (
                    "() { if [ $# -eq 0 ]; then command su -; "
                    "elif [ $# -eq 1 ] && [ \"${1#-}\" = \"$1\" ]; then command su - \"$1\"; "
                    "else command su \"$@\"; fi; }"
                )
                environment["PROMPT_COMMAND"] = (
                    "__shell_app_status=$?; "
                    "trap 'stty echo' DEBUG; "
                    f"printf '{marker}%s\\037' \"$__shell_app_status\"; "
                    "stty -echo"
                )
                argv = [shell, "--noprofile", "--norc", "--noediting", "-i"]
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


TerminalSession = ConsoleSession
