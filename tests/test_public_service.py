import importlib.util
import queue
from pathlib import Path
from types import SimpleNamespace

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODULE_SPEC = importlib.util.spec_from_file_location(
    "public_service", PROJECT_ROOT / "scripts" / "public_service.py"
)
public_service = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(public_service)


def set_mail_environment(monkeypatch):
    for name, value in {
        "SHELL_APP_SMTP_HOST": "smtp.example.test",
        "SHELL_APP_SMTP_PORT": "587",
        "SHELL_APP_SMTP_STARTTLS": "true",
        "SHELL_APP_SMTP_SSL": "false",
        "SHELL_APP_SMTP_USERNAME": "smtp-user",
        "SHELL_APP_SMTP_PASSWORD": "smtp-secret",
        "SHELL_APP_SMTP_FROM": "sender@example.test",
        "SHELL_APP_SMTP_TO": "first@example.test, second@example.test",
    }.items():
        monkeypatch.setenv(name, value)


def test_mail_settings_reads_and_splits_recipient_configuration(monkeypatch):
    set_mail_environment(monkeypatch)

    settings = public_service.get_mail_settings()

    assert settings["host"] == "smtp.example.test"
    assert settings["port"] == 587
    assert settings["recipients"] == [
        "first@example.test",
        "second@example.test",
    ]
    assert settings["starttls"] is True
    assert settings["ssl"] is False


def test_mail_settings_requires_recipients(monkeypatch):
    set_mail_environment(monkeypatch)
    monkeypatch.setenv("SHELL_APP_SMTP_TO", "")

    with pytest.raises(RuntimeError, match="SHELL_APP_SMTP_TO"):
        public_service.get_mail_settings()


def test_mail_settings_rejects_conflicting_tls_modes(monkeypatch):
    set_mail_environment(monkeypatch)
    monkeypatch.setenv("SHELL_APP_SMTP_SSL", "true")

    with pytest.raises(RuntimeError, match="not both"):
        public_service.get_mail_settings()


def test_email_contains_quick_tunnel_url_and_uses_starttls(monkeypatch):
    set_mail_environment(monkeypatch)
    settings = public_service.get_mail_settings()
    sent = {}

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            sent["connection"] = (host, port, timeout)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def ehlo(self):
            sent["ehlo"] = True

        def starttls(self, context):
            sent["starttls"] = context

        def login(self, username, password):
            sent["login"] = (username, password)

        def send_message(self, message):
            sent["message"] = message

    monkeypatch.setattr(public_service.smtplib, "SMTP", FakeSMTP)
    public_service.send_tunnel_email(
        "https://random-name.trycloudflare.com",
        settings,
    )

    assert sent["connection"] == ("smtp.example.test", 587, 20)
    assert sent["login"] == ("smtp-user", "smtp-secret")
    assert "https://random-name.trycloudflare.com" in sent["message"].get_content()


def test_child_environment_does_not_inherit_smtp_credentials(monkeypatch):
    monkeypatch.setenv("SHELL_APP_SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("SHELL_APP_SMTP_USERNAME", "smtp-user")
    monkeypatch.setenv("SHELL_APP_HOST", "0.0.0.0")

    child_environment = public_service.child_environment()

    assert "SHELL_APP_SMTP_PASSWORD" not in child_environment
    assert "SHELL_APP_SMTP_USERNAME" not in child_environment
    assert child_environment["SHELL_APP_HOST"] == "0.0.0.0"


def test_tunnel_url_is_parsed_from_cloudflared_output(monkeypatch):
    monkeypatch.setattr(public_service, "TUNNEL_TIMEOUT", 1)
    output_lines = queue.Queue()
    output_lines.put("Your quick Tunnel is available at https://random-name.trycloudflare.com")

    url = public_service.wait_for_tunnel_url(
        SimpleNamespace(poll=lambda: None),
        output_lines,
    )

    assert url == "https://random-name.trycloudflare.com"
