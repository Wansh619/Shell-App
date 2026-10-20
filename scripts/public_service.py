import email.message
import logging
import os
import pwd
import queue
import re
import shutil
import signal
import smtplib
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
QUICK_TUNNEL_URL = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
HEALTH_TIMEOUT = 60
TUNNEL_TIMEOUT = 120

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("shell_app_service")


def required_setting(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Required setting {name} is not configured.")
    return value


def get_mail_settings():
    recipients = [
        address.strip()
        for address in required_setting("SHELL_APP_SMTP_TO").split(",")
        if address.strip()
    ]
    if not recipients:
        raise RuntimeError("SHELL_APP_SMTP_TO must contain at least one address.")

    username = os.environ.get("SHELL_APP_SMTP_USERNAME", "").strip()
    password = os.environ.get("SHELL_APP_SMTP_PASSWORD", "")
    use_ssl = os.environ.get("SHELL_APP_SMTP_SSL", "false").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    starttls = os.environ.get("SHELL_APP_SMTP_STARTTLS", "true").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if use_ssl and starttls:
        raise RuntimeError(
            "Choose either implicit SMTP SSL or STARTTLS, not both."
        )
    if bool(username) != bool(password):
        raise RuntimeError(
            "SHELL_APP_SMTP_USERNAME and SHELL_APP_SMTP_PASSWORD must be set together."
        )

    return {
        "host": required_setting("SHELL_APP_SMTP_HOST"),
        "port": int(os.environ.get("SHELL_APP_SMTP_PORT", "587")),
        "username": username,
        "password": password,
        "sender": required_setting("SHELL_APP_SMTP_FROM"),
        "recipients": recipients,
        "starttls": starttls,
        "ssl": use_ssl,
    }


def send_tunnel_email(url, settings):
    message = email.message.EmailMessage()
    message["Subject"] = "Shell App is available"
    message["From"] = settings["sender"]
    message["To"] = ", ".join(settings["recipients"])
    message.set_content(
        "The Shell App service has started.\n\n"
        f"Temporary access URL: {url}\n\n"
        "This Cloudflare Quick Tunnel URL changes when the service restarts."
    )

    context = ssl.create_default_context()
    smtp_class = smtplib.SMTP_SSL if settings["ssl"] else smtplib.SMTP
    smtp_options = {"timeout": 20}
    if settings["ssl"]:
        smtp_options["context"] = context
    with smtp_class(settings["host"], settings["port"], **smtp_options) as smtp:
        smtp.ehlo()
        if settings["starttls"]:
            smtp.starttls(context=context)
            smtp.ehlo()
        if settings["username"]:
            smtp.login(settings["username"], settings["password"])
        smtp.send_message(message)


def wait_for_health(app_process, host, port):
    deadline = time.monotonic() + HEALTH_TIMEOUT
    health_host = "127.0.0.1" if host == "0.0.0.0" else host
    health_url = f"http://{health_host}:{port}/health"
    while time.monotonic() < deadline:
        if app_process.poll() is not None:
            raise RuntimeError("The Shell App process exited before becoming healthy.")
        try:
            with urllib.request.urlopen(health_url, timeout=2) as response:
                if response.status == 200:
                    logger.info("Shell App is healthy at %s", health_url)
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.5)
    raise TimeoutError(f"Shell App did not become healthy at {health_url}.")


def start_tunnel():
    binary = os.environ.get("CLOUDFLARED_BIN") or shutil.which("cloudflared")
    if not binary:
        raise RuntimeError(
            "cloudflared is not installed or not on PATH; set CLOUDFLARED_BIN."
        )

    port = int(os.environ.get("SHELL_APP_PORT", "5000"))
    process = subprocess.Popen(
        [
            binary,
            "tunnel",
            "--no-autoupdate",
            "--url",
            f"http://127.0.0.1:{port}",
        ],
        cwd=APP_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=child_environment(),
        preexec_fn=drop_child_privileges,
    )
    output_lines = queue.Queue()

    def read_output():
        for line in process.stdout:
            output_lines.put(line.rstrip())

    threading.Thread(target=read_output, daemon=True).start()
    return process, output_lines


def child_environment():
    environment = os.environ.copy()
    for name in tuple(environment):
        if name.startswith("SHELL_APP_SMTP_"):
            environment.pop(name)

    account = get_run_account()
    if account:
        environment["HOME"] = account.pw_dir
        environment["USER"] = account.pw_name
        environment["LOGNAME"] = account.pw_name
        environment["PATH"] = "/usr/local/bin:/usr/bin:/bin"
    return environment


def get_run_account():
    if os.geteuid() != 0:
        return None
    username = os.environ.get("SHELL_APP_RUN_USER", "shell-app")
    try:
        return pwd.getpwnam(username)
    except KeyError as error:
        raise RuntimeError(f"Service account {username!r} does not exist.") from error


def drop_child_privileges():
    account = get_run_account()
    if account is None:
        return
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)


def wait_for_tunnel_url(process, output_lines):
    deadline = time.monotonic() + TUNNEL_TIMEOUT
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"cloudflared exited with status {process.returncode} before creating a tunnel."
            )
        try:
            line = output_lines.get(timeout=0.5)
        except queue.Empty:
            continue

        logger.info("cloudflared: %s", line)
        match = QUICK_TUNNEL_URL.search(line)
        if match:
            return match.group(0)
    raise TimeoutError("cloudflared did not provide a Quick Tunnel URL in time.")


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main():
    stopping = threading.Event()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        signal.signal(handled_signal, lambda *_: stopping.set())

    host = os.environ.get("SHELL_APP_HOST", "0.0.0.0")
    port = int(os.environ.get("SHELL_APP_PORT", "5000"))
    mail_settings = get_mail_settings()
    app_process = None
    tunnel_process = None

    try:
        logger.info("Starting Shell App on %s:%s", host, port)
        app_process = subprocess.Popen(
            [sys.executable, "app.py"],
            cwd=APP_DIR,
            env=child_environment(),
            preexec_fn=drop_child_privileges,
        )
        wait_for_health(app_process, host, port)

        tunnel_process, output_lines = start_tunnel()
        url = wait_for_tunnel_url(tunnel_process, output_lines)
        logger.info("Cloudflare Quick Tunnel is available at %s", url)
        send_tunnel_email(url, mail_settings)
        logger.info("Tunnel URL email sent to configured recipients.")

        while not stopping.wait(0.5):
            while True:
                try:
                    line = output_lines.get_nowait()
                except queue.Empty:
                    break
                logger.info("cloudflared: %s", line)
            if app_process.poll() is not None:
                raise RuntimeError(
                    f"Shell App exited with status {app_process.returncode}."
                )
            if tunnel_process.poll() is not None:
                raise RuntimeError(
                    f"cloudflared exited with status {tunnel_process.returncode}."
                )
    finally:
        stop_process(tunnel_process)
        stop_process(app_process)
        logger.info("Shell App service stopped.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Shell App service failed.")
        sys.exit(1)
