#!/usr/bin/env bash
# ==============================================================================
# Convergence hôte — optimisations mémoire pour petite VM Docker
# (1 vCPU / 1-2 Go RAM : Azure B2ats v2, Tierhive KVM, Vultr, DigitalOcean...)
# ------------------------------------------------------------------------------
# Date : 2026-08 — issu du retour d'expérience swap-thrash Azure (voir
#       docs/Recherches/Optimisation_Docker_VM_1_Go.md).
#
# Applique (idempotent, relançable sans risque) :
#   1. Paquets : systemd-zram-generator, crun, earlyoom
#   2. zRAM : swap compressé en RAM (zstd, taille = RAM, priorité swap 100)
#   3. sysctl : vm.swappiness=100, vm.page-cluster=0, vm.vfs_cache_pressure=50
#   4. Swap disque : réduit à 512 Mo (filet de secours, priorité -2)
#   5. earlyoom : purge préventive (protège sshd/docker/containerd,
#      préfère les providers de monétisation)
#   6. /etc/docker/daemon.json : runtime crun, log driver local,
#      live-restore, userland-proxy off, ip6tables off, no-new-privileges
#   7. Overrides systemd docker/containerd : GOMEMLIMIT/GOGC + limites cgroup
#
# Usage :
#   sudo ./scripts/optimize_vm.sh            # applique tout (idempotent)
#   sudo ./scripts/optimize_vm.sh --dry-run  # affiche les actions sans rien faire
#
# Prérequis : root (sudo) ; Debian 12+/Ubuntu 22.04+ avec systemd ;
# noyau 5.9+ (zram/zstd) ; cgroup v2. Les containers en cours d'exécution
# sont préservés lors des redémarrages docker (live-restore).
# ==============================================================================
set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
    DRY_RUN=1
fi

if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    echo "[-] Ce script doit être exécuté en root (sudo)."
    exit 1
fi

log()  { printf '[*] %s\n' "$*"; }
ok()   { printf '[✓] %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*"; }

# Exécute une commande (ou l'affiche en mode dry-run)
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '  [dry-run] %s\n' "$*"
    else
        "$@"
    fi
}

# Écrit un fichier si son contenu diffère (comparaison binaire via cmp).
# Retourne 1 si le fichier a été écrit (ou serait écrit en dry-run).
write_if_changed() {
    local path="$1" content="$2"
    if [ -f "$path" ] && printf '%s' "$content" | cmp -s - "$path"; then
        ok "déjà à jour : $path"
        return 0
    fi
    log "écriture : $path"
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '%s\n' "$content" | sed 's/^/  | /'
        return 1
    fi
    printf '%s' "$content" > "$path"
    ok "écrit : $path"
    return 1
}

echo "========================================================"
echo "🔄 Optimisation hôte Docker (VM petite mémoire)"
echo "========================================================"

# ---------------------------------------------------------------------------
# 1. Paquets requis
# ---------------------------------------------------------------------------
NEED_APT=0
for p in systemd-zram-generator crun earlyoom; do
    if ! dpkg -s "$p" >/dev/null 2>&1; then
        NEED_APT=1
        break
    fi
done
if [ "$NEED_APT" -eq 1 ]; then
    log "installation des paquets : systemd-zram-generator crun earlyoom"
    run apt-get update -qq
    run apt-get install -y systemd-zram-generator crun earlyoom
else
    ok "paquets présents : systemd-zram-generator crun earlyoom"
fi

# ---------------------------------------------------------------------------
# 2. zRAM : swap compressé en RAM (préviend le swap-thrash disque)
# ---------------------------------------------------------------------------
read -r -d '' ZRAM_CONF_CONTENT <<'EOF' || true
[zram0]
zram-size = ram
compression-algorithm = zstd
swap-priority = 100
fs-type = swap
EOF
write_if_changed /etc/systemd/zram-generator.conf "$ZRAM_CONF_CONTENT" || true

