#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_URL="https://github.com/Wansh619/Shell-App.git"
readonly APP_DIR="/opt/shell-app"
readonly STATE_DIR="/var/lib/shell-app"
readonly CONFIG_DIR="/etc/shell-app"
readonly CONFIG_FILE="${CONFIG_DIR}/sys.config"
readonly ENV_FILE="${CONFIG_DIR}/shell-app.env"
readonly SERVICE_USER="hat"
readonly CLOUDFLARE_KEYRING="/usr/share/keyrings/cloudflare-main.gpg"
readonly CLOUDFLARE_REPOSITORY="/etc/apt/sources.list.d/cloudflared.list"

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
    fail "Run this installer with sudo: sudo bash deploy/setup.sh"
fi

command -v systemctl >/dev/null || fail "systemd is required."
command -v apt-get >/dev/null || fail "This installer requires Debian or Ubuntu with apt-get."

printf '[1/5] Installing prerequisite tools and libraries...\n'
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl git gnupg python3 python3-pip python3-venv

command -v git >/dev/null || fail "Git installation failed."
python3 -m venv --help >/dev/null 2>&1 || fail "Python venv support is required."
if ! command -v cloudflared >/dev/null; then
    install -d -o root -g root -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
        -o "${CLOUDFLARE_KEYRING}"
    chmod 0644 "${CLOUDFLARE_KEYRING}"
    printf '%s\n' \
        'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
        > "${CLOUDFLARE_REPOSITORY}"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y cloudflared
fi
command -v cloudflared >/dev/null || fail "cloudflared installation failed."

printf '[2/5] Cloning or updating the main branch...\n'
printf 'Public repository: %s (no GitHub login required)\n' "${REPOSITORY_URL}"
if [[ -e "${APP_DIR}" ]]; then
    [[ -d "${APP_DIR}/.git" ]] || fail \
        "${APP_DIR} exists but is not a Git checkout; move it aside before installing."
    current_branch=$(git -C "${APP_DIR}" branch --show-current)
    [[ "${current_branch}" == "main" ]] || fail \
        "The existing checkout is on '${current_branch}', not 'main'; switch it to main first."
    [[ -z "$(git -C "${APP_DIR}" status --porcelain --untracked-files=all \
        -- . ':(exclude).venv' ':(exclude)deploy/sys.config')" ]] || fail \
        "The existing checkout has local changes; commit or save them before updating."
    git -C "${APP_DIR}" fetch --prune origin main
    git -C "${APP_DIR}" merge --ff-only origin/main
else
    git clone --branch main --depth 1 "${REPOSITORY_URL}" "${APP_DIR}"
fi
chown -R root:root "${APP_DIR}"

if ! getent passwd "${SERVICE_USER}" >/dev/null; then
    useradd --system --user-group --home-dir "${STATE_DIR}" --create-home \
        --shell /bin/bash "${SERVICE_USER}"
