#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

echo "========================================================"
echo " Démarrage de la Passerelle Dédiée ISP / Residential"
echo "========================================================"

if [ ! -f .env ]; then
  echo "[+] Création du fichier .env depuis le modèle .env.example..."
  cp .env.example .env
fi

load_env

# Refuser de démarrer avec des credentials placeholder
if grep -qE "CHANGEME_|votre_" .env; then
  echo "[-] ERREUR : le fichier .env contient encore des valeurs placeholder."
  echo "[-] Renseignez DASHBOARD_TOKEN, DASHBOARD_SECRET et les identifiants fournisseurs."
  exit 1
fi

# Lecture des variables via la bibliothèque
PROXY_HOST=$(get_env ISP_PROXY_HOST)
PROXY_PORT=$(get_env ISP_PROXY_PORT)
PROXY_PROTO=$(get_env ISP_PROXY_PROTOCOL "socks5")
PROFILES=$(get_env COMPOSE_PROFILES "repocket")
PORT=$(get_env DASHBOARD_PORT "8088")

echo "[*] Proxy ISP Configuré   : ${PROXY_PROTO:-socks5}://${PROXY_HOST:-non défini}:${PROXY_PORT:-non défini}"
echo "[*] Profil(s) Actif(s)    : $PROFILES"
echo "[*] Dashboard Web         : http://localhost:${PORT} (tunnel SSH requis si distant)"
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
