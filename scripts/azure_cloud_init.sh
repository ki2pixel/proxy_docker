#!/usr/bin/env bash
# ==============================================================================
# Script d'Initialisation pour Machine Virtuelle Microsoft Azure
# Système d'Exploitation : Debian 13 "Trixie" / Debian 12 / Ubuntu
# ==============================================================================
set -euo pipefail

exec > >(tee -a /var/log/azure-cloud-init.log) 2>&1
echo "========================================================"
echo "🚀 Initialisation Azure VM (Debian 13) - $(date)"
echo "========================================================"

export DEBIAN_FRONTEND=noninteractive

# 1. Mise à jour du système
echo "[1/6] Mise à jour des paquets Debian 13..."
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release git iptables iproute2 ufw

# 2. Configuration d'un fichier de Swap de 1 Go sur le SSD
echo "[2/6] Activation de la mémoire d'échange Swap (1 Go)..."
if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl vm.swappiness=10
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
    echo "[✓] Swap 1 Go activé (swappiness=10)."
fi

# 3. Chargement et persistance du module TUN pour tun2socks
echo "[3/6] Configuration du module réseau TUN (/dev/net/tun)..."
modprobe tun || true
if ! grep -q "^tun$" /etc/modules 2>/dev/null; then
    echo "tun" >> /etc/modules
fi

if [ ! -c /dev/net/tun ]; then
    mkdir -p /dev/net
    mknod /dev/net/tun c 10 200
fi
# 0660 (root:root) : Docker root expose le device aux conteneurs via --device
chmod 0660 /dev/net/tun
echo "[✓] Module TUN opérationnel."

# 4. Installation Officielle de Docker Engine & Docker Compose
echo "[4/6] Installation officielle de Docker CE & Docker Compose..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    # Vérification du checksum SHA256 publié (https://get.docker.com → scripts officiels)
    # Le checksum ci-dessous doit être mis à jour si le script amont change.
    EXPECTED_SHA256=""
    if [ -n "$EXPECTED_SHA256" ]; then
        ACTUAL_SHA256=$(sha256sum get-docker.sh | awk '{print $1}')
        if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
            echo "[-] Checksum de get-docker.sh invalide : $ACTUAL_SHA256"
            rm -f get-docker.sh
            exit 1
        fi
    else
        echo "[!] Aucun checksum épinglé pour get-docker.sh — installation à partir du script officiel."
    fi
    sh get-docker.sh
    rm -f get-docker.sh
    systemctl enable --now docker
    # Ajouter l'utilisateur par défaut azureuser au groupe docker
    id -u azureuser &>/dev/null && usermod -aG docker azureuser || true
    echo "[✓] Docker CE et Docker Compose installés avec succès."
fi

# 5. Déploiement du projet depuis GitHub
echo "[5/6] Déploiement de la stack proxy_docker..."
APP_DIR="/opt/proxy_docker"
REPO_URL="https://github.com/ki2pixel/proxy_docker.git"

if [ ! -d "$APP_DIR" ]; then
    echo "[+] Clonage du dépôt $REPO_URL..."
    git clone "$REPO_URL" "$APP_DIR"
else
    echo "[*] Mise à jour du code..."
    cd "$APP_DIR" && git pull origin main
fi

cd "$APP_DIR"

if [ ! -f .env ]; then
    echo "[+] Création du .env initial..."
    cp .env.example .env
fi

# Vérification : refuser de démarrer avec des credentials placeholder
if grep -qE "CHANGEME_|votre_" .env; then
    echo "[-] ERREUR : le fichier .env contient encore des valeurs placeholder."
    echo "[-] Renseignez toutes les valeurs (notamment DASHBOARD_TOKEN, DASHBOARD_SECRET"
    echo "[-] et les identifiants des fournisseurs) puis relancez ce script."
    exit 1
fi

# 6. Configuration Pare-feu & Démarrage
echo "[6/6] Configuration du Pare-feu UFW (SSH 22 uniquement)..."
ufw allow 22/tcp || true
ufw --force enable || true

# Lancement des conteneurs
echo "[*] Démarrage de la stack Docker Compose..."
docker compose -p proxy_docker up -d --build

echo "========================================================"
echo "✅ Déploiement Azure terminé avec succès !"
echo "🌐 Dashboard : accessible via tunnel SSH : ssh -L 8088:localhost:8088 azureuser@$(curl -s https://api.ipify.org)"
echo "========================================================"
