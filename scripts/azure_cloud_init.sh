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
echo "[1/7] Mise à jour des paquets Debian 13..."
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release git iptables iproute2 ufw

# 2. Swap disque 512 Mo (filet de secours — zRAM prioritaire, étape 6)
echo "[2/7] Activation du swap disque (512 Mo — filet de secours)..."
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

# 3. Chargement et persistance du module TUN pour tun2socks
echo "[3/7] Configuration du module réseau TUN (/dev/net/tun)..."
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
    # Ajouter l'utilisateur par défaut azureuser au groupe docker
    if id -u azureuser &>/dev/null; then
        usermod -aG docker azureuser || true
    fi
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

# 6. Convergence hôte : optimisations mémoire (zRAM, crun, earlyoom, daemon.json)
echo "[6/7] Optimisation hôte Docker (scripts/optimize_vm.sh)..."
OPTIMIZE_VM="${OPTIMIZE_VM:-0}"   # par défaut : OFF (VM Azure existante déjà optimisée)
if [ "$OPTIMIZE_VM" = "1" ]; then
    cd "$APP_DIR" && ./scripts/optimize_vm.sh
    echo "[✓] Optimisations hôte appliquées (zRAM, crun, earlyoom, daemon.json)."
else
    echo "[-] OPTIMIZE_VM=0 : convergence hôte ignorée (déjà appliquée en direct ?)."
fi

# 7. Configuration Pare-feu & Durcissement Sécurité
echo "[7/7] Configuration du Pare-feu UFW & Durcissement Sécurité..."
ufw allow 22/tcp || true
ufw --force enable || true

# Durcissement comptes dormants (prévention Perfctl SSH backdoor)
for u in news nobody daemon sync games lp mail operator; do
    if id "$u" >/dev/null 2>&1; then
        usermod -s /usr/sbin/nologin "$u" 2>/dev/null || true
        passwd -l "$u" 2>/dev/null || true
    fi
done

# Filtrage IMDS Cloud (169.254.169.254) pour conteneurs Docker
if command -v iptables >/dev/null 2>&1; then
    if iptables -L DOCKER-USER >/dev/null 2>&1; then
        iptables -C DOCKER-USER -d 169.254.169.254/32 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP
    fi
fi

# Lancement des conteneurs — même logique de profils que ./scripts/start.sh
# (lib.sh compose_profiles_args : ENABLED_GATEWAYS + COMPOSE_PROFILES ->
#  --profile gw{n} + gw{n}-{type}, avec fail-closed gw{n} pour les providers)
echo "[*] Démarrage de la stack Docker Compose (profils : .env)..."
# shellcheck disable=SC1091
source ./scripts/lib.sh
load_env
COMPOSE_ARGS=$(compose_profiles_args)
echo "[*] Profils compose :$COMPOSE_ARGS"
# shellcheck disable=SC2086
docker compose -p "$PROJECT_NAME" $COMPOSE_ARGS up -d --build

echo "========================================================"
echo "✅ Déploiement Azure terminé avec succès !"
echo "🌐 Dashboard : accessible via tunnel SSH : ssh -L 8088:localhost:8088 azureuser@$(curl -s https://api.ipify.org)"
echo "========================================================"
