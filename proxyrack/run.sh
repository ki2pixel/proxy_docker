#!/bin/bash
set -e

echo "=================================================="
echo " Starting Proxyrack PoP Client (Docker)"
echo "=================================================="

DATA_DIR="/app/data"
mkdir -p "$DATA_DIR"
chmod 777 "$DATA_DIR" 2>/dev/null || true
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
for i in $(seq 1 15); do
  if nc -z -w 3 point-of-presence.sock.sh 443 2>/dev/null; then
    echo "[Proxyrack] Successfully connected to Proxyrack PoP Gateway!"
    break
  fi
  echo "[Proxyrack] Waiting for residential tunnel to become ready (attempt $i/15)..."
  sleep 2
done

# 3. Download or update supervisor script (avec timeout et vérification non-vide)
echo "[Proxyrack] Updating Proxyrack supervisor script..."
if wget -q --timeout=30 --tries=1 https://app-updates.sock.sh/peerclient/script/script.js -O /app/script.js.new 2>/dev/null \
   && [ -s /app/script.js.new ]; then
  mv /app/script.js.new /app/script.js
  echo "[Proxyrack] Supervisor script updated."
else
  rm -f /app/script.js.new
  if [ ! -s /app/script.js ]; then
    echo "[-] [Proxyrack] Échec du téléchargement du superviseur et aucun script en cache."
    echo "[-] [Proxyrack] Nouvelle tentative dans 30s (le conteneur se relancera via restart policy)..."
    sleep 30
    exit 1
  fi
  echo "[Proxyrack] Téléchargement impossible, utilisation du script en cache."
fi

VERSION=$(curl -s --max-time 30 --connect-timeout 10 https://app-updates.sock.sh/peerclient/script/version.txt 2>/dev/null || echo "56")
echo "[Proxyrack] Launching Node.js PoP supervisor (Version: $VERSION)..."

node /app/script.js \
  --homeIp point-of-presence.sock.sh \
  --homePort 443 \
  --id "$UUID" \
  --version "$VERSION" \
  --clientKey proxyrack-pop-client \
  --clientType PoP &
PROXYRACK_PID=$!

# 4. Optional Device Registration with API Key (retry borné)
add_device() {
  local api_key="$1"
  local device_name="${DEVICE_NAME:-Device-$UUID}"
  local max_attempts=10
  local attempt=1

  echo "[Proxyrack] Registering device '$device_name' on dashboard with API key..."
  while [ "$attempt" -le "$max_attempts" ]; do
    local response
    response=$(curl -s --max-time 30 --connect-timeout 10 -X POST https://peer.proxyrack.com/api/device/add \
      -H "Api-Key: ${api_key}" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json' \
      -d "{\"device_id\":\"${UUID}\",\"device_name\":\"${device_name}\"}" || echo '{"status":"error"}')

    if echo "$response" | grep -q '"status":\s*"error"'; then
      echo "[Proxyrack] Device registration pending (tentative $attempt/$max_attempts), retrying in 30s..."
      attempt=$((attempt + 1))
      sleep 30
    else
      echo "[Proxyrack] Device added successfully to your Proxyrack dashboard!"
      touch "$API_CFG_FILE"
      return 0
    fi
  done
  echo "[-] [Proxyrack] Enregistrement du device abandonné après $max_attempts tentatives."
  echo "[-] [Proxyrack] Le device opère quand même avec l'UUID $UUID (registration manuelle possible)."
  return 1
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

# 5. Supervision du superviseur : relance en cas de crash, arrêt propre sinon
MAX_RESTARTS=5
RESTART_COUNT=0

cleanup() {
  echo "[Proxyrack] Stopping..."
  if [ -n "$PROXYRACK_PID" ] && kill -0 "$PROXYRACK_PID" 2>/dev/null; then
    kill -TERM "$PROXYRACK_PID" 2>/dev/null || true
    for _ in $(seq 1 5); do
      kill -0 "$PROXYRACK_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$PROXYRACK_PID" 2>/dev/null; then
      kill -9 "$PROXYRACK_PID" 2>/dev/null || true
    fi
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

while true; do
  if ! kill -0 "$PROXYRACK_PID" 2>/dev/null; then
    if [ "$RESTART_COUNT" -ge "$MAX_RESTARTS" ]; then
      echo "[-] [Proxyrack] Superviseur arrêté $MAX_RESTARTS fois. Sortie pour redémarrage par Docker."
      exit 1
    fi
    RESTART_COUNT=$((RESTART_COUNT + 1))
    echo "[!] [Proxyrack] Superviseur arrêté inopinément, relance ($RESTART_COUNT/$MAX_RESTARTS)..."
    node /app/script.js \
      --homeIp point-of-presence.sock.sh \
      --homePort 443 \
      --id "$UUID" \
      --version "$VERSION" \
      --clientKey proxyrack-pop-client \
      --clientType PoP &
    PROXYRACK_PID=$!
  else
    RESTART_COUNT=0
  fi
  sleep 5
done
