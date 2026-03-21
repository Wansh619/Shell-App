import os
import pty
import asyncio
import subprocess

class TerminalSession:

    def __init__(self, websocket):
        self.master_fd = None
        self.process = None
        self.websocket = websocket

    async def start(self):
        self.master_fd, slave_fd = pty.openpty()

        self.process = subprocess.Popen(
            ["/bin/bash"],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True
        )

        loop = asyncio.get_running_loop()
        loop.add_reader(self.master_fd, self.read_output)

    def read_output(self):
        try:
            data = os.read(self.master_fd, 4096)
            asyncio.create_task(self.websocket.send(data.decode(errors="ignore")))
        except Exception:
            pass

    async def write(self, data):
        os.write(self.master_fd, data.encode())

    def close(self):
        try:
            if self.process:
                self.process.terminate()
            if self.master_fd:
                os.close(self.master_fd)
        except Exception:
            pass