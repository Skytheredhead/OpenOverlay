#!/usr/bin/env bash
set -euo pipefail

SSH_TARGET="${SSH_TARGET:-skylarenns@192.168.1.174}"
SERVICE_NAME="Openoverlaybackend"
BACKEND_PORT="${BACKEND_PORT:-8734}"
REPO_URL="${REMOTE_REPO_URL:-$(git config --get remote.origin.url || true)}"

if [[ -z "${REPO_URL}" ]]; then
  echo "No git remote is configured. Push the repo first or run with REMOTE_REPO_URL=<repo-url>."
  exit 1
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "${SSH_TARGET}" "true" >/dev/null 2>&1; then
  echo "SSH authentication is unavailable for ${SSH_TARGET}."
  echo "Manual step: configure SSH key/auth for ${SSH_TARGET}, then rerun: SSH_TARGET=${SSH_TARGET} REMOTE_REPO_URL=${REPO_URL} bash scripts/deploy-backend.sh"
  exit 1
fi

ssh -t "${SSH_TARGET}" "REPO_URL='${REPO_URL}' BACKEND_PORT='${BACKEND_PORT}' SERVICE_NAME='${SERVICE_NAME}' bash -s" <<'REMOTE'
set -euo pipefail

resolve_base_dir() {
  if [[ -d /home/skylarenns/Documents/GitHub ]]; then
    echo /home/skylarenns/Documents/GitHub
  elif [[ -d /home/skylarenns/documents/github ]]; then
    echo /home/skylarenns/documents/github
  else
    mkdir -p /home/skylarenns/Documents/GitHub
    echo /home/skylarenns/Documents/GitHub
  fi
}

install_node_if_needed() {
  if command -v node >/dev/null 2>&1 && node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"; then
    return
  fi
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
}

install_cloudflared_if_needed() {
  if command -v cloudflared >/dev/null 2>&1; then
    return
  fi
  sudo mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y cloudflared
}

sudo apt-get update
sudo apt-get install -y git rsync curl ca-certificates
install_node_if_needed

BASE_DIR="$(resolve_base_dir)"
APP_DIR="${BASE_DIR}/OpenOverlay"
BACKUP_ROOT="/home/skylarenns/backups/openoverlay"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "${BACKUP_ROOT}"
if [[ -d "${APP_DIR}" ]]; then
  BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"
  mkdir -p "${BACKUP_DIR}"
  rsync -a \
    --exclude node_modules \
    --exclude dist \
    --exclude coverage \
    --exclude .vite \
    --exclude test-results \
    --exclude playwright-report \
    "${APP_DIR}/" "${BACKUP_DIR}/source/"
  if [[ -d /var/lib/openoverlay ]]; then
    sudo rsync -a /var/lib/openoverlay/ "${BACKUP_DIR}/var-lib-openoverlay/"
    sudo chown -R skylarenns:skylarenns "${BACKUP_DIR}/var-lib-openoverlay" || true
  fi
  ls -dt "${BACKUP_ROOT}"/* | tail -n +6 | xargs -r rm -rf
  test -d "${BACKUP_DIR}/source"
  echo "Backup verified at ${BACKUP_DIR}"
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  rm -rf "${APP_DIR}"
  git clone "${REPO_URL}" "${APP_DIR}"
else
  git -C "${APP_DIR}" fetch origin main
  git -C "${APP_DIR}" reset --hard origin/main
fi

cd "${APP_DIR}"
npm ci
npm run build

sudo mkdir -p /var/lib/openoverlay/uploads /var/log/openoverlay /etc
sudo chown -R skylarenns:skylarenns /var/lib/openoverlay /var/log/openoverlay

if [[ ! -f /etc/openoverlaybackend.env ]]; then
  JWT_SECRET="$(openssl rand -hex 48)"
  ACTION_NOTE="generated"
  sudo tee /etc/openoverlaybackend.env >/dev/null <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=${BACKEND_PORT}
DATABASE_PATH=/var/lib/openoverlay/openoverlay.sqlite
UPLOAD_DIR=/var/lib/openoverlay/uploads
LOG_FILE=/var/log/openoverlay/backend.log
JWT_SECRET=${JWT_SECRET}
CORS_ORIGINS=https://openoverlay.skylarenns.com,http://localhost:5173,http://127.0.0.1:5173
FRONTEND_URL=https://openoverlay.skylarenns.com
COOKIE_DOMAIN=
ENV
  sudo chmod 600 /etc/openoverlaybackend.env
  echo "Created /etc/openoverlaybackend.env with ${ACTION_NOTE} secret."
else
  echo "Reusing existing /etc/openoverlaybackend.env."
fi

sudo tee /etc/systemd/system/${SERVICE_NAME}.service >/dev/null <<UNIT
[Unit]
Description=OpenOverlay backend API and WebSocket server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=skylarenns
Group=skylarenns
WorkingDirectory=${APP_DIR}/apps/backend
EnvironmentFile=/etc/openoverlaybackend.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"
sleep 2
curl -fsS "http://127.0.0.1:${BACKEND_PORT}/health"
sudo systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,18p'
sudo journalctl -u "${SERVICE_NAME}" --no-pager -n 40

install_cloudflared_if_needed
if ! cloudflared tunnel list >/dev/null 2>&1; then
  echo "Run cloudflared tunnel login on the server, then rerun deployment."
  exit 0
fi

if ! cloudflared tunnel list | grep -q "openoverlay-api"; then
  cloudflared tunnel create openoverlay-api
fi

cloudflared tunnel route dns openoverlay-api api.openoverlay.skylarenns.com || true
TUNNEL_ID="$(cloudflared tunnel list | awk '$2 == "openoverlay-api" {print $1; exit}')"
if [[ -z "${TUNNEL_ID}" ]]; then
  echo "Unable to resolve Cloudflare tunnel ID for openoverlay-api."
  exit 0
fi

CONFIG_FILE="/home/skylarenns/.cloudflared/openoverlay-api.yml"
mkdir -p /home/skylarenns/.cloudflared
cat > "${CONFIG_FILE}" <<YAML
tunnel: ${TUNNEL_ID}
credentials-file: /home/skylarenns/.cloudflared/${TUNNEL_ID}.json
ingress:
  - hostname: api.openoverlay.skylarenns.com
    service: http://127.0.0.1:${BACKEND_PORT}
  - service: http_status:404
YAML

if [[ -f /etc/systemd/system/cloudflared.service ]]; then
  sudo systemctl restart cloudflared
else
  sudo cloudflared --config "${CONFIG_FILE}" service install
fi
sudo systemctl enable cloudflared
sudo systemctl restart cloudflared
cloudflared tunnel info openoverlay-api || true
curl -fsS https://api.openoverlay.skylarenns.com/health || true
REMOTE
