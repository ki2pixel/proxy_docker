#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

PROJECT_NAME="proxy_docker"

echo "========================================================"
echo " Configuration du Proxy Dédié ISP / Residential"
echo "========================================================"

if [ -n "$1" ]; then
    PROXY_INPUT="$1"
    HOST=$(echo "$PROXY_INPUT" | cut -d':' -f1)
    PORT=$(echo "$PROXY_INPUT" | cut -d':' -f2)
    PROTOCOL="${2:-socks5}"
    
    if [ -z "$PORT" ] || [ "$HOST" = "$PORT" ]; then
        PORT="1080"
    fi
    
    echo "[+] Configuration manuelle du proxy : $PROTOCOL://$HOST:$PORT"
    python3 -c "
from pathlib import Path
env_file = Path('.env')
if env_file.exists():
    lines = env_file.read_text().splitlines()
    new_lines = []
    keys = {'ISP_PROXY_HOST': '\"$HOST\"', 'ISP_PROXY_PORT': '\"$PORT\"', 'ISP_PROXY_PROTOCOL': '\"$PROTOCOL\"'}
    updated = set()
    for l in lines:
        matched = False
        for k, v in keys.items():
            if l.startswith(k + '='):
                new_lines.append(f'{k}={v}')
                updated.add(k)
                matched = True
                break
        if not matched:
            new_lines.append(l)
    for k, v in keys.items():
        if k not in updated:
            new_lines.append(f'{k}={v}')
    env_file.write_text('\n'.join(new_lines) + '\n')
    print('[✓] .env mis à jour avec succès.')
"
else
    echo "Usage :"
    echo "  ./scripts/switch_isp_proxy.sh <HOST:PORT> [socks5|http]"
    echo "Exemple :"
    echo "  ./scripts/switch_isp_proxy.sh proxy.flameproxies.com:1080 socks5"
    echo ""
fi

if docker ps --format '{{.Names}}' | grep -q "gateway-isp"; then
    echo "[+] Application de la nouvelle configuration aux conteneurs du tunnel..."
    docker compose -p "$PROJECT_NAME" up -d --no-recreate gateway-isp repocket honeygain pawns packetstream proxyrack 2>/dev/null || docker compose -p "$PROJECT_NAME" up -d gateway-isp
    sleep 3
    echo "[*] Diagnostic de la nouvelle passerelle :"
    docker exec gateway-isp /usr/local/bin/healthcheck.sh || true
fi

echo "========================================================"
