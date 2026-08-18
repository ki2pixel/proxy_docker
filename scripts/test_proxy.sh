#!/usr/bin/env bash

# Test de connectivité proxy ISP via le bridge local (port 23321) ou un proxy distant
PROXY_HOST="${1:-127.0.0.1}"
PROXY_PORT="${2:-23321}"
PROTOCOL="${3:-socks5}"

USER=""
PASS=""
if [ -f .env ]; then
    USER=$(grep -E "^ISP_PROXY_USER=" .env | head -n1 | cut -d'=' -f2- | tr -d '"\r\n' || true)
    PASS=$(grep -E "^ISP_PROXY_PASS=" .env | head -n1 | cut -d'=' -f2- | tr -d '"\r\n' || true)
fi

echo "========================================================"
echo " Test de Connectivité Proxy ISP ($PROTOCOL://$PROXY_HOST:$PROXY_PORT)"
echo "========================================================"

AUTH_FLAG=""
if [ -n "$USER" ] && [ -n "$PASS" ]; then
    AUTH_FLAG="--proxy-user $USER:$PASS"
fi

if [ "$PROTOCOL" = "socks5" ]; then
    CMD="curl -s --max-time 8 $AUTH_FLAG --socks5 $PROXY_HOST:$PROXY_PORT https://ipinfo.io/json"
else
    CMD="curl -s --max-time 8 $AUTH_FLAG -x http://$PROXY_HOST:$PROXY_PORT https://ipinfo.io/json"
fi

echo "[*] Exécution : $CMD"
RESULT=$(eval "$CMD" 2>/dev/null || echo "ERROR")

if [ "$RESULT" = "ERROR" ] || [ -z "$RESULT" ]; then
  echo "[-] Échec du test direct via le port hôte $PROXY_PORT."
  echo "[*] Tentative de diagnostic interne depuis le conteneur gateway-isp :"
  docker exec gateway-isp curl -s --max-time 8 https://ipinfo.io/json || exit 1
  exit 0
fi

echo "$RESULT"
echo ""
echo "[✓] Test réussi : Le proxy fonctionne correctement !"
echo "========================================================"
