#!/usr/bin/env bash
set -euo pipefail

if ! command -v vercel >/dev/null 2>&1; then
  echo "Vercel CLI is not installed. Manual step: npm i -g vercel"
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  echo "Vercel CLI is not authenticated. Manual step: vercel login"
  exit 1
fi

vercel link --yes
vercel env add VITE_API_BASE_URL production <<< "https://openoverlayapi.skylarenns.com" || true
vercel env add VITE_WS_URL production <<< "wss://openoverlayapi.skylarenns.com" || true
vercel deploy --prod --yes
