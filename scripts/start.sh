#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

echo "========================================================"
echo " Démarrage des Passerelles Dédiées ISP / Residential"
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
GATEWAYS=$(get_enabled_gateways)
PROFILES=$(get_env COMPOSE_PROFILES "repocket")
PORT=$(get_env DASHBOARD_PORT "8088")
COMPOSE_ARGS=$(compose_profiles_args)

echo "[*] Passerelles actives     : $GATEWAYS"
echo "[*] Profil(s) Actif(s)      : $PROFILES"
echo "[*] Dashboard Web           : http://localhost:${PORT} (tunnel SSH requis si distant)"
echo "[*] Construction et démarrage des conteneurs..."
echo "[*] Profils compose         :$COMPOSE_ARGS"

# Cache-busting : hache les assets (app.js, style.css) et réécrit index.html.
# Si node est absent, on utilise les assets dist/ commités (fallback).
if command -v node >/dev/null 2>&1; then
  node scripts/build-assets.mjs
else
  echo "[*] node absent : utilisation des assets dist/ commités."
fi

# shellcheck disable=SC2086
docker compose -p "$PROJECT_NAME" $COMPOSE_ARGS up -d --build

echo ""
echo "[*] Attente de la stabilisation des tunnels passerelles (healthcheck)..."
sleep 5

# Check health de chaque passerelle active
for G in $GATEWAYS; do
  if docker exec "gateway-isp-$G" /usr/local/bin/healthcheck.sh 2>/dev/null; then
    echo ""
    echo "[✓] Passerelle gateway-isp-$G : déploiement validé !"
  else
    echo "[-] Avertissement : le tunnel gateway-isp-$G n'a pas encore validé le healthcheck."
  fi
done

echo ""
echo "[*] Commandes utiles :"
echo "    - Voir l'état complet       : ./scripts/status.sh"
echo "    - Changer de proxy ISP      : ./scripts/switch_isp_proxy.sh <HOST:PORT>"
echo "    - Changer de fournisseur    : ./scripts/switch_provider.sh"
echo "    - Tableau de bord Web       : http://localhost:${PORT}"
echo "    - Voir les logs en direct   : docker compose logs -f"
echo "    - Tester le proxy local     : ./scripts/test_proxy.sh"
echo "========================================================"
