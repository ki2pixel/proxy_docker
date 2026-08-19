#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

echo "========================================================"
echo " État Complet de la Passerelle ISP & Nœuds Docker"
echo "========================================================"

# 1. Conteneurs Docker
echo "[+] Conteneurs Docker :"
docker compose -p "$PROJECT_NAME" ps -a

echo ""
echo "--------------------------------------------------------"
echo "[+] Diagnostic Réseau Passerelle :"

if docker ps --format '{{.Names}}' | grep -q "^gateway-isp$"; then
    echo "[*] Diagnostic interne (Healthcheck) :"
    docker exec gateway-isp /usr/local/bin/healthcheck.sh || echo "[-] Échec du healthcheck"

    echo ""
    echo "[*] Test DNS externe & IP publique (ipinfo.io via DoH) :"
    docker exec gateway-isp curl -s --max-time 5 https://ipinfo.io/json 2>/dev/null || echo "[-] Requête IP externe indisponible"
else
    echo "[-] Le conteneur gateway-isp n'est pas en cours d'exécution."
fi

PORT=$(get_env DASHBOARD_PORT "8088")
echo ""
echo "--------------------------------------------------------"
echo "[*] Dashboard Web : http://localhost:${PORT} (tunnel SSH requis si distant)"
echo "========================================================"