# Activation à chaud (sans attendre le reboot : le generator systemd a besoin
# d'un daemon-reload pour régénérer l'unité systemd-zram-setup@zram0.service).
if [ "$DRY_RUN" -eq 1 ]; then
    log "activation zRAM : systemctl daemon-reload && systemctl start systemd-zram-setup@zram0.service && swapon /dev/zram0"
else
    if ! swapon --show | grep -q '/dev/zram0'; then
        log "activation zRAM (sans reboot)"
        systemctl daemon-reload 2>/dev/null || true
        systemctl start "systemd-zram-setup@zram0.service" 2>/dev/null || true
        swapon /dev/zram0 2>/dev/null || true
    fi
    if swapon --show | grep -q '/dev/zram0'; then
        ok "zRAM actif : $(zramctl --output NAME,DISKSIZE,COMPR,DATA --noheadings /dev/zram0 2>/dev/null | tr -s ' ')"
    else
        warn "zRAM non actif — sera activé au prochain boot"
    fi
fi

# ---------------------------------------------------------------------------
# 3. Sysctl : favoriser la compression zRAM plutôt que le cache disque
# ---------------------------------------------------------------------------
read -r -d '' SYSCTL_CONTENT <<'EOF' || true
# Optimisation mémoire VM petite RAM (zRAM prioritaire)
vm.swappiness = 100
vm.page-cluster = 0
vm.vfs_cache_pressure = 50
EOF
write_if_changed /etc/sysctl.d/99-memory-tuning.conf "$SYSCTL_CONTENT" || true
run sysctl -p /etc/sysctl.d/99-memory-tuning.conf

# ---------------------------------------------------------------------------
# 4. Swap disque : réduit à 512 Mo (filet de secours — priorité par défaut -2,
#    le noyau utilise toujours le zRAM priorité 100 en premier)
# ---------------------------------------------------------------------------
configure_swapfile() {
    local swapfile=/swapfile size_mb=512 cur=0
    if [ -f "$swapfile" ]; then
        cur=$(( $(stat -c '%s' "$swapfile") / 1024 / 1024 ))
    fi
    if [ -f "$swapfile" ] && [ "$cur" -eq "$size_mb" ]; then
        ok "swap disque déjà à ${size_mb} Mo"
        return 0
    fi
    log "swap disque → ${size_mb} Mo (filet de secours, priorité -2)"
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '  | swapoff %s (si actif) ; rm -f ; fallocate -l %sM ; mkswap ; swapon\n' "$swapfile" "$size_mb"
        return 0
    fi
    swapoff "$swapfile" 2>/dev/null || true
    rm -f "$swapfile"
    fallocate -l "${size_mb}M" "$swapfile" || dd if=/dev/zero of="$swapfile" bs=1M count="$size_mb"
    chmod 600 "$swapfile"
    mkswap "$swapfile" >/dev/null
    swapon "$swapfile"
    ok "swap disque ${size_mb} Mo actif"
}
configure_swapfile

if ! grep -qs '^/swapfile' /etc/fstab; then
    log "ajout /swapfile au fstab"
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '  | echo "/swapfile none swap sw 0 0" >> /etc/fstab\n'
    else
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi
fi

# ---------------------------------------------------------------------------
# 5. earlyoom : anti-OOM préventif (le noyau réagit trop tard en swap-thrash)
# ---------------------------------------------------------------------------
EARLYOOM_CHANGED=0
read -r -d '' EARLYOOM_CONTENT <<'EOF' || true
EARLYOOM_ARGS="-m 7 -s 10 -r 30 --avoid systemd,sshd,dockerd,containerd,earlyoom --prefer honeygain,pawns,repocket,packetstream"
EOF
write_if_changed /etc/default/earlyoom "$EARLYOOM_CONTENT" || EARLYOOM_CHANGED=1
run systemctl enable --now earlyoom
if [ "$EARLYOOM_CHANGED" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
    systemctl restart earlyoom || true
    ok "earlyoom reconfiguré"
fi

# ---------------------------------------------------------------------------
# 6. daemon.json : runtime crun, log local, live-restore, allégements réseau
# ---------------------------------------------------------------------------
NEED_RESTART_DOCKER=0
NEED_RESTART_CONTAINERD=0

read -r -d '' DAEMON_JSON_CONTENT <<'EOF' || true
{
  "default-runtime": "crun",
  "runtimes": {
    "crun": { "path": "/usr/bin/crun" }
  },
  "log-driver": "local",
  "log-opts": { "max-size": "2m", "max-file": "2", "compress": "true" },
  "log-level": "warn",
  "live-restore": true,
  "userland-proxy": false,
  "iptables": true,
  "ip6tables": false,
  "no-new-privileges": true,
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Hard": 4096, "Soft": 2048 }
  }
}
EOF
write_if_changed /etc/docker/daemon.json "$DAEMON_JSON_CONTENT" || NEED_RESTART_DOCKER=1

