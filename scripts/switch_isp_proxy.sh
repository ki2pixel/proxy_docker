#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

echo "========================================================"
echo " Configuration du Proxy Dédié ISP / Residential"
echo "========================================================"

# Usage : ./scripts/switch_isp_proxy.sh <HOST:PORT[:USER:PASS]> [socks5|http] [gateway]
#   gateway : numéro de passerelle cible (défaut 1)
if [ -n "$1" ]; then
    PROXY_INPUT="$1"
    PROTOCOL="${2:-socks5}"
    GATEWAY_NUM="${3:-1}"
    # Validation du protocole
    if [ "$PROTOCOL" != "socks5" ] && [ "$PROTOCOL" != "http" ]; then
        echo "[-] Protocole invalide : socks5 ou http attendu."
        exit 1
    fi
    # Validation du numéro de passerelle
    if ! [[ "$GATEWAY_NUM" =~ ^[1-4]$ ]]; then
        echo "[-] Numéro de passerelle invalide : 1 à 4 attendu."
        exit 1
    fi

    # Formats acceptés :
    #   HOST:PORT                     (proxy sans auth)
    #   HOST:PORT:USER:PASS           (schéma classique)
    #   HOST:PORT:USER:PASS:session-X (session résidentielle)
    IFS=':' read -r HOST PORT PROXY_USER PROXY_PASS _REST <<< "$PROXY_INPUT"

    # Validation du format HOST:PORT (les identifiants peuvent contenir des
    # caractères spéciaux comme @ ou &, ils ne sont pas validés ici)
    if [[ ! "$HOST" =~ ^[A-Za-z0-9.-]+$ ]] || [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
        echo "[-] Format invalide : attendu HOST:PORT[:USER:PASS] (ex: proxy.example.com:1080:user:pass)"
        exit 1
    fi

    echo "[+] Configuration manuelle du proxy (passerelle $GATEWAY_NUM) : $PROTOCOL://$HOST:$PORT"
    set_gateway_env "$GATEWAY_NUM" ISP_PROXY_HOST "$HOST"
    set_gateway_env "$GATEWAY_NUM" ISP_PROXY_PORT "$PORT"
    set_gateway_env "$GATEWAY_NUM" ISP_PROXY_PROTOCOL "$PROTOCOL"
    if [ -n "$PROXY_USER" ]; then
        set_gateway_env "$GATEWAY_NUM" ISP_PROXY_USER "$PROXY_USER"
        echo "[+] Utilisateur configuré : ${PROXY_USER%%:*}"
    fi
    if [ -n "$PROXY_PASS" ]; then
        set_gateway_env "$GATEWAY_NUM" ISP_PROXY_PASS "$PROXY_PASS"
        echo "[+] Mot de passe configuré (masqué)."
    fi
else
    echo "Usage :"
    echo "  ./scripts/switch_isp_proxy.sh <HOST:PORT> [socks5|http] [gateway]"
    echo "  ./scripts/switch_isp_proxy.sh <HOST:PORT:USER:PASS> [socks5|http] [gateway]"
    echo "Exemples :"
    echo "  ./scripts/switch_isp_proxy.sh proxy.example.com:1080 socks5 1"
    echo "  ./scripts/switch_isp_proxy.sh proxy.example.com:1080:monuser:monpass socks5 2"
    echo ""
    exit 1
fi

GW="gateway-isp-$GATEWAY_NUM"
if docker ps --format '{{.Names}}' | grep -q "^${GW}$"; then
    echo "[+] Application de la nouvelle configuration aux conteneurs du tunnel..."
    docker compose -p "$PROJECT_NAME" up -d --no-recreate "$GW" 2>/dev/null || docker compose -p "$PROJECT_NAME" up -d "$GW"
    sleep 3
    echo "[*] Diagnostic de la nouvelle passerelle :"
    docker exec "$GW" /usr/local/bin/healthcheck.sh || true
fi

echo "========================================================"
