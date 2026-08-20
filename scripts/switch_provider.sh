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
  echo "  0) Aucun (none) — seulement la passerelle + dashboard"
  echo "  1) Proxyrack PoP (proxyrack)"
  echo "  2) Honeygain (honeygain)"
  echo "  3) PacketStream (packetstream)"
  echo "  4) Pawns.app / IPRoyal (pawns)"
  echo "  5) Repocket (repocket)"
  echo "  6) Tous les fournisseurs simultanément (all)"
  echo ""
  read -r -p "Votre choix (0-6) [1] : " CHOICE
  CHOICE="${CHOICE:-1}"

  case "$CHOICE" in
    0) TARGET="none" ;;
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
  none|off|stop|aucun) TARGET="none" ;;
  proxyrack|pr) TARGET="proxyrack" ;;
  honeygain|hg) TARGET="honeygain" ;;
  packetstream|ps|packet) TARGET="packetstream" ;;
  pawns|pawns-app|iproyal) TARGET="pawns" ;;
  repocket|rp) TARGET="repocket" ;;
  all) TARGET="all" ;;
  *)
    echo "[-] Erreur : Fournisseur '$TARGET' inconnu."
    echo "    Options valides : none | proxyrack | honeygain | packetstream | pawns | repocket | all"
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

# Application sur toutes les passerelles actives (profils combinés gw{n}-{type})
GATEWAYS=$(get_enabled_gateways)
echo "[+] Passerelles actives : $GATEWAYS"

# Arrêt des providers devenus inactifs (nettoyage des anciens conteneurs)
# Les noms de conteneurs sont désormais suffixés par passerelle (pawns-1...)
if [ "$TARGET" != "all" ] && [ "$TARGET" != "none" ]; then
  for G in $GATEWAYS; do
    for TYPE in proxyrack honeygain packetstream pawns repocket; do
      if [ "$TYPE" = "$TARGET" ]; then continue; fi
      C="${TYPE}-${G}"
      if docker ps -q -f name="^${C}$" | grep -q .; then
        echo "[-] Arrêt de l'ancien conteneur $C..."
        docker stop "$C" >/dev/null 2>&1 || true
      fi
    done
  done
fi
if [ "$TARGET" = "none" ]; then
  for G in $GATEWAYS; do
    for TYPE in proxyrack honeygain packetstream pawns repocket; do
      C="${TYPE}-${G}"
      if docker ps -q -f name="^${C}$" | grep -q .; then
        echo "[-] Arrêt du conteneur $C..."
        docker stop "$C" >/dev/null 2>&1 || true
      fi
    done
  done
fi

# Lancement avec les profils cibles (passerelles + types)
COMPOSE_ARGS=$(compose_profiles_args)
echo "[+] Profils compose :$COMPOSE_ARGS"
# shellcheck disable=SC2086
COMPOSE_PROFILES="$TARGET" docker compose -p "$PROJECT_NAME" $COMPOSE_ARGS up -d

echo ""
if [ "$TARGET" = "none" ]; then
  echo "[✓] Aucun fournisseur actif : seules les passerelles et le dashboard tournent."
  echo "[*] Aucun trafic de monétisation — parfait en attendant un proxy stable."
else
  echo "[✓] Fournisseur actif configuré sur : $TARGET !"
  echo "[*] Le trafic de ce fournisseur est acheminé via les Passerelles ISP Dédiées."
fi
echo "[*] Vérifiez le statut avec : ./scripts/status.sh"
echo "========================================================"