# Validation JSON avant tout redémarrage (un daemon.json invalide rendrait
# dockerd muet et couperait l'accès à la stack).
if [ "$DRY_RUN" -eq 0 ] && [ -f /etc/docker/daemon.json ]; then
    if command -v python3 >/dev/null 2>&1; then
        if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' /etc/docker/daemon.json; then
            echo "[-] daemon.json invalide — abandon avant redémarrage docker."
            exit 1
        fi
        ok "daemon.json valide (JSON)"
    else
        warn "python3 absent : validation JSON sautée"
    fi
fi

# ---------------------------------------------------------------------------
# 7. Overrides systemd : bornage Go (GOMEMLIMIT/GOGC) + garde-fous cgroup v2
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
    printf '  | mkdir -p /etc/systemd/system/docker.service.d /etc/systemd/system/containerd.service.d\n'
else
    mkdir -p /etc/systemd/system/docker.service.d /etc/systemd/system/containerd.service.d
fi

read -r -d '' DOCKER_OVERRIDE_CONTENT <<'EOF' || true
[Service]
Environment="GOMEMLIMIT=64MiB"
Environment="GOGC=50"
MemoryMin=32M
MemoryLow=64M
MemoryMax=256M
EOF
write_if_changed /etc/systemd/system/docker.service.d/override.conf "$DOCKER_OVERRIDE_CONTENT" || NEED_RESTART_DOCKER=1

read -r -d '' CONTAINERD_OVERRIDE_CONTENT <<'EOF' || true
[Service]
Environment="GOMEMLIMIT=32MiB"
Environment="GOGC=50"
MemoryMin=16M
MemoryLow=32M
MemoryMax=128M
EOF
write_if_changed /etc/systemd/system/containerd.service.d/override.conf "$CONTAINERD_OVERRIDE_CONTENT" || NEED_RESTART_CONTAINERD=1

# ---------------------------------------------------------------------------
# 8. Redémarrage des démons si une config a changé (live-restore préserve
#    les containers en cours d'exécution)
# ---------------------------------------------------------------------------
if { [ "$NEED_RESTART_DOCKER" -eq 1 ] || [ "$NEED_RESTART_CONTAINERD" -eq 1 ]; }; then
    if [ "$DRY_RUN" -eq 1 ]; then
        log "redémarrage des démons (dry-run) : systemctl daemon-reload ;"
        [ "$NEED_RESTART_CONTAINERD" -eq 1 ] && printf '  | systemctl restart containerd\n'
        [ "$NEED_RESTART_DOCKER" -eq 1 ] && printf '  | systemctl restart docker\n'
    else
        log "redémarrage des démons Docker (live-restore : containers préservés)"
        systemctl daemon-reload
        if [ "$NEED_RESTART_CONTAINERD" -eq 1 ]; then
            systemctl restart containerd
        fi
        if [ "$NEED_RESTART_DOCKER" -eq 1 ]; then
            systemctl restart docker
        fi
        ok "démons redémarrés"
    fi
fi

echo "========================================================"
echo "✅ Convergence hôte terminée."
if [ "$DRY_RUN" -eq 0 ]; then
    echo "   Vérifications : zramctl ; free -h ; docker info | grep -i runtime"
    echo "   (les nouveaux containers utiliseront crun au prochain recreate)"
fi
echo "========================================================"