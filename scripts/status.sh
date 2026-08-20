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

# 2. Diagnostic Réseau par passerelle active
GATEWAYS=$(get_enabled_gateways)
for G in $GATEWAYS; do
  GW="gateway-isp-$G"
  echo ""
  echo "--------------------------------------------------------"
  echo "[+] Diagnostic Réseau Passerelle $GW :"

  if docker ps --format '{{.Names}}' | grep -q "^${GW}$"; then
    echo "[*] Diagnostic interne (Healthcheck) :"
    docker exec "$GW" /usr/local/bin/healthcheck.sh || echo "[-] Échec du healthcheck"

    echo ""
    echo "[*] Test DNS externe & IP publique (ipinfo.io via DoH) :"
    docker exec "$GW" curl -s --max-time 5 https://ipinfo.io/json 2>/dev/null || echo "[-] Requête IP externe indisponible"
  else
    echo "[-] Le conteneur $GW n'est pas en cours d'exécution."
  fi
done

PORT=$(get_env DASHBOARD_PORT "8088")
echo ""
echo "--------------------------------------------------------"
echo "[*] Dashboard Web : http://localhost:${PORT} (tunnel SSH requis si distant)"
echo "========================================================"
