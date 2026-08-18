#!/usr/bin/env bash
# ==============================================================================
# Script d'Initialisation Cloud-Init (User Data) pour Vultr Cloud Compute
# Stack Multi-Fournisseurs de Monétisation Docker & Passerelle ISP
# ==============================================================================
set -euo pipefail

exec > >(tee -a /var/log/vultr-cloud-init.log) 2>&1
echo "========================================================"
echo "🚀 Initialisation Vultr Cloud Compute - $(date)"
echo "========================================================"

export DEBIAN_FRONTEND=noninteractive

# 1. Mise à jour du système
echo "[1/6] Mise à jour des paquets système..."
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release git iptables iproute2 ufw

# 2. Création et activation d'un Swap SSD de 1 Go (Sécurité RAM)
echo "[2/6] Configuration de la mémoire d'échange Swap (1 Go)..."
if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl vm.swappiness=20
    echo 'vm.swappiness=20' >> /etc/sysctl.conf
    echo "[✓] Swap 1 Go activé avec succès."
fi

# 3. Chargement et persistance du module noyau TUN/TAP
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

# 4. Installation de Docker CE officiel et Docker Compose Plugin
echo "[4/6] Installation officielle de Docker Engine & Docker Compose..."
if ! command -v docker &>/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null

    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    echo "[✓] Docker CE installé et démarré."
fi

# 5. Déploiement de la stack proxy_docker depuis GitHub
echo "[5/6] Déploiement de la stack proxy_docker..."
APP_DIR="/opt/proxy_docker"
REPO_URL="https://github.com/ki2pixel/proxy_docker.git"

if [ ! -d "$APP_DIR" ]; then
    echo "[+] Clonage du dépôt $REPO_URL vers $APP_DIR..."
    git clone "$REPO_URL" "$APP_DIR"
else
    echo "[*] Dépôt déjà présent, mise à jour du code..."
    cd "$APP_DIR" && git pull origin main
fi

cd "$APP_DIR"

if [ ! -f .env ]; then
    echo "[+] Création du fichier .env depuis .env.example..."
    cp .env.example .env
fi

# 6. Configuration du Pare-feu UFW
echo "[6/6] Configuration du Pare-feu (SSH 22, Dashboard 8088)..."
ufw allow 22/tcp || true
ufw allow 8088/tcp || true
ufw --force enable || true

# Lancement des conteneurs
echo "[*] Construction et démarrage des conteneurs Docker..."
docker compose -p proxy_docker up -d --build

echo "========================================================"
echo "✅ Déploiement Vultr terminé avec succès !"
echo "🌐 Dashboard Web : http://$(curl -s https://api.ipify.org):8088"
echo "========================================================"
