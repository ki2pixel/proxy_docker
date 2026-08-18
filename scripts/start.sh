#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

PROJECT_NAME="proxy_docker"

echo "========================================================"
echo " Démarrage de la Passerelle Dédiée ISP / Residential"
echo "========================================================"

if [ ! -f .env ]; then
  echo "[+] Création du fichier .env depuis le modèle .env.example..."
  cp .env.example .env
fi

# Lire les variables depuis .env
PROXY_HOST=$(grep -E "^ISP_PROXY_HOST=" .env | head -n1 | cut -d'=' -f2- | tr -d '"\r\n' || echo "194.70.234.170")
PROXY_PORT=$(grep -E "^ISP_PROXY_PORT=" .env | head -n1 | cut -d'=' -f2- | tr -d '"\r\n' || echo "1085")
PROXY_PROTO=$(grep -E "^ISP_PROXY_PROTOCOL=" .env | head -n1 | cut -d'=' -f2- | tr -d '"\r\n' || echo "socks5")
PROFILES=$(grep -E "^COMPOSE_PROFILES=" .env | head -n1 | cut -d'=' -f2- | tr -d '"\r\n' || echo "repocket")
PORT=$(grep -E "^DASHBOARD_PORT=" .env | head -n1 | cut -d'=' -f2- | tr -d '"\r\n' || echo "8088")

echo "[*] Proxy ISP Configuré   : $PROXY_PROTO://$PROXY_HOST:$PROXY_PORT"
echo "[*] Profil(s) Actif(s)    : $PROFILES"
echo "[*] Dashboard Web         : http://localhost:${PORT}"
echo "[*] Construction et démarrage des conteneurs..."

docker compose -p "$PROJECT_NAME" up -d --build

echo ""
echo "[*] Attente de la stabilisation du tunnel passerelle (healthcheck)..."
sleep 5

# Check health
if docker exec gateway-isp /usr/local/bin/healthcheck.sh 2>/dev/null; then
    echo ""
    echo "[✓] Déploiement ISP réussi et validé !"
else
    echo "[-] Avertissement : Le tunnel n'a pas encore validé le healthcheck."
fi

echo ""
echo "[*] Commandes utiles :"
echo "    - Voir l'état complet       : ./scripts/status.sh"
echo "    - Changer de proxy ISP      : ./scripts/switch_isp_proxy.sh <HOST:PORT>"
echo "    - Changer de fournisseur    : ./scripts/switch_provider.sh"
echo "    - Tableau de bord Web       : http://localhost:${PORT}"
echo "    - Voir les logs en direct   : docker compose logs -f"
echo "    - Tester le proxy local     : ./scripts/test_proxy.sh"
echo "========================================================"
