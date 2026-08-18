#!/bin/bash
set -e

echo "=================================================="
echo " Starting Proxyrack PoP Client (Docker)"
echo "=================================================="

DATA_DIR="/app/data"
mkdir -p "$DATA_DIR"
UUID_FILE="$DATA_DIR/uuid.txt"
API_CFG_FILE="$DATA_DIR/api.cfg"

# 1. UUID Resolution (Use provided env, or persisted file, or generate a new random UUID)
if [ -z "$UUID" ]; then
  if [ -f "$UUID_FILE" ]; then
    UUID=$(cat "$UUID_FILE")
    echo "[Proxyrack] Using persisted UUID: $UUID"
  else
    if [ -f /proc/sys/kernel/random/uuid ]; then
      UUID=$(cat /proc/sys/kernel/random/uuid)
    else
      UUID=$(node -e "console.log(require('crypto').randomUUID())")
    fi
    echo "$UUID" > "$UUID_FILE"
    echo "[Proxyrack] Generated new persistent UUID: $UUID"
  fi
else
  echo "[Proxyrack] Using configured UUID from environment: $UUID"
  echo "$UUID" > "$UUID_FILE"
fi

export UUID

# 2. Test outbound connectivity through ISP Gateway SOCKS5 transparent tunnel
echo "[Proxyrack] Verifying connection to point-of-presence.sock.sh:443..."
CONNECTED=0
for i in $(seq 1 15); do
  if nc -z -w 3 point-of-presence.sock.sh 443 2>/dev/null; then
    echo "[Proxyrack] Successfully connected to Proxyrack PoP Gateway!"
    CONNECTED=1
    break
  fi
  echo "[Proxyrack] Waiting for residential tunnel to become ready (attempt $i/15)..."
  sleep 2
done

# 3. Download or update supervisor script
echo "[Proxyrack] Updating Proxyrack supervisor script..."
wget -q https://app-updates.sock.sh/peerclient/script/script.js -O /app/script.js || true

VERSION=$(curl -s https://app-updates.sock.sh/peerclient/script/version.txt 2>/dev/null || echo "56")
echo "[Proxyrack] Launching Node.js PoP supervisor (Version: $VERSION)..."

node /app/script.js \
  --homeIp point-of-presence.sock.sh \
  --homePort 443 \
  --id "$UUID" \
  --version "$VERSION" \
  --clientKey proxyrack-pop-client \
  --clientType PoP &
PROXYRACK_PID=$!

# 4. Optional Device Registration with API Key
add_device() {
  local api_key="$1"
  local device_name="${DEVICE_NAME:-Device-$UUID}"
  
  echo "[Proxyrack] Registering device '$device_name' on dashboard with API key..."
  while true; do
    local response
    response=$(curl -s -X POST https://peer.proxyrack.com/api/device/add \
      -H "Api-Key: ${api_key}" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json' \
      -d "{\"device_id\":\"${UUID}\",\"device_name\":\"${device_name}\"}" || echo '{"status":"error"}')
    
    if echo "$response" | grep -q '"status":\s*"error"'; then
      echo "[Proxyrack] Device registration pending, retrying in 30s..."
      sleep 30
    else
      echo "[Proxyrack] Device added successfully to your Proxyrack dashboard!"
      touch "$API_CFG_FILE"
      break
    fi
  done
}

if [ -n "$API_KEY" ]; then
  if [ ! -f "$API_CFG_FILE" ]; then
    add_device "$API_KEY" &
  else
    echo "[Proxyrack] Device was already registered in previous session."
  fi
else
  echo "[Proxyrack] No API_KEY configured. Device will operate anonymously with UUID $UUID."
fi

# Keep container alive and handle termination signals
cleanup() {
  echo "[Proxyrack] Stopping..."
  kill -TERM "$PROXYRACK_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

while true; do
  sleep 2
done
