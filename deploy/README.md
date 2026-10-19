# Deploy Shell App on Linux

This guide installs Shell App as a systemd service on a Debian/Ubuntu-style
Linux server. The service:

1. Starts the app on `0.0.0.0:5000`.
2. Waits for the local `/health` endpoint to respond.
3. Starts a Cloudflare Quick Tunnel to the app.
4. Emails the generated temporary URL to the configured recipients.

A new random `trycloudflare.com` URL is created and emailed each time the
service starts or restarts. Quick Tunnels are temporary and intended for
development and testing, not production.

## Important: the URL exposes an interactive shell

Anyone who obtains the URL can use the app's interactive terminal. The random
URL is difficult to guess, but it is **not authentication**. Terminal commands
run as the restricted `shell-app` Linux account, not as root. Use this only on a
practice server with no sensitive data or credentials accessible to that
account. Do not expose port 5000 directly to the internet.

In the server or cloud-provider firewall, allow only the inbound ports you
need for administration (for example, SSH) and block inbound TCP port `5000`.
The tunnel connects to the app over the server's loopback interface, so port
`5000` does not need to be open to the internet.

## 1. Install prerequisites

Use a Linux server with systemd, Python 3, Git, and sudo access:

```sh
# Refreshes APT's package index; it does not install or upgrade packages.
sudo apt update
# Installs Git, Python 3, venv support, and pip, which deployment needs.
sudo apt install -y git python3 python3-venv python3-pip
```

