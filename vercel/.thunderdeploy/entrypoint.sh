#!/bin/bash
set -e

cd /opt/thunderid

# ── Resolve public URL ────────────────────────────────────────────────────────
# Vercel injects VERCEL_PROJECT_PRODUCTION_URL for the stable production domain
# and VERCEL_URL for the per-deployment preview URL (both without a scheme).
# Users can also set PUBLIC_URL explicitly to override.
if [ -z "$PUBLIC_URL" ]; then
  if [ -n "$VERCEL_PROJECT_PRODUCTION_URL" ]; then
    PUBLIC_URL="https://$VERCEL_PROJECT_PRODUCTION_URL"
  elif [ -n "$VERCEL_URL" ]; then
    PUBLIC_URL="https://$VERCEL_URL"
  fi
fi

# ── Listen port ───────────────────────────────────────────────────────────────
# Vercel injects PORT into the container. Fall back to 8090 for local testing.
SERVER_PORT="${PORT:-8090}"

# ── Build URL components ──────────────────────────────────────────────────────
if [ -n "$PUBLIC_URL" ]; then
  PUBLIC_HOST=$(echo "$PUBLIC_URL" | sed 's|https://||; s|http://||; s|[:/].*||')
else
  PUBLIC_URL="http://localhost:$SERVER_PORT"
  PUBLIC_HOST="localhost"
fi

# ── Substitute placeholders in deployment.yaml ────────────────────────────────
DEPLOY_YAML="deployment.yaml"
sed -i "s|__PUBLIC_URL__|$PUBLIC_URL|g"   "$DEPLOY_YAML"
sed -i "s|__PUBLIC_HOST__|$PUBLIC_HOST|g" "$DEPLOY_YAML"
sed -i "s|__SERVER_PORT__|$SERVER_PORT|g" "$DEPLOY_YAML"

# ── Patch frontend config.js files ───────────────────────────────────────────
# The bundled React apps hard-code localhost in their public/config.js.
# When the public host is known, rewrite to the actual Vercel domain.
# port is set to 443 and http_only stays false because the browser always
# connects through Vercel's TLS termination — the container only needs
# http_only:true in deployment.yaml for internal server-side HTTP.
if [ "$PUBLIC_HOST" != "localhost" ]; then
  for CONFIG_FILE in apps/console/config.js apps/gate/config.js; do
    if [ -f "$CONFIG_FILE" ]; then
      sed -i "s|hostname: '[^']*'|hostname: '$PUBLIC_HOST'|g" "$CONFIG_FILE"
      sed -i "s|port: [0-9]*|port: 443|g"                      "$CONFIG_FILE"
    fi
  done
fi

# ── First-run setup ───────────────────────────────────────────────────────────
# setup.sh starts Thunder internally and hits it with curl to run bootstrap
# scripts. The server must bind to localhost for those curl calls to work —
# binding to 0.0.0.0 causes curl to hang on some container runtimes.
# Swap the hostname just for the setup phase, then restore 0.0.0.0 afterwards.
sed -i 's|hostname: "0.0.0.0"|hostname: "localhost"|g' "$DEPLOY_YAML"

ADMIN_USERNAME="${ADMIN_USERNAME:-admin}" \
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}" \
THUNDER_SKIP_SECURITY=true \
  bash setup.sh

sed -i 's|hostname: "localhost"|hostname: "0.0.0.0"|g' "$DEPLOY_YAML"

# Kill any processes setup.sh left running (setup starts Thunder internally).
lsof -ti tcp:"$SERVER_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti tcp:9090           2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# ── Start ThunderID ───────────────────────────────────────────────────────────
export BACKEND_PORT="$SERVER_PORT"
exec bash start.sh --without-consent
