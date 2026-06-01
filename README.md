# OpenOverlay

OpenOverlay is a production-oriented livestream graphics app intended to replace Singular Live-style soccer overlays first, while also supporting church / ProPresenter-like presentation presets and future livestream graphics.

The frontend is a React + Vite app for Vercel. The backend is a Node.js + TypeScript API/WebSocket server with SQLite persistence, disk media uploads, email/password auth, and Socket.IO realtime overlay updates.

## URLs

- Frontend: `https://openoverlay.skylarenns.com`
- Backend API/WebSocket: `https://openoverlayapi.skylarenns.com`
- Admin dashboard: `https://openoverlay.skylarenns.com/dash`
- Login: `https://openoverlay.skylarenns.com/login`
- OBS browser source: `https://openoverlay.skylarenns.com/overlay/:overlayId`
- Overlay test page: `https://openoverlay.skylarenns.com/overlay-test/:overlayId`

## Stack

- Monorepo with npm workspaces
- Frontend: React, Vite, TypeScript, Socket.IO client, Playwright
- Backend: Express, Socket.IO, TypeScript, Node `node:sqlite`
- Auth: email/password with bcrypt password hashing and signed HTTP-only session cookies
- Storage: SQLite database plus media files on server disk
- Tests: Vitest, Supertest, Playwright

Node `>=24` is required because the backend uses `node:sqlite`.

## Local Development

```bash
npm install
npm run build --workspace @openoverlay/shared
cp .env.example .env
npm run dev
```

Frontend runs at `http://127.0.0.1:5173`. Backend runs at `http://127.0.0.1:8734`.

Useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e --workspace @openoverlay/frontend
npm run check:deployments
npm run seed
```

The demo seed creates `demo@openoverlay.local` with password `openoverlay-demo` for local development only. In production, set `DEMO_PASSWORD` explicitly before seeding.

## Environment Variables

Backend:

- `NODE_ENV`
- `HOST`, default `127.0.0.1`
- `PORT`, default `8734`
- `DATABASE_PATH`
- `UPLOAD_DIR`
- `LOG_FILE`
- `JWT_SECRET`
- `CORS_ORIGINS`
- `FRONTEND_URL`
- `COOKIE_DOMAIN`
- `SELF_UPDATE_ENABLED`, default disabled
- `SELF_UPDATE_INTERVAL_MS`, default `60000`
- `SELF_UPDATE_REPO_DIR`, default repo root
- `SELF_UPDATE_REMOTE`, default `origin`
- `SELF_UPDATE_BRANCH`, default `main`
- `GATEWAY_BACKEND_PORTS`, default `8735,8736`
- `GATEWAY_RELEASE_DIR`

Frontend:

- `VITE_API_BASE_URL`
- `VITE_WS_URL`

Use `.env.example` as the placeholder reference. Do not commit real secrets.

## Core Features

- User-isolated accounts and private admin routes
- Public unguessable overlay URLs
- Soccer presets with scorebug, clock, scores, teams, rosters, stats bug, temporary graphics, and draggable placement
- Clock state stored server-side with timestamp/offset logic for accurate resume after admin closes
- Church presets with text/image slides, countdown, lower-third/fullscreen model, and shared preview renderer
- Media library with drag/drop upload for PNG, JPG/JPEG, WebP, and sanitized SVG
- Live WebSocket updates from admin to overlay
- OBS-friendly transparent full-page renderer
- Overlay test page with checker background and safe area
- Undo/redo shortcuts in editor with `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z`
- Stream Deck-compatible HTTP action endpoints
- Preset and team sharing by duplicating into recipient accounts
- Debug event log for actions and state changes

## OBS Setup

1. Add a Browser Source in OBS.
2. Use `https://openoverlay.skylarenns.com/overlay/:overlayId`.
3. Set source width/height to the stream resolution, for example `1920x1080`.
4. Keep the page background transparent. If needed, enable transparent background/custom CSS in OBS.
5. Refresh browser cache if an old frontend build is stuck.

OBS should only need one Browser Source per preset.

## Stream Deck HTTP Actions

Create an action key from the preset editor. Store it securely. Then use a Stream Deck Web Request plugin:

```bash
curl -X POST \
  -H "x-openoverlay-action-key: ACTION_KEY" \
  https://openoverlayapi.skylarenns.com/api/v1/presets/PRESET_ID/actions/home-score-plus
```

Common endpoints:

- `POST /api/v1/presets/:id/actions/home-score-plus`
- `POST /api/v1/presets/:id/actions/home-score-minus`
- `POST /api/v1/presets/:id/actions/away-score-plus`
- `POST /api/v1/presets/:id/actions/away-score-minus`
- `POST /api/v1/presets/:id/actions/clock-toggle`
- `POST /api/v1/presets/:id/actions/clock-reset`
- `POST /api/v1/presets/:id/actions/trigger-goal`
- `POST /api/v1/presets/:id/actions/trigger-yellow-card`
- `POST /api/v1/presets/:id/actions/trigger-red-card`
- `POST /api/v1/presets/:id/actions/trigger-substitution`
- `POST /api/v1/presets/:id/actions/trigger-halftime`
- `POST /api/v1/presets/:id/actions/trigger-countdown`
- `POST /api/v1/presets/:id/actions/clear`