Install `cloudflared` using Cloudflare's current Linux installation
instructions: [Install cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
Verify it is available:

```sh
# Prints the installed cloudflared version; this also verifies it is on PATH.
cloudflared --version
```

## 2. Copy the application to `/opt/shell-app`

From a clone of this repository, run these commands at its root:

```sh
# Creates the root-owned installation directory with standard read/execute permissions.
sudo install -d -o root -g root -m 0755 /opt/shell-app
# Copies the app source and runtime assets from the current repository directory.
sudo cp -a app.py term.py session_store.py requirements.txt static templates utils scripts /opt/shell-app/
# Copies the systemd unit and deployment configuration examples.
sudo cp -a deploy /opt/shell-app/
# Ensures the app files are owned by root, not by the account that runs terminal commands.
sudo chown -R root:root /opt/shell-app
```

The service unit expects this exact installation path. Keep the source tree
root-owned so the account running terminal commands cannot modify the app.

## 3. Create the restricted service account and state directory

```sh
# Creates the unprivileged Linux account used to run the app's terminal commands.
# --system creates a service account; --user-group creates its matching group.
# The home directory is /var/lib/shell-app and Bash is used for interactive terminals.
sudo useradd --system --user-group --home-dir /var/lib/shell-app --shell /bin/bash shell-app
# Creates the state directory and gives only the service account access to it.
sudo install -d -o shell-app -g shell-app -m 0750 /var/lib/shell-app
```

If the `shell-app` account already exists, skip `useradd`.

## 4. Create the Python environment

```sh
# Creates an isolated Python environment alongside the deployed app.
sudo python3 -m venv /opt/shell-app/.venv
# Updates pip inside this virtual environment (not the system Python installation).
sudo /opt/shell-app/.venv/bin/pip install --upgrade pip
# Installs the Python dependencies declared by the app.
sudo /opt/shell-app/.venv/bin/pip install -r /opt/shell-app/requirements.txt
```

## 5. Configure email

Create the service environment file and edit it:

```sh
# Creates a root-only directory for the SMTP credentials and service configuration.
sudo install -d -o root -g root -m 0700 /etc/shell-app
# Copies the example settings into the protected service environment file.
sudo install -o root -g root -m 0600 \
  /opt/shell-app/deploy/shell-app.env.example \
  /etc/shell-app/shell-app.env
# Opens the settings file in an editor running as root; replace all placeholders.
sudoedit /etc/shell-app/shell-app.env
```

Set these values:

| Setting | Meaning |
| --- | --- |
| `SHELL_APP_SMTP_HOST` | SMTP server hostname |
| `SHELL_APP_SMTP_PORT` | SMTP port; usually `587` for STARTTLS or `465` for SSL |
| `SHELL_APP_SMTP_STARTTLS` | `true` for STARTTLS, otherwise `false` |
| `SHELL_APP_SMTP_SSL` | `true` for implicit SSL, otherwise `false`; do not enable both TLS modes |
| `SHELL_APP_SMTP_USERNAME` | SMTP login, if required |
| `SHELL_APP_SMTP_PASSWORD` | SMTP password or provider-specific SMTP key, if required |
| `SHELL_APP_SMTP_FROM` | Verified sender address |
| `SHELL_APP_SMTP_TO` | Recipient address(es), comma-separated |

The example uses Brevo SMTP settings. Replace the username and password with
the SMTP login and SMTP key from your mail provider, set an authorized sender,
and enter the recipient address or addresses. Do not use an account's normal
email password when the provider supports app-specific SMTP credentials.

Keep this file root-owned with mode `0600`. Do not commit it or put real
credentials in the repository. The systemd environment file uses systemd
syntax, not shell syntax; do not add `export` before variables.

## 6. Install and start the systemd service

```sh
# Installs the service unit where systemd looks for system-wide services.
sudo install -o root -g root -m 0644 \
  /opt/shell-app/deploy/systemd/shell-app.service \
  /etc/systemd/system/shell-app.service
# Makes systemd reload its unit files so it discovers shell-app.service.
sudo systemctl daemon-reload
# Enables the service at boot and starts it immediately.
sudo systemctl enable --now shell-app.service
```

Check the status and follow startup logs:

```sh
# Displays whether the service is active and recent status information.
sudo systemctl status shell-app.service
# Follows this service's journal output live; press Ctrl+C to stop following.
sudo journalctl -u shell-app.service -f
```

When healthy, the journal reports the Quick Tunnel URL and confirms that its
email was sent. Check the configured recipient's inbox and spam folder.

## Service details

- The app listens on `0.0.0.0:5000`; `cloudflared` connects to it over loopback.
- Set `SHELL_APP_HOST` or `SHELL_APP_PORT` in the environment file to override
  the defaults. Keep the app and tunnel port values consistent.
- Logs and the session database are stored under `/var/lib/shell-app`.
- The systemd supervisor runs as root to read the protected mail configuration.
  It removes SMTP variables and drops privileges before starting both the app
  and `cloudflared`. The app and commands typed into its terminal run as
  `shell-app`.
- A failed app startup, tunnel startup, or email send is reported in the system
  journal; systemd retries the service with a delay.

## Update the application

From the updated repository root, copy the source files into `/opt/shell-app`
while keeping that tree root-owned, then restart the service:

```sh
# Stops the app before replacing its files.
sudo systemctl stop shell-app.service
# Copies the updated application source and assets over the deployed version.
sudo cp -a app.py term.py session_store.py requirements.txt static templates utils scripts /opt/shell-app/
# Keeps the deployed files root-owned after copying.
sudo chown -R root:root /opt/shell-app
# Synchronizes installed Python packages with the updated requirements file.
sudo /opt/shell-app/.venv/bin/pip install -r /opt/shell-app/requirements.txt
# Starts the updated app and creates a new Quick Tunnel URL.
sudo systemctl start shell-app.service
# Prints the latest 100 service log lines without opening an interactive pager.
sudo journalctl -u shell-app.service -n 100 --no-pager
```

If dependencies change, installing them before the restart is also fine as long
as the service is stopped while files are being replaced.

## Troubleshooting

**Service repeatedly restarts**

```sh
# Shows recent service errors and startup output to help diagnose restarts.
sudo journalctl -u shell-app.service -n 200 --no-pager
```

Look for a missing SMTP setting, invalid SMTP credentials, a sender address
that the provider has not verified, a missing `cloudflared` executable, or
another process already using port 5000.

**Quick Tunnel does not start**

```sh
# Shows where the cloudflared executable is installed; the service needs it on PATH.
command -v cloudflared
# Verifies cloudflared can run and reports its version.
cloudflared --version
```

Install it system-wide so it is on the service's restricted `PATH`, or add an
absolute `CLOUDFLARED_BIN=/path/to/cloudflared` setting to the environment file.
Check that the server can make outbound network connections.

**No email arrives**

Read the service journal, verify SMTP host, port, and TLS settings, confirm the
credentials and verified sender with the mail provider, and check spam. The URL
is sent only after the tunnel starts successfully.

**The emailed URL stops working**

Quick Tunnel URLs are temporary. Restarting the service creates and emails a
new URL:

```sh
# Restarts the app and tunnel, causing a new temporary URL to be emailed.
sudo systemctl restart shell-app.service
# Follows startup logs so the new URL and email result can be observed.
sudo journalctl -u shell-app.service -f
```

## Stop or uninstall

Stop the service but leave it installed:

```sh
# Disables automatic start at boot and stops the currently running service.
sudo systemctl disable --now shell-app.service
```

To remove the service definition:

```sh
# Disables and stops the service before removing its systemd unit.
sudo systemctl disable --now shell-app.service
# Removes the installed unit file; this does not remove app files or data.
sudo rm /etc/systemd/system/shell-app.service
# Tells systemd to forget the unit that was just removed.
sudo systemctl daemon-reload
```

After stopping it, you may separately remove `/opt/shell-app`, the
`/etc/shell-app/shell-app.env` credentials file, and `/var/lib/shell-app`. The
last directory contains the app's logs and session database; copy anything you
want to keep before deleting it.
