#!/usr/bin/env bash
# ==============================================================================
# Script de synchronisation du fichier .env vers le serveur distant
# Usage : ./scripts/sync_env.sh <SERVER_IP> <CHEMIN_CLE_SSH> [UTILISATEUR] [APP_DIR_REMOTE]
# ==============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

if [ $# -lt 2 ]; then
    echo "Usage :"
    echo "  ./scripts/sync_env.sh <SERVER_IP> <CHEMIN_CLE_SSH> [UTILISATEUR] [APP_DIR_REMOTE]"
    echo ""
    echo "Exemple :"
    echo "  ./scripts/sync_env.sh 203.0.113.10 ~/.ssh/ma_cle.pem azureuser /opt/proxy_docker"
    echo ""
    echo "⚠️  Prérequis : le serveur doit être dans votre known_hosts :"
    echo "  ssh-keyscan -H <SERVER_IP> >> ~/.ssh/known_hosts"
    exit 1
fi

SERVER_IP="$1"
KEY_PATH="$2"
SSH_USER="${3:-azureuser}"
REMOTE_DIR="${4:-/opt/proxy_docker}"
KNOWN_HOSTS="${KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"

if [ ! -f "$KEY_PATH" ]; then
    echo "[-] Fichier de clé $KEY_PATH introuvable."
    exit 1
fi

if [ ! -f .env ]; then
    echo "[-] Fichier .env local introuvable."
    exit 1
fi

# ⚠️ Avertissement : le dashboard permet d'éditer le .env de la VM directement.
# Ce script ÉCRASE le .env distant avec la copie locale.
if [ -n "${SYNC_FORCE:-}" ]; then
    echo "[!] SYNC_FORCE défini : écrasement du .env distant sans confirmation."
else
    echo "⚠️  ATTENTION : ce script ÉCRASE le .env distant."
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

SSH_OPTS=(-i "$KEY_PATH" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes)
SCP_OPTS=(-i "$KEY_PATH" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes)
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

PERMS=$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo "?")
if [ "$PERMS" != "600" ] && [ "$PERMS" != "400" ] && [ "$PERMS" != "?" ]; then
    echo "[!] Le .env est lisible par d'autres ($PERMS). Correction en 600..."
    chmod 600 .env
fi

echo "========================================================"
echo "🔄 Synchronisation du fichier .env vers $SERVER_IP"
echo "========================================================"

# 1. Envoi sécurisé du .env via SCP (avec vérification du known_hosts)
echo "[1/2] Transfert sécurisé du fichier .env..."
scp "${SCP_OPTS[@]}" .env "${SSH_USER}@${SERVER_IP}:/tmp/.env.proxy_docker"

# 2. Déplacement et redémarrage des conteneurs
echo "[2/2] Application de la nouvelle configuration et redémarrage..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" "sudo cp /tmp/.env.proxy_docker ${REMOTE_DIR}/.env && sudo chown -R ${SSH_USER}:${SSH_USER} ${REMOTE_DIR} && rm -f /tmp/.env.proxy_docker && cd ${REMOTE_DIR} && docker compose up -d"

# 3. Vérification de l'état des conteneurs après redémarrage
echo "[3/3] Vérification de l'état des conteneurs..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" "cd ${REMOTE_DIR} && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"

echo ""
echo "========================================================"
echo "✅ Configuration synchronisée et conteneurs relancés !"
echo "🌐 Dashboard : ssh -L 8088:localhost:8088 ${SSH_USER}@${SERVER_IP}"
echo "========================================================"

