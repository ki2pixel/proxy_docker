#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

PROJECT_NAME="proxy_docker"

PORT="8088"
if [ -f .env ]; then
  PORT=$(grep -E "^DASHBOARD_PORT=" .env | cut -d'=' -f2 | tr -d ' "\r\n' || echo "8088")
  PORT="${PORT:-8088}"
fi

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

echo ""
echo "--------------------------------------------------------"
echo "[*] Dashboard Web : http://localhost:${PORT}"
echo "========================================================"
