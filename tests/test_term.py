import asyncio
import fcntl
import os
import pty
import struct
import termios

from term import TerminalSession


def test_resize_updates_terminal_dimensions():
    master_fd, slave_fd = pty.openpty()
    session = TerminalSession("test-session", lambda _session_id, _value: None)
    session.master_fd = master_fd

    try:
        session.resize(cols=120, rows=40)
        dimensions = fcntl.ioctl(master_fd, termios.TIOCGWINSZ, b"\0" * 8)

        assert struct.unpack("HHHH", dimensions)[:2] == (40, 120)
    finally:
        os.close(master_fd)
        os.close(slave_fd)


def test_shell_starts_with_a_controlling_terminal_and_streams_output():
    async def run_command():
        output_chunks = asyncio.Queue()

        async def capture_output(_session_id, value):
            await output_chunks.put(value)

        session = TerminalSession("test-session", capture_output)
        await session.start()
        output = ""
        marker = "__controlling_tty_ok__"

        try:
            await session.write(
                "if test -t 0 && "
                '[ "$(ps -o tpgid= -p $$)" = "$(ps -o pgid= -p $$)" ]; '
                "then printf '__controlling_tty_ok__\\n'; fi\n"
            )
            while marker not in output:
                output += await asyncio.wait_for(output_chunks.get(), timeout=2)

            await session.write("printf 'custom-terminal-output\\n'\n")
            while "custom-terminal-output" not in output:
                output += await asyncio.wait_for(output_chunks.get(), timeout=2)
        finally:
            await session.close()

        return output

    output = asyncio.run(run_command())

    assert "__controlling_tty_ok__" in output
    assert "custom-terminal-output" in output
    assert "cannot set terminal process group" not in output
    assert "no job control in this shell" not in output


def test_shell_emits_command_output_and_exit_status_markers():
    async def run_commands():
        output_chunks = asyncio.Queue()

        async def capture_output(_session_id, value):
            await output_chunks.put(value)

        session = TerminalSession("command-block-test", capture_output)
        await session.start()
        marker = f"\x1eSHELL_APP_PROMPT:{session.prompt_token}:"
        output = ""

        async def wait_for_output(predicate):
            nonlocal output
            while not predicate(output):
                output += await asyncio.wait_for(output_chunks.get(), timeout=2)

        try:
            await wait_for_output(lambda value: f"{marker}0\x1f" in value)

            await session.write("printf 'command-block-output\\n'\n")
            await wait_for_output(lambda value: value.count(marker) >= 2)

            await session.write("false\n")
            await wait_for_output(lambda value: value.count(marker) >= 3)

            await session.write("read value; printf 'received:%s\\n' \"$value\"\n")
            await session.write("interactive-input\n")
            await wait_for_output(
                lambda value: "received:interactive-input" in value
                and value.count(marker) >= 4
            )
        finally:
            await session.close()

        return output, marker

    output, marker = asyncio.run(run_commands())

    assert "command-block-output" in output
    assert output.count("printf 'command-block-output") == 1
    assert f"{marker}0\x1f" in output
    assert f"{marker}1\x1f" in output
    assert output.count("interactive-input") == 2
    assert "received:interactive-input" in output
