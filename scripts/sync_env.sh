#!/usr/bin/env bash
# ==============================================================================
# Script de synchronisation d'un fichier .env vers le serveur distant
# Usage : ./scripts/sync_env.sh <SERVER_IP> <CHEMIN_CLE_SSH> [UTILISATEUR] [APP_DIR_REMOTE] [ENV_SOURCE]
#   ENV_SOURCE : fichier .env local à synchroniser (défaut : .env)
#   Exemple multi-VM : .env pour Azure, .env2 pour Tierhive
#   --push-only : envoie le .env SANS lancer docker compose up (le démarrage
#                 est alors laissé à ./scripts/start.sh — recommandé pour une
#                 nouvelle VM où les images locales restent à construire)
# ==============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

if [ $# -lt 2 ]; then
    echo "Usage :"
    echo "  ./scripts/sync_env.sh <SERVER_IP> <CHEMIN_CLE_SSH> [UTILISATEUR] [APP_DIR_REMOTE] [ENV_SOURCE]"
    echo ""
    echo "Exemple :"
    echo "  ./scripts/sync_env.sh 203.0.113.10 ~/.ssh/ma_cle.pem azureuser /opt/proxy_docker"
    echo "  ./scripts/sync_env.sh 203.0.113.10 ~/.ssh/ma_cle.pem azureuser /opt/proxy_docker .env2"
    echo ""
    echo "⚠️  Prérequis : le serveur doit être dans votre known_hosts :"
    echo "  ssh-keyscan -H <SERVER_IP> >> ~/.ssh/known_hosts"
    exit 1
fi

SERVER_IP="$1"
KEY_PATH="$2"
SSH_USER="${3:-azureuser}"
REMOTE_DIR="${4:-/opt/proxy_docker}"
ENV_SOURCE="${5:-.env}"
KNOWN_HOSTS="${KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"

# --push-only peut être passé en n'importe quelle position : on le retire du
# jeu d'arguments positionnels avant toute utilisation.
PUSH_ONLY=0
POSITIONAL_ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--push-only" ]; then
        PUSH_ONLY=1
    else
        POSITIONAL_ARGS+=("$arg")
    fi
done
if [ "$PUSH_ONLY" -eq 1 ]; then
    set -- "${POSITIONAL_ARGS[@]}"
    SERVER_IP="$1"; KEY_PATH="$2"
    SSH_USER="${3:-azureuser}"; REMOTE_DIR="${4:-/opt/proxy_docker}"
    ENV_SOURCE="${5:-.env}"
fi

if [ ! -f "$KEY_PATH" ]; then
    echo "[-] Fichier de clé $KEY_PATH introuvable."
    exit 1
fi

if [ ! -f "$ENV_SOURCE" ]; then
    echo "[-] Fichier $ENV_SOURCE local introuvable."
    exit 1
fi

# Refuser de synchroniser un fichier contenant encore des placeholders
# (lignes de commentaires ignorées : l'en-tête du .env.example mentionne CHANGEME_)
if grep -vE '^[[:space:]]*#' "$ENV_SOURCE" | grep -qE "CHANGEME_|votre_"; then
    echo "[-] ERREUR : $ENV_SOURCE contient encore des valeurs placeholder (CHANGEME_/votre_)."
    echo "[-] Renseignez les valeurs avant de synchroniser."
    exit 1
fi

# ⚠️ Avertissement : le dashboard permet d'éditer le .env de la VM directement.
# Ce script ÉCRASE le .env distant avec la copie locale ($ENV_SOURCE).
if [ -n "${SYNC_FORCE:-}" ]; then
    echo "[!] SYNC_FORCE défini : écrasement du .env distant sans confirmation."
else
    echo "⚠️  ATTENTION : ce script ÉCRASE le .env distant avec $ENV_SOURCE."
    echo "    Si vous avez modifié la configuration via le dashboard (éditeur .env),"
    echo "    ces changements distants seront PERDUS."
    read -r -p "Continuer ? (oui/non) : " CONFIRM
    if [ "$CONFIRM" != "oui" ]; then
        echo "[-] Annulé."
        exit 1
    fi
fi

# Vérifications de sécurité préalables
# L'empreinte peut être stockée en clair (127.0.0.1) ou hachée (|1|...). On teste
# donc la connexion réelle en mode batch plutôt que de grepper le fichier.
if [ ! -f "$KNOWN_HOSTS" ]; then
    echo "[-] Fichier known_hosts introuvable : $KNOWN_HOSTS"
    exit 1
fi

SSH_OPTS=(-i "$KEY_PATH" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
SCP_OPTS=(-i "$KEY_PATH" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [ -n "${SSH_PORT:-}" ]; then
    SSH_OPTS+=(-p "$SSH_PORT")
    SCP_OPTS+=(-P "$SSH_PORT") # scp utilise -P (majuscule) pour le port
fi

echo "[*] Vérification de la confiance SSH (known_hosts)..."
if ! ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" "echo OK" > /dev/null 2>&1; then
    echo "[-] Impossible de se connecter avec vérification stricte du known_hosts."
    echo "    Ajoutez l'empreinte du serveur avec :"
    echo "      ssh-keyscan -p ${SSH_PORT:-22} -H $SERVER_IP >> $KNOWN_HOSTS"
    echo "    (puis testez avec : ssh ${SSH_USER}@${SERVER_IP})"
    exit 1
fi
echo "[✓] Connexion SSH vérifiée."

PERMS=$(stat -c '%a' "$ENV_SOURCE" 2>/dev/null || stat -f '%Lp' "$ENV_SOURCE" 2>/dev/null || echo "?")
if [ "$PERMS" != "600" ] && [ "$PERMS" != "400" ] && [ "$PERMS" != "?" ]; then
    echo "[!] Le $ENV_SOURCE est lisible par d'autres ($PERMS). Correction en 600..."
    chmod 600 "$ENV_SOURCE"
fi

echo "========================================================"
echo "🔄 Synchronisation du fichier $ENV_SOURCE vers $SERVER_IP"
echo "========================================================"

# 1. Envoi sécurisé du $ENV_SOURCE via SCP (avec vérification du known_hosts)
echo "[1/2] Transfert sécurisé du fichier $ENV_SOURCE..."
scp "${SCP_OPTS[@]}" "$ENV_SOURCE" "${SSH_USER}@${SERVER_IP}:/tmp/.env.proxy_docker"

# 2. Déplacement et redémarrage des conteneurs
echo "[2/2] Application de la nouvelle configuration et redémarrage..."
# Construit les profils gw{n} + gw{n}-{type} d'après le .env synchronisé
# (même logique que scripts/lib.sh, exécutée côté VM après copie)
# sudo est requis si l'utilisateur SSH n'est pas root (ex. azureuser)
SUDO_PREFIX=""
[ "$SSH_USER" != "root" ] && SUDO_PREFIX="sudo "
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" "${SUDO_PREFIX}cp /tmp/.env.proxy_docker ${REMOTE_DIR}/.env && ${SUDO_PREFIX}chown -R ${SSH_USER}:${SSH_USER} ${REMOTE_DIR} && rm -f /tmp/.env.proxy_docker"

if [ "$PUSH_ONLY" -eq 1 ]; then
    echo ""
    echo "========================================================"
    echo "✅ .env synchronisé (PUSH_ONLY — sans redémarrage compose)."
    echo "   Démarrez la stack sur la VM avec :"
    echo "     cd ${REMOTE_DIR} && ./scripts/start.sh"
    echo "========================================================"
    exit 0
fi

# Lancement des conteneurs (mode historique) — voir --push-only plus haut
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" "cd ${REMOTE_DIR} && \
  source scripts/lib.sh && \
  ARGS=\$(compose_profiles_args) && \
  echo \"Profils compose : \$ARGS\" && \
  docker compose \$ARGS up -d --remove-orphans"

# 3. Vérification de l'état des conteneurs après redémarrage
echo "[3/3] Vérification de l'état des conteneurs..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" "cd ${REMOTE_DIR} && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"

echo ""
echo "========================================================"
echo "✅ Configuration synchronisée et conteneurs relancés !"
echo "🌐 Dashboard : ssh -L 8088:localhost:8088 ${SSH_USER}@${SERVER_IP}"
echo "========================================================"

