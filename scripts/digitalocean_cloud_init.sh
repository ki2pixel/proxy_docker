#!/usr/bin/env bash
# ==============================================================================
# Script d'Initialisation Cloud-Init (User Data) pour DigitalOcean Droplet
# Distribution Optimisée Ultra-Légère : Debian 12 (Bookworm) x64
# ==============================================================================
set -euo pipefail

exec > >(tee -a /var/log/do-cloud-init.log) 2>&1
echo "========================================================"
echo "🚀 Initialisation DigitalOcean Droplet (Debian 12) - $(date)"
echo "========================================================"

export DEBIAN_FRONTEND=noninteractive

# 1. Mise à jour minimale de Debian 12
echo "[1/6] Mise à jour des paquets Debian 12..."
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release git iptables iproute2 ufw

# 2. Création du Swap 1 Go sur SSD NVMe (Filet de sécurité RAM)
echo "[2/6] Activation de la mémoire d'échange Swap (1 Go)..."
if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    # Swappiness faible pour privilégier la RAM physique ultra-rapide
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
    chmod 0666 /dev/net/tun
fi
echo "[✓] Module TUN opérationnel."

# 4. Installation officielle de Docker Engine pour Debian 12
echo "[4/6] Installation officielle de Docker CE pour Debian..."
if ! command -v docker &>/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null

    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    echo "[✓] Docker CE installé."
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

# 6. Pare-feu & Démarrage
echo "[6/6] Configuration du Pare-feu UFW (SSH 22, Dashboard 8088)..."
ufw allow 22/tcp || true
ufw allow 8088/tcp || true
ufw --force enable || true

# Lancement des conteneurs
echo "[*] Démarrage de la stack Docker Compose..."
docker compose -p proxy_docker up -d --build

echo "========================================================"
echo "✅ Déploiement DigitalOcean terminé avec succès !"
echo "🌐 Dashboard Web : http://$(curl -s https://api.ipify.org):8088"
echo "========================================================"
