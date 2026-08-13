#!/usr/bin/env bash
set -euo pipefail

SSH_TARGET="${SSH_TARGET:-deploy-openoverlay@shhh.skylarenns.com}"
DEPLOY_MODE="${DEPLOY_MODE:-deploy}"

if [[ "$DEPLOY_MODE" != "deploy" && "$DEPLOY_MODE" != "bootstrap" ]]; then
  printf 'DEPLOY_MODE must be deploy or bootstrap.\n' >&2
  exit 1
fi
if [[ "$SSH_TARGET" == -* || ! "$SSH_TARGET" =~ ^[A-Za-z0-9_.@:-]+$ ]]; then
  printf 'SSH_TARGET contains unsupported characters.\n' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  printf 'Refusing to package a dirty worktree.\n' >&2
  exit 1
fi

SHA="$(git rev-parse HEAD)"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { printf 'HEAD is not a full SHA.\n' >&2; exit 1; }
git merge-base --is-ancestor "$SHA" origin/main || { printf 'HEAD is not reachable from origin/main.\n' >&2; exit 1; }

TEMPORARY="$(mktemp -d)"
ARCHIVE="$TEMPORARY/openoverlay-$SHA.tar.gz"
trap 'rm -rf -- "$TEMPORARY"' EXIT
git archive --format=tar.gz --output="$ARCHIVE" "$SHA"
CHECKSUM="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"

printf 'Streaming immutable release %s (%s) to %s\n' "$SHA" "$CHECKSUM" "$SSH_TARGET"
ssh -o BatchMode=yes -o ClearAllForwardings=yes -o RequestTTY=no "$SSH_TARGET" "$DEPLOY_MODE $SHA $CHECKSUM" < "$ARCHIVE"
