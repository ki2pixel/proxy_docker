#!/usr/bin/env bash
# ==============================================================================
# Script d'Initialisation pour VM Tierhive (KVM) — petite VM 1 vCPU / 1 Go RAM
# Système d'Exploitation : Debian 13 "Trixie"
#
# Différences vs azure_cloud_init.sh :
#   - Utilisateur root (pas azureuser), port SSH 2755 (pas 22)
#   - Swap disque 512 Mo (filet de secours — zRAM prioritaire, étape 7)
#   - UFW ouvre le port 2755 (SSH custom) — PAS le 22 (fermé côté Tierhive)
#   - Ne crée PAS de .env (il sera synchronisé via ./scripts/sync_env.sh .env2)
#   - docker compose up utilise l'override (limites réduites pour 1 Go RAM)
# ==============================================================================
set -euo pipefail

exec > >(tee -a /var/log/tierhive-cloud-init.log) 2>&1
echo "========================================================"
echo "🚀 Initialisation VM Tierhive (Debian 13) - $(date)"
echo "========================================================"

export DEBIAN_FRONTEND=noninteractive

# 1. Mise à jour du système
echo "[1/7] Mise à jour des paquets Debian 13..."
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release git iptables iproute2 ufw

# 2. Swap 1 Go (VM sans swap — protection OOM killer)
echo "[2/7] Activation du swap disque (512 Mo — filet de secours, zRAM prioritaire)..."
if [ ! -f /swapfile ]; then
    fallocate -l 512M /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=512
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "[✓] Swap disque 512 Mo actif (filet de secours)."
else
    echo "[*] /swapfile déjà présent (la convergence hôte le redimensionnera si besoin)."
fi

# 3. Module TUN (requis pour tun2socks)
echo "[3/7] Configuration du module réseau TUN (/dev/net/tun)..."
modprobe tun || true
if ! grep -q "^tun$" /etc/modules 2>/dev/null; then
    echo "tun" >> /etc/modules
fi

if [ ! -c /dev/net/tun ]; then
    mkdir -p /dev/net
    mknod /dev/net/tun c 10 200
fi
chmod 0660 /dev/net/tun
echo "[✓] Module TUN opérationnel."

# 4. Installation officielle de Docker CE & Docker Compose
echo "[4/7] Installation officielle de Docker CE & Docker Compose..."
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
    echo "[✓] Docker CE et Docker Compose installés avec succès."
fi

# 5. Déploiement du projet depuis GitHub
echo "[5/7] Déploiement de la stack proxy_docker..."
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

# PAS de création de .env : il sera synchronisé depuis la machine locale :
#   SSH_PORT=2755 ./scripts/sync_env.sh 85.155.184.191 \
#     docs/Tierhive/ProxyMonetisation1.txt root /opt/proxy_docker .env2
# (sync_env.sh refuse d'envoyer un fichier contenant des CHANGEME_)
if [ ! -f .env ]; then
    echo "[-] ATTENTION : pas de .env sur la VM. Synchronisez-le depuis la machine"
    echo "[-] locale avec scripts/sync_env.sh (voir README section multi-VM) avant"
    echo "[-] de lancer la stack. Démarrage différé."
fi

# 6. Convergence hôte : optimisations mémoire (zRAM, crun, earlyoom, daemon.json)
echo "[6/7] Optimisation hôte Docker (scripts/optimize_vm.sh)..."
OPTIMIZE_VM="${OPTIMIZE_VM:-1}"   # par défaut : ON pour une nouvelle VM
if [ "$OPTIMIZE_VM" = "1" ]; then
    cd "$APP_DIR" && ./scripts/optimize_vm.sh
    echo "[✓] Optimisations hôte appliquées (zRAM, crun, earlyoom, daemon.json)."
else
    echo "[-] OPTIMIZE_VM=0 : convergence hôte ignorée."
fi

# 7. Pare-feu : SSH custom 2755 uniquement (pas le 22)
echo "[7/7] Configuration du Pare-feu UFW (SSH 2755 uniquement)..."
ufw allow 2755/tcp || true
ufw --force enable || true

echo "========================================================"
echo "✅ Initialisation Tierhive terminée !"
echo "   - Swap 512M (filet de secours) + zRAM, TUN, Docker installés"
echo "   - Projet cloné dans $APP_DIR"
if [ -f "$APP_DIR/.env" ]; then
    echo "   - .env présent : lancez la stack avec : cd $APP_DIR && ./scripts/start.sh"
else
    echo "   - ⚠️  .env ABSENT : synchronisez-le (sync_env.sh) puis ./scripts/start.sh"
fi
echo "🌐 Dashboard : ssh -L 8088:localhost:8088 -p 2755 root@$(curl -s https://api.ipify.org)"
echo "========================================================"