fi
getent group "${SERVICE_USER}" >/dev/null \
    || fail "The existing ${SERVICE_USER} account has no matching group."
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${STATE_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 /var/log/shell-app

printf '[3/5] Writing app config and protected deployment settings...\n'
install -d -o root -g root -m 0700 "${CONFIG_DIR}"
if [[ -e "${CONFIG_FILE}" || -L "${CONFIG_FILE}" ]]; then
    [[ -f "${CONFIG_FILE}" && ! -L "${CONFIG_FILE}" ]] || fail \
        "${CONFIG_FILE} exists but is not a regular file; refusing to replace it."
else
    printf '\nApp configuration reference: %s\n' \
        "${APP_DIR}/deploy/sys.config.example"
    read -r -p "App bind host [0.0.0.0]: " app_host
    app_host=${app_host:-0.0.0.0}
    read -r -p "App port [5000]: " app_port
    app_port=${app_port:-5000}
    [[ "${app_port}" =~ ^[0-9]+$ ]] && (( app_port >= 1 && app_port <= 65535 )) \
        || fail "App port must be a number from 1 to 65535."
    umask 077
    cat > "${CONFIG_FILE}" <<EOF
[app]
host = ${app_host}
port = ${app_port}
log = /var/log/shell-app
session_db = ${STATE_DIR}/terminal_sessions.db
EOF
    chown root:root "${CONFIG_FILE}"
    chmod 0600 "${CONFIG_FILE}"
fi

quote_systemd_value() {
    local value=$1
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    printf '"%s"' "${value}"
}

write_setting() {
    printf '%s=%s\n' "$1" "$(quote_systemd_value "$2")" >> "${ENV_FILE}"
}

if [[ -e "${ENV_FILE}" || -L "${ENV_FILE}" ]]; then
    [[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] || fail \
        "${ENV_FILE} exists but is not a regular file; refusing to replace it."
else
    printf '\nGmail SMTP is used to send the tunnel URL.\n'
    printf '  SMTP host: smtp.gmail.com (Google mail server; not a host/domain you need to buy)\n'
    printf '  SMTP port: 587 with STARTTLS\n'
    printf '  App password help: https://support.google.com/accounts/answer/185833\n'
    printf 'App passwords require 2-Step Verification. Enter a Google app password, not your normal account password.\n\n'

    read -r -p "Gmail account email address (used as sender): " smtp_username
    [[ "${smtp_username}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] \
        || fail "Enter a valid Gmail address."
    read -r -s -p "Google app password: " smtp_password
    printf '\n'
    smtp_password=${smtp_password//[[:space:]]/}
    [[ -n "${smtp_password}" ]] || fail "Google app password cannot be empty."
    read -r -p "Recipient email address(es), comma-separated: " smtp_recipients
    [[ -n "${smtp_recipients//[[:space:]]/}" ]] || fail "At least one recipient is required."

    umask 077
    : > "${ENV_FILE}"
    write_setting SHELL_APP_CONFIG_FILE "${CONFIG_FILE}"
    write_setting SHELL_APP_RUN_USER "${SERVICE_USER}"
    write_setting SHELL_APP_SMTP_HOST "smtp.gmail.com"
    write_setting SHELL_APP_SMTP_PORT "587"
    write_setting SHELL_APP_SMTP_STARTTLS "true"
    write_setting SHELL_APP_SMTP_SSL "false"
    write_setting SHELL_APP_SMTP_USERNAME "${smtp_username}"
    write_setting SHELL_APP_SMTP_PASSWORD "${smtp_password}"
    write_setting SHELL_APP_SMTP_FROM "${smtp_username}"
    write_setting SHELL_APP_SMTP_TO "${smtp_recipients}"
    chown root:root "${ENV_FILE}"
    chmod 0600 "${ENV_FILE}"
fi
if [[ -L "${APP_DIR}/deploy/sys.config" ]]; then
    [[ "$(readlink -f "${APP_DIR}/deploy/sys.config")" == "$(readlink -f "${CONFIG_FILE}")" ]] \
        || fail "${APP_DIR}/deploy/sys.config points somewhere unexpected."
elif [[ -e "${APP_DIR}/deploy/sys.config" ]]; then
    fail "${APP_DIR}/deploy/sys.config exists and is not the expected config symlink."
else
    ln -s "${CONFIG_FILE}" "${APP_DIR}/deploy/sys.config"
fi
umask 022

printf '[4/5] Creating the Python virtual environment and installing requirements.txt...\n'
python3 -m venv "${APP_DIR}/.venv"
"${APP_DIR}/.venv/bin/pip" install -r "${APP_DIR}/requirements.txt"

printf '[5/5] Installing and starting app.py, the Cloudflare tunnel, and email service...\n'
install -o root -g root -m 0644 "${APP_DIR}/deploy/systemd/shell-app.service" \
    /etc/systemd/system/shell-app.service
systemctl daemon-reload
systemctl enable shell-app.service
systemctl restart shell-app.service

printf '\nDeployment is installed. Check startup and email delivery with:\n'
printf '  sudo systemctl status shell-app.service\n'
printf '  sudo journalctl -u shell-app.service -f\n'
