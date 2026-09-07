#!/usr/bin/env bash
set -euo pipefail

SSH_TARGET="${SSH_TARGET:-shhh.skylarenns.com}"
REMOTE_REPO_DIR="${REMOTE_REPO_DIR:-/home/skylarenns/Documents/GitHub/OpenOverlay}"
EXPECTED_SHA="${DEPLOY_SHA:-}"

if [[ "$SSH_TARGET" == -* || ! "$SSH_TARGET" =~ ^[A-Za-z0-9_.@:-]+$ ]]; then
  printf 'SSH_TARGET contains unsupported characters.\n' >&2
  exit 1
fi
if [[ ! "$REMOTE_REPO_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  printf 'REMOTE_REPO_DIR contains unsupported characters.\n' >&2
  exit 1
fi

if [[ -z "$EXPECTED_SHA" ]]; then
  EXPECTED_SHA="$(git ls-remote origin refs/heads/main | awk 'NR == 1 { print $1 }')"
fi
if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Could not resolve a full deployment SHA from origin/main.\n' >&2
  exit 1
fi

printf 'Deploying OpenOverlay backend %s to %s:%s\n' "$EXPECTED_SHA" "$SSH_TARGET" "$REMOTE_REPO_DIR"
ssh -o BatchMode=yes -o ClearAllForwardings=yes -o RequestTTY=no "$SSH_TARGET" bash -s -- "$EXPECTED_SHA" "$REMOTE_REPO_DIR" <<'REMOTE_DEPLOY'
set -euo pipefail

expected_sha="$1"
repo_dir="$2"

fail() {
  printf 'deploy-backend: %s\n' "$*" >&2
  exit 1
}

build_checkout() (
  set -e
  target_sha="$1"
  git switch --detach "$target_sha"
  npm ci --include=dev
  npm run build --workspace @openoverlay/shared
  npm run build --workspace @openoverlay/backend
)

restart_backend() {
  local pid
  pid="$(systemctl show -p MainPID --value Openoverlaybackend.service)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )); then
    kill -TERM "$pid"
  fi
}

wait_for_commit() {
  local expected="$1" attempt body commit
  for attempt in {1..40}; do
    body="$(curl -fsS --connect-timeout 2 --max-time 4 http://127.0.0.1:8734/health 2>/dev/null || true)"
    commit="$(BODY="$body" /usr/bin/node -e 'try { process.stdout.write(JSON.parse(process.env.BODY).build?.commit || "") } catch {}')"
    if [[ "$commit" == "$expected" ]]; then
      printf '%s\n' "$body"
      return 0
    fi
    sleep 1
  done
  return 1
}

cd "$repo_dir"
[[ -d .git ]] || fail "remote repository is missing: $repo_dir"
git diff --quiet && git diff --cached --quiet || fail "remote checkout has tracked changes"

previous_sha="$(git rev-parse HEAD)"
git fetch origin main
remote_sha="$(git rev-parse origin/main)"
[[ "$remote_sha" == "$expected_sha" ]] || fail "origin/main moved during deployment"

if ! build_checkout "$expected_sha"; then
  printf 'Build failed; restoring checkout %s.\n' "$previous_sha" >&2
  build_checkout "$previous_sha" || fail "build failed and previous checkout could not be restored"
  exit 1
fi

restart_backend
if wait_for_commit "$expected_sha"; then
  printf 'Backend deployment complete: %s\n' "$expected_sha"
  exit 0
fi

printf 'New backend failed health; rolling back to %s.\n' "$previous_sha" >&2
build_checkout "$previous_sha" || fail "new backend failed and rollback build failed"
restart_backend
wait_for_commit "$previous_sha" || fail "rollback did not recover backend health"
fail "new backend failed health and was rolled back"
REMOTE_DEPLOY
