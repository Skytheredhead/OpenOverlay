#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${REPO_ROOT}" ]]; then
  echo "Run this script from inside the OpenOverlay Git repository."
  exit 1
fi
cd "${REPO_ROOT}"

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Refusing a production frontend deployment from a dirty worktree."
  exit 1
fi

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
if [[ "$(git branch --show-current)" != "${DEPLOY_BRANCH}" ]]; then
  echo "Refusing a production frontend deployment from a branch other than ${DEPLOY_BRANCH}."
  exit 1
fi
git fetch --quiet origin "${DEPLOY_BRANCH}"
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/${DEPLOY_BRANCH}")" ]]; then
  echo "Refusing deployment: local ${DEPLOY_BRANCH} is not exactly origin/${DEPLOY_BRANCH}."
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  echo "Vercel CLI is not installed. Manual step: npm i -g vercel"
  exit 1
fi

npm ci
npm audit --audit-level=high
npm run validate:config
npm run typecheck
npm test

if ! vercel whoami >/dev/null 2>&1; then
  echo "Vercel CLI is not authenticated. Manual step: vercel login"
  exit 1
fi

VERCEL_PROJECT="${VERCEL_PROJECT:-open-overlay-frontend}"
VERCEL_TEAM="${VERCEL_TEAM:-}"
FRONTEND_URL="${OPENOVERLAY_FRONTEND_URL:-https://openoverlay.skylarenns.com}"
API_URL="${VITE_API_BASE_URL:-https://openoverlayapi.skylarenns.com}"
WEBSOCKET_URL="${VITE_WS_URL:-wss://openoverlayapi.skylarenns.com}"

vercel_scoped() {
  if [[ -n "${VERCEL_TEAM}" ]]; then
    vercel "$@" --scope "${VERCEL_TEAM}"
  else
    vercel "$@"
  fi
}

if [[ -n "${VERCEL_TEAM}" ]]; then
  vercel link --yes --project "${VERCEL_PROJECT}" --team "${VERCEL_TEAM}"
else
  vercel link --yes --project "${VERCEL_PROJECT}"
fi

printf '%s' "${API_URL}" | vercel_scoped env add VITE_API_BASE_URL production --force --no-sensitive --yes
printf '%s' "${WEBSOCKET_URL}" | vercel_scoped env add VITE_WS_URL production --force --no-sensitive --yes

vercel_scoped pull --yes --environment=production --project "${VERCEL_PROJECT}"
EXPECTED_COMMIT="$(git rev-parse HEAD)"
OPENOVERLAY_GIT_SHA="${EXPECTED_COMMIT}" VITE_API_BASE_URL="${API_URL}" VITE_WS_URL="${WEBSOCKET_URL}" \
  vercel_scoped build --prod --yes --project "${VERCEL_PROJECT}"

DEPLOY_OUTPUT="$(vercel_scoped deploy --prebuilt --prod --skip-domain --yes --project "${VERCEL_PROJECT}")"
DEPLOYMENT_URL="$(printf '%s\n' "${DEPLOY_OUTPUT}" | awk '/^https:\/\// { url=$0 } END { print url }')"
if [[ -z "${DEPLOYMENT_URL}" ]]; then
  echo "Vercel did not return a deployment URL."
  printf '%s\n' "${DEPLOY_OUTPUT}"
  exit 1
fi

vercel_scoped inspect "${DEPLOYMENT_URL}" --wait --timeout 3m
curl -fsS --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 5 --max-time 20 "${DEPLOYMENT_URL}/" >/dev/null
for CLIENT_ROUTE in /login /signup /dash /overlay/route-probe /overlay-test/route-probe; do
  curl -fsS --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 5 --max-time 20 "${DEPLOYMENT_URL}${CLIENT_ROUTE}" >/dev/null
done
MISSING_ASSET_STATUS="$(curl -sS --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 20 "${DEPLOYMENT_URL}/assets/openoverlay-missing-route-probe.js")"
if [[ "${MISSING_ASSET_STATUS}" != "404" ]]; then
  echo "Refusing promotion: a missing static asset returned HTTP ${MISSING_ASSET_STATUS}, expected 404."
  exit 1
fi
DEPLOYMENT_HEADERS="$(curl -fsSI --connect-timeout 5 --max-time 20 "${DEPLOYMENT_URL}/")"
for REQUIRED_HEADER in content-security-policy permissions-policy referrer-policy strict-transport-security x-content-type-options x-frame-options; do
  if ! grep -qi "^${REQUIRED_HEADER}:" <<<"${DEPLOYMENT_HEADERS}"; then
    echo "Refusing promotion: deployment is missing the ${REQUIRED_HEADER} response header."
    exit 1
  fi
done
if ! grep -Fqi "${API_URL}" <<<"${DEPLOYMENT_HEADERS}" || ! grep -Fqi "${WEBSOCKET_URL}" <<<"${DEPLOYMENT_HEADERS}"; then
  echo "Refusing promotion: the deployed CSP does not allow the configured API and WebSocket endpoints."
  exit 1
fi
BUILD_INFO="$(curl -fsS --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 5 --max-time 20 "${DEPLOYMENT_URL}/build-info.json")"
DEPLOYED_COMMIT="$(node -e 'const info=JSON.parse(process.argv[1]); process.stdout.write(info?.build?.commit || "")' "${BUILD_INFO}")"
if [[ "${DEPLOYED_COMMIT}" != "${EXPECTED_COMMIT}" ]]; then
  echo "Refusing promotion: deployment reports commit ${DEPLOYED_COMMIT:-unknown}; expected ${EXPECTED_COMMIT}."
  exit 1
fi
BACKEND_HEALTH="$(curl -fsS --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 5 --max-time 20 "${API_URL}/health")"
node -e '
  const frontend = JSON.parse(process.argv[1]);
  const backend = JSON.parse(process.argv[2]);
  const api = frontend?.build?.requiredApiVersion;
  const realtime = frontend?.build?.requiredRealtimeVersion;
  if (backend?.ok !== true || !backend?.compatibility?.api?.supported?.includes(api) ||
      !backend?.compatibility?.realtime?.supported?.includes(realtime)) {
    throw new Error(`Backend does not support candidate frontend API/realtime versions ${api || "unknown"}/${realtime || "unknown"}`);
  }
' "${BUILD_INFO}" "${BACKEND_HEALTH}"

vercel_scoped promote "${DEPLOYMENT_URL}" --yes
PROMOTED_BUILD_INFO="$(curl -fsS --retry 8 --retry-delay 2 --retry-all-errors --connect-timeout 5 --max-time 20 "${FRONTEND_URL}/build-info.json")"
PROMOTED_COMMIT="$(node -e 'const info=JSON.parse(process.argv[1]); process.stdout.write(info?.build?.commit || "")' "${PROMOTED_BUILD_INFO}")"
if [[ "${PROMOTED_COMMIT}" != "${EXPECTED_COMMIT}" ]]; then
  echo "Promotion verification failed: ${FRONTEND_URL} reports ${PROMOTED_COMMIT:-unknown}; expected ${EXPECTED_COMMIT}."
  exit 1
fi

echo "Promoted and verified ${DEPLOYMENT_URL} at ${EXPECTED_COMMIT}."
