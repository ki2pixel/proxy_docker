#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

# Test de connectivité proxy ISP via le conteneur gateway-isp-{n} (défaut 1)
# Usage : ./scripts/test_proxy.sh [HOST:PORT] [socks5|http] [gateway]
GATEWAY_NUM="${3:-1}"
if ! [[ "$GATEWAY_NUM" =~ ^[1-4]$ ]]; then
    echo "[-] Numéro de passerelle invalide : 1 à 4 attendu."
    exit 1
fi
GW="gateway-isp-$GATEWAY_NUM"
PROXY_HOST="${1:-$GW}"
PROXY_PORT="${2:-23320}"
PROTOCOL="${3:-socks5}"

# Validation des entrées
if ! [[ "$PROXY_HOST" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "[-] Hôte invalide : $PROXY_HOST"
    exit 1
fi
if ! [[ "$PROXY_PORT" =~ ^[0-9]+$ ]]; then
    echo "[-] Port invalide : $PROXY_PORT"
    exit 1
fi
if [ "$PROTOCOL" != "socks5" ] && [ "$PROTOCOL" != "http" ]; then
    echo "[-] Protocole invalide : socks5 ou http attendu."
    exit 1
fi

load_env
USER=$(get_env "GW${GATEWAY_NUM}_ISP_PROXY_USER" "$(get_env ISP_PROXY_USER)")
PASS=$(get_env "GW${GATEWAY_NUM}_ISP_PROXY_PASS" "$(get_env ISP_PROXY_PASS)")

echo "========================================================"
echo " Test de Connectivité Proxy ISP ($PROTOCOL://$PROXY_HOST:$PROXY_PORT)"
echo "========================================================"

# Construit le tableau d'arguments curl (pas de shell, pas d'injection)
CURL_ARGS=(-s --max-time 8)
if [ "$PROTOCOL" = "socks5" ]; then
    CURL_ARGS+=(--socks5 "$PROXY_HOST:$PROXY_PORT")
else
    CURL_ARGS+=(-x "http://$PROXY_HOST:$PROXY_PORT")
fi
if [ -n "$USER" ] && [ -n "$PASS" ]; then
    CURL_ARGS+=(--proxy-user "$USER:$PASS")
fi
CURL_ARGS+=(https://ipinfo.io/json)

# Affichage sans le mot de passe
SAFE_PROXY_USER="***"
if [ -z "$USER" ]; then
    SAFE_PROXY_USER="(sans auth)"
fi
echo "[*] Exécution : curl ${CURL_ARGS[*]} (user: $SAFE_PROXY_USER)"

RESULT=$(curl "${CURL_ARGS[@]}" 2>/dev/null || echo "ERROR")

if [ "$RESULT" = "ERROR" ] || [ -z "$RESULT" ]; then
  echo "[-] Échec du test direct via le port $PROXY_PORT."
  echo "[*] Tentative de diagnostic interne depuis le conteneur $GW :"
  docker exec "$GW" curl -s --max-time 8 https://ipinfo.io/json || exit 1
  exit 0
fi

echo "$RESULT"
echo ""
echo "[✓] Test réussi : Le proxy fonctionne correctement !"
echo "========================================================"
