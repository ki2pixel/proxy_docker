#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

echo "========================================================"
echo " Bascule de Fournisseur de Monétisation"
echo "========================================================"

TARGET="$1"

if [ -z "$TARGET" ]; then
  echo "Sélectionnez le fournisseur de monétisation à activer :"
  echo "  1) Proxyrack PoP (proxyrack)"
  echo "  2) Honeygain (honeygain)"
  echo "  3) PacketStream (packetstream)"
  echo "  4) Pawns.app / IPRoyal (pawns)"
  echo "  5) Repocket (repocket)"
  echo "  6) Tous les fournisseurs simultanément (all)"
  echo ""
  read -r -p "Votre choix (1-6) [1] : " CHOICE
  CHOICE="${CHOICE:-1}"

  case "$CHOICE" in
    1) TARGET="proxyrack" ;;
    2) TARGET="honeygain" ;;
    3) TARGET="packetstream" ;;
    4) TARGET="pawns" ;;
    5) TARGET="repocket" ;;
    6) TARGET="all" ;;
    *) TARGET="proxyrack" ;;
  esac
fi

# Normalize target name
case "$TARGET" in
  proxyrack|pr) TARGET="proxyrack" ;;
  honeygain|hg) TARGET="honeygain" ;;
  packetstream|ps|packet) TARGET="packetstream" ;;
  pawns|pawns-app|iproyal) TARGET="pawns" ;;
  repocket|rp) TARGET="repocket" ;;
  all) TARGET="all" ;;
  *)
    echo "[-] Erreur : Fournisseur '$TARGET' inconnu."
    echo "    Options valides : proxyrack | honeygain | packetstream | pawns | repocket | all"
    exit 1
    ;;
esac

echo "[+] Configuration du profil cible : $TARGET"

# Ensure .env exists
if [ ! -f .env ]; then
  cp .env.example .env
fi

# Update COMPOSE_PROFILES in .env (via lib.sh, échappe les valeurs)
set_env COMPOSE_PROFILES "$TARGET"

echo "[+] Application des conteneurs via Docker Compose..."
if [ "$TARGET" != "all" ]; then
  # Stop other monetization containers to ensure clean switch
  ALL_CONTAINERS=("proxyrack-pop" "honeygain" "packetstream" "pawns" "repocket")
  for C in "${ALL_CONTAINERS[@]}"; do
    case "$TARGET" in
      proxyrack) [ "$C" == "proxyrack-pop" ] && continue ;;
      honeygain) [ "$C" == "honeygain" ] && continue ;;
      packetstream) [ "$C" == "packetstream" ] && continue ;;
      pawns) [ "$C" == "pawns" ] && continue ;;
      repocket) [ "$C" == "repocket" ] && continue ;;
    esac
    if docker ps -q -f name="^${C}$" | grep -q .; then
      echo "[-] Arrêt de l'ancien conteneur $C..."
      docker stop "$C" >/dev/null 2>&1 || true
    fi
  done
fi

# Launch with the target profile (projet compose cohérent : -p "$PROJECT_NAME")
COMPOSE_PROFILES="$TARGET" docker compose -p "$PROJECT_NAME" up -d

echo ""
echo "[✓] Fournisseur actif configuré sur : $TARGET !"
echo "[*] Le trafic de ce fournisseur est acheminé via la Passerelle ISP Dédiée."
echo "[*] Vérifiez le statut avec : ./scripts/status.sh"
echo "========================================================"
