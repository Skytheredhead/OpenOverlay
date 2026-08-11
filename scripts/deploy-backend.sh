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

if [[ ! "${BACKEND_PORT}" =~ ^[0-9]+$ ]] || (( 10#${BACKEND_PORT} < 1 || 10#${BACKEND_PORT} > 65535 )); then
  echo "BACKEND_PORT must be an integer from 1 to 65535."
  exit 1
fi
if [[ "${BACKEND_PORT}" == "8735" || "${BACKEND_PORT}" == "8736" ]]; then
  echo "BACKEND_PORT must not collide with gateway worker ports 8735 or 8736."
  exit 1
fi
if [[ ! "${SERVICE_NAME}" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "SERVICE_NAME contains unsupported characters."
  exit 1
fi
if [[ "${SSH_TARGET}" == -* ]] || [[ ! "${SSH_TARGET}" =~ ^[A-Za-z0-9_.@:-]+$ ]]; then
  echo "SSH_TARGET contains unsupported characters."
  exit 1
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "${SSH_TARGET}" "true" >/dev/null 2>&1; then
  echo "SSH authentication is unavailable for ${SSH_TARGET}."
  echo "Manual step: configure SSH key/auth for ${SSH_TARGET}, then rerun: SSH_TARGET=${SSH_TARGET} REMOTE_REPO_URL=${REPO_URL} bash scripts/deploy-backend.sh"
  exit 1
fi

printf -v REPO_URL_QUOTED '%q' "${REPO_URL}"
printf -v BACKEND_PORT_QUOTED '%q' "${BACKEND_PORT}"
printf -v SERVICE_NAME_QUOTED '%q' "${SERVICE_NAME}"
REMOTE_ENV="REPO_URL=${REPO_URL_QUOTED} BACKEND_PORT=${BACKEND_PORT_QUOTED} SERVICE_NAME=${SERVICE_NAME_QUOTED}"

ssh -t "${SSH_TARGET}" "${REMOTE_ENV} bash -s" <<'REMOTE'
set -euo pipefail

NODE_BIN="/usr/bin/node"
NPM_CLI="/usr/bin/npm"

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

node_runtime_is_supported() {
  [[ -x "${NODE_BIN}" && -r "${NPM_CLI}" ]] || return 1
  "${NODE_BIN}" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" || return 1
  local npm_version npm_major
  npm_version="$("${NODE_BIN}" "${NPM_CLI}" --version 2>/dev/null)" || return 1
  npm_major="${npm_version%%.*}"
  [[ "${npm_major}" =~ ^[0-9]+$ ]] && (( 10#${npm_major} >= 10 ))
}

install_node_if_needed() {
  if node_runtime_is_supported; then return; fi
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
  if ! node_runtime_is_supported; then
    echo "${NODE_BIN} must be Node.js 24 or newer with npm 10 or newer at ${NPM_CLI}."
    exit 1
  fi
}

run_npm() {
  "${NODE_BIN}" "${NPM_CLI}" "$@"
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
export PATH="/usr/bin:/bin"

BASE_DIR="$(resolve_base_dir)"
APP_DIR="${BASE_DIR}/OpenOverlay"
BACKUP_ROOT="/home/skylarenns/backups/openoverlay"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p -m 0700 "${BACKUP_ROOT}"
chmod 700 "${BACKUP_ROOT}"
if [[ -d "${APP_DIR}" || -d /var/lib/openoverlay ]]; then
  BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"
  mkdir -p -m 0700 "${BACKUP_DIR}"
  chmod 700 "${BACKUP_DIR}"
  if [[ -d "${APP_DIR}" ]]; then
    rsync -a \
      --exclude node_modules \
      --exclude dist \
      --exclude coverage \
      --exclude .vite \
      --exclude test-results \
      --exclude playwright-report \
      "${APP_DIR}/" "${BACKUP_DIR}/source/"
  fi
  if [[ -d /var/lib/openoverlay ]]; then
    sudo mkdir -p "${BACKUP_DIR}/var-lib-openoverlay"
    sudo rsync -a \
      --exclude openoverlay.sqlite \
      --exclude openoverlay.sqlite-wal \
      --exclude openoverlay.sqlite-shm \
      /var/lib/openoverlay/ "${BACKUP_DIR}/var-lib-openoverlay/"
    if [[ -f /var/lib/openoverlay/openoverlay.sqlite ]]; then
      sudo "${NODE_BIN}" --input-type=module - /var/lib/openoverlay/openoverlay.sqlite "${BACKUP_DIR}/var-lib-openoverlay/openoverlay.sqlite" <<'BACKUP_NODE'
import { DatabaseSync, backup } from "node:sqlite";

const sourcePath = process.argv[2];
const destinationPath = process.argv[3];
const source = new DatabaseSync(sourcePath, { readOnly: true });
await backup(source, destinationPath);
source.close();

const copy = new DatabaseSync(destinationPath, { readOnly: true });
const result = copy.prepare("PRAGMA integrity_check").get();
copy.close();
if (result?.integrity_check !== "ok") {
  throw new Error(`SQLite backup integrity check failed: ${String(result?.integrity_check || "unknown")}`);
}
BACKUP_NODE
    fi
    sudo chown -R skylarenns:skylarenns "${BACKUP_DIR}/var-lib-openoverlay" || true
  fi
  [[ ! -d "${APP_DIR}" ]] || test -d "${BACKUP_DIR}/source"
  [[ ! -f /var/lib/openoverlay/openoverlay.sqlite ]] || test -s "${BACKUP_DIR}/var-lib-openoverlay/openoverlay.sqlite"
  echo "Backup verified at ${BACKUP_DIR}"
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  if [[ -e "${APP_DIR}" ]]; then
    echo "Refusing to replace existing non-Git path: ${APP_DIR}"
    echo "Move or remove it explicitly after verifying the backup, then rerun deployment."
    exit 1
  fi
  git clone --branch main --single-branch -- "${REPO_URL}" "${APP_DIR}"
else
  if [[ -n "$(git -C "${APP_DIR}" status --porcelain --untracked-files=normal)" ]]; then
    echo "Refusing to deploy over a dirty server worktree: ${APP_DIR}"
    exit 1
  fi
  if [[ "$(git -C "${APP_DIR}" branch --show-current)" != "main" ]]; then
    echo "Refusing to deploy from a server worktree that is not on main."
    exit 1
  fi
  git -C "${APP_DIR}" fetch origin main
  git -C "${APP_DIR}" merge --ff-only origin/main
  if [[ "$(git -C "${APP_DIR}" rev-parse HEAD)" != "$(git -C "${APP_DIR}" rev-parse origin/main)" ]]; then
    echo "Server main is not exactly origin/main; refusing to deploy an unpushed local commit."
    exit 1
  fi
fi

if [[ "$(git -C "${APP_DIR}" branch --show-current)" != "main" ]] ||
   [[ "$(git -C "${APP_DIR}" rev-parse HEAD)" != "$(git -C "${APP_DIR}" rev-parse origin/main)" ]]; then
  echo "Server checkout is not exactly origin/main; refusing deployment."
  exit 1
fi

cd "${APP_DIR}"
APP_GIT_SHA="$(git rev-parse HEAD)"
APP_VERSION="$("${NODE_BIN}" -p "require('./package.json').version")"
run_npm ci
run_npm audit --audit-level=high
run_npm run typecheck
run_npm test
run_npm run build

sudo install -d -m 0700 -o skylarenns -g skylarenns /var/lib/openoverlay /var/lib/openoverlay/uploads /var/log/openoverlay "${APP_DIR}/releases"
sudo chown -R skylarenns:skylarenns /var/lib/openoverlay /var/log/openoverlay
sudo find /var/lib/openoverlay /var/log/openoverlay -type f -exec chmod 0600 {} +

if [[ ! -f /etc/openoverlaybackend.env ]]; then
  JWT_SECRET="$(openssl rand -hex 48)"
  ACTION_NOTE="generated"
  sudo tee /etc/openoverlaybackend.env >/dev/null <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=${BACKEND_PORT}
DATABASE_PATH=/var/lib/openoverlay/openoverlay.sqlite
UPLOAD_DIR=/var/lib/openoverlay/uploads
MEDIA_GLOBAL_MAX_BYTES=10737418240
STORAGE_MINIMUM_FREE_BYTES=1073741824
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

if ! sudo "${NODE_BIN}" scripts/validate-production-env.mjs /etc/openoverlaybackend.env "${BACKEND_PORT}"; then
  echo "Existing /etc/openoverlaybackend.env does not match the required production configuration."
  exit 1
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
Environment=PATH=/usr/bin:/bin
Environment=OPENOVERLAY_GIT_SHA=${APP_GIT_SHA}
Environment=OPENOVERLAY_VERSION=${APP_VERSION}
Environment=SELF_UPDATE_ENABLED=true
Environment=SELF_UPDATE_REPO_DIR=${APP_DIR}
Environment=SELF_UPDATE_REMOTE=origin
Environment=SELF_UPDATE_BRANCH=main
Environment=SELF_UPDATE_INTERVAL_MS=60000
Environment=GATEWAY_BACKEND_PORTS=8735,8736
Environment=GATEWAY_RELEASE_DIR=${APP_DIR}/releases
Environment=OPENOVERLAY_GATEWAY_ENTRYPOINT=1
ExecStart=${NODE_BIN} dist/gateway.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"
HEALTH_BODY="$(mktemp)"
GATEWAY_BODY="$(mktemp)"
trap 'rm -f "${HEALTH_BODY:-}" "${GATEWAY_BODY:-}"' EXIT
HEALTH_OK=false
for attempt in {1..15}; do
  if curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/health" >"${HEALTH_BODY}" &&
      curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/_openoverlay/gateway" >"${GATEWAY_BODY}"; then
    if "${NODE_BIN}" -e '
      const fs = require("node:fs");
      const health = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const gateway = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      const expected = process.argv[3];
      process.exit(
        health?.ok === true && health?.build?.commit === expected &&
        gateway?.ok === true && gateway?.gatewayBuild?.commit === expected && gateway?.activeBuild?.commit === expected
          ? 0
          : 1
      );
    ' "${HEALTH_BODY}" "${GATEWAY_BODY}" "${APP_GIT_SHA}"; then
      HEALTH_OK=true
      break
    fi
  fi
  sleep 2
done
if [[ "${HEALTH_OK}" != "true" ]]; then
  echo "OpenOverlay did not become healthy after restart."
  sudo systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,30p' || true
  sudo journalctl -u "${SERVICE_NAME}" --no-pager -n 80 || true
  exit 1
fi
cat "${HEALTH_BODY}"
cat "${GATEWAY_BODY}"
sudo systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,18p'
sudo journalctl -u "${SERVICE_NAME}" --no-pager -n 40

install_cloudflared_if_needed
if ! cloudflared tunnel list >/dev/null 2>&1; then
  echo "Run cloudflared tunnel login on the server, then rerun deployment."
  exit 1
fi

if ! cloudflared tunnel list | grep -q "openoverlay-api"; then
  cloudflared tunnel create openoverlay-api
fi

TUNNEL_ID="$(cloudflared tunnel list | awk '$2 == "openoverlay-api" {print $1; exit}')"
if [[ -z "${TUNNEL_ID}" ]]; then
  echo "Unable to resolve Cloudflare tunnel ID for openoverlay-api."
  exit 1
fi

CONFIG_FILE="/home/skylarenns/.cloudflared/openoverlay-api.yml"
CREDENTIALS_FILE="/home/skylarenns/.cloudflared/${TUNNEL_ID}.json"
if [[ ! -r "${CREDENTIALS_FILE}" ]]; then
  echo "Cloudflare tunnel credentials are not readable: ${CREDENTIALS_FILE}"
  exit 1
fi
mkdir -p /home/skylarenns/.cloudflared
cat > "${CONFIG_FILE}" <<YAML
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDENTIALS_FILE}
ingress:
  - hostname: openoverlayapi.skylarenns.com
    service: http://127.0.0.1:${BACKEND_PORT}
  - service: http_status:404
YAML
chmod 600 "${CONFIG_FILE}"

cloudflared tunnel --config "${CONFIG_FILE}" ingress validate
INGRESS_RULE="$(cloudflared tunnel --config "${CONFIG_FILE}" ingress rule "https://openoverlayapi.skylarenns.com/health")"
printf '%s\n' "${INGRESS_RULE}"
if ! grep -Fq "service: http://127.0.0.1:${BACKEND_PORT}" <<< "${INGRESS_RULE}"; then
  echo "Cloudflare ingress does not route openoverlayapi.skylarenns.com to the configured backend port."
  exit 1
fi

CLOUDFLARED_BIN="$(command -v cloudflared)"
TUNNEL_SERVICE="cloudflared-openoverlay-api"
sudo tee "/etc/systemd/system/${TUNNEL_SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=Cloudflare Tunnel for OpenOverlay API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=skylarenns
Group=skylarenns
ExecStart=${CLOUDFLARED_BIN} --no-autoupdate --config ${CONFIG_FILE} tunnel run
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "${TUNNEL_SERVICE}"
sudo systemctl restart "${TUNNEL_SERVICE}"
sudo systemctl --no-pager --full status "${TUNNEL_SERVICE}" | sed -n '1,18p'
if ! sudo systemctl is-active --quiet "${TUNNEL_SERVICE}"; then
  echo "Cloudflare tunnel service did not become active; DNS was not changed."
  exit 1
fi
cloudflared tunnel info openoverlay-api
cloudflared tunnel route dns --overwrite-dns "${TUNNEL_ID}" openoverlayapi.skylarenns.com
PUBLIC_HEALTH="$(curl -fsS --retry 8 --retry-delay 2 --retry-all-errors --connect-timeout 5 --max-time 20 "https://openoverlayapi.skylarenns.com/health?deploy=${APP_GIT_SHA}")"
PUBLIC_GATEWAY="$(curl -fsS --retry 8 --retry-delay 2 --retry-all-errors --connect-timeout 5 --max-time 20 "https://openoverlayapi.skylarenns.com/_openoverlay/gateway?deploy=${APP_GIT_SHA}")"
"${NODE_BIN}" -e '
  const health = JSON.parse(process.argv[1]);
  const gateway = JSON.parse(process.argv[2]);
  const expected = process.argv[3];
  if (health?.ok !== true || health?.build?.commit !== expected ||
      gateway?.ok !== true || gateway?.gatewayBuild?.commit !== expected || gateway?.activeBuild?.commit !== expected) {
    throw new Error("Public OpenOverlay health or gateway identity did not match the deployed commit");
  }
' "${PUBLIC_HEALTH}" "${PUBLIC_GATEWAY}" "${APP_GIT_SHA}"
printf '%s\n' "${PUBLIC_HEALTH}"
printf '%s\n' "${PUBLIC_GATEWAY}"
if [[ -n "${BACKUP_DIR:-}" ]]; then
  mapfile -t OLD_BACKUPS < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -print | sort -r | tail -n +6)
  if (( ${#OLD_BACKUPS[@]} > 0 )); then
    rm -rf -- "${OLD_BACKUPS[@]}"
  fi
fi
REMOTE
