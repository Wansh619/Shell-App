import asyncio
import fcntl
import os
import pty
import signal
import struct
import subprocess
import termios
import uuid


def _attach_controlling_terminal(slave_fd):
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)


class TerminalSession:
    def __init__(self, session_id, send_output):
        self.master_fd = None
        self.process = None
        self.session_id = session_id
        self.send_output = send_output
        self.loop = None
        self.prompt_token = uuid.uuid4().hex

    async def start(self):
        self.master_fd, slave_fd = pty.openpty()
        self.resize(cols=80, rows=24)
        try:
            terminal_settings = termios.tcgetattr(slave_fd)
            terminal_settings[3] |= termios.ECHO
            termios.tcsetattr(slave_fd, termios.TCSANOW, terminal_settings)

            environment = os.environ.copy()
            environment["PS1"] = ""
            environment["TERM"] = "dumb"
            environment["PROMPT_COMMAND"] = (
                "__shell_app_status=$?; "
                "trap 'stty echo' DEBUG; "
                "printf '\\036SHELL_APP_PROMPT:"
                f"{self.prompt_token}"
                ":%s\\037' \"$__shell_app_status\"; "
                "stty -echo"
            )

            self.process = subprocess.Popen(
                ["/bin/bash", "--noprofile", "--norc", "-i"],
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
                except ProcessLookupError:
                    pass
            try:
                await asyncio.to_thread(self.process.wait, timeout=1)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await asyncio.to_thread(self.process.wait)
            self.process = None