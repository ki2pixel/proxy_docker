#!/usr/bin/env bash
# ==============================================================================
# Script de synchronisation rapide du fichier .env vers le serveur Azure
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

SERVER_IP="${1:-68.210.184.174}"
KEY_PATH="docs/Azure/ProxyMonetisation_key.pem"

if [ ! -f "$KEY_PATH" ]; then
    echo "[-] Fichier de clé $KEY_PATH introuvable."
    exit 1
fi

if [ ! -f .env ]; then
    echo "[-] Fichier .env local introuvable."
    exit 1
fi

echo "========================================================"
echo "🔄 Synchronisation du fichier .env vers Azure ($SERVER_IP)"
echo "========================================================"

# 1. Envoi sécurisé du .env via SCP
echo "[1/2] Transfert sécurisé du fichier .env..."
scp -i "$KEY_PATH" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no .env "azureuser@${SERVER_IP}:/tmp/.env"

# 2. Déplacement et redémarrage des conteneurs
echo "[2/2] Application de la nouvelle configuration et redémarrage..."
ssh -i "$KEY_PATH" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no "azureuser@${SERVER_IP}" "
    sudo cp /tmp/.env /opt/proxy_docker/.env && \
    sudo chown -R azureuser:azureuser /opt/proxy_docker && \
    cd /opt/proxy_docker && \
    docker compose up -d
"

echo ""
echo "========================================================"
echo "✅ Configuration synchronisée et conteneurs relancés !"
echo "🌐 Dashboard Web : http://${SERVER_IP}:8088"
echo "========================================================"