Actions accept either a logged-in session cookie or `x-openoverlay-action-key`. Unversioned `/api/...` routes remain a v1 compatibility alias.

## Compatibility Versions

Agents making coordinated frontend/backend contract changes must check `packages/shared/src/compatibility.ts`. Bump `OPENOVERLAY_API_VERSION` for breaking REST path, request, response, auth, or media URL changes. Bump `OPENOVERLAY_REALTIME_VERSION` for incompatible Socket.IO auth/query, room, event, or payload changes. Do not bump for additive backwards-compatible fields.

When bumping either version, update backend `/health`, frontend build metadata, versioned API route tests, realtime tests, and deployment/gateway compatibility tests in the same change.

## Backend Deployment

The backend deployment script uses SSH key/config/agent auth only. It never reads local Desktop password files.

```bash
REMOTE_REPO_URL=git@github.com:OWNER/OpenOverlay.git bash scripts/deploy-backend.sh
```

It deploys to the first available base path:

1. `/home/skylarenns/Documents/GitHub`
2. `/home/skylarenns/documents/github`
3. Creates `/home/skylarenns/Documents/GitHub`

Final app path: `.../OpenOverlay`.

The script:

- Installs Git and Node.js 24 if needed
- Backs up existing source and `/var/lib/openoverlay` to `/home/skylarenns/backups/openoverlay/YYYYMMDD-HHMMSS`
- Keeps latest 5 backups
- Excludes `node_modules`, `dist`, coverage, and build/test caches
- Runs `npm ci` and `npm run build`
- Creates `/etc/openoverlaybackend.env` with generated secrets if missing
- Creates/enables/restarts `Openoverlaybackend.service`, which runs the local gateway on port `8734`
- Verifies `curl http://127.0.0.1:8734/health`
- Attempts Cloudflare Tunnel setup if `cloudflared` is authenticated

Manual service checks:

```bash
curl http://127.0.0.1:8734/health
sudo systemctl status Openoverlaybackend
sudo journalctl -u Openoverlaybackend --no-pager -n 100
tail -n 100 /var/log/openoverlay/backend.log
```

The frontend publishes `/build-info.json` and the backend includes build metadata in `/health`. The app warns when those deployed commits differ, and `npm run check:deployments` can be used to verify production from the command line. Override the checked URLs with `FRONTEND_URL=` and `BACKEND_URL=` when needed.

The backend systemd deployment also enables a gateway-managed self-updater. Once a minute, the gateway fetches `origin/main`; when a fast-forward update is available and the server checkout is clean, it pulls, runs `npm ci`, rebuilds `@openoverlay/shared` and `@openoverlay/backend`, starts a candidate backend on an internal slot port, verifies `/health`, then promotes it for new HTTP/WebSocket traffic. The previous backend drains existing WebSocket clients and is stopped after the count reaches zero. Only one active slot and one draining slot are allowed, so further updates wait instead of spawning unbounded backend processes.

## Cloudflare Tunnel

Desired hostname: `openoverlayapi.skylarenns.com`

Desired local service:

```text
http://127.0.0.1:8734
```

If the deployment script reports Cloudflare auth is missing, run this on the server:

```bash
cloudflared tunnel login
```

Then rerun:

```bash
REMOTE_REPO_URL=git@github.com:OWNER/OpenOverlay.git bash scripts/deploy-backend.sh
```

Verify:

```bash
cloudflared tunnel list
cloudflared tunnel info openoverlay-api
curl https://openoverlayapi.skylarenns.com/health
```

## Vercel Frontend Deployment

The frontend app lives in `apps/frontend`.

Required production env vars:

```text
VITE_API_BASE_URL=https://openoverlayapi.skylarenns.com
VITE_WS_URL=wss://openoverlayapi.skylarenns.com
```

If Vercel CLI is authenticated:

```bash
bash scripts/deploy-frontend-vercel.sh
```

Manual Vercel setup:

```bash
cd apps/frontend
vercel login
vercel link
vercel env add VITE_API_BASE_URL production
vercel env add VITE_WS_URL production
vercel deploy --prod
```

Set the production domain to `openoverlay.skylarenns.com` in Vercel.

## Troubleshooting

Overlay not updating:

- Confirm the admin status shows WebSocket connected.
- Open `/overlay-test/:overlayId` and check the connection status.
- Check `VITE_WS_URL` and backend `CORS_ORIGINS`.
- Verify the backend health endpoint.

WebSocket disconnected:

- Check Cloudflare Tunnel status.
- Check `journalctl -u Openoverlaybackend --no-pager -n 100`.
- Confirm the frontend is using `wss://openoverlayapi.skylarenns.com`.

CORS errors:

- Add the exact frontend origin to `CORS_ORIGINS` in `/etc/openoverlaybackend.env`.
- Restart `Openoverlaybackend`.

Cloudflare tunnel down:

```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared --no-pager -n 100
cloudflared tunnel list
```

Vercel env mismatch:

- Confirm `VITE_API_BASE_URL` and `VITE_WS_URL` are set for production.
- Redeploy after changing env vars.

## Repository Layout

```text
apps/frontend       React + Vite dashboard and overlay renderer
apps/backend        Express + Socket.IO API server
packages/shared     Shared state types, defaults, clock logic
scripts             Deployment helpers
```
