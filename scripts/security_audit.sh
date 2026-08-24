#!/usr/bin/env bash
# ==============================================================================
# Script d'Audit de Sécurité & Détection d'Intrusion (Perfctl, Rootkits, IMDS)
# Projet : proxy_docker
# ------------------------------------------------------------------------------
# Vérifie l'intégrité de la VM hôte face aux attaques connues :
#   1. Détection du rootkit userland LD_PRELOAD (/etc/ld.so.preload, libgcwrap.so)
#   2. Recherche des artefacts et backdoors Perfctl (AAZHDE=1, wizlmsh, perfcc)
#   3. Intégrité des comptes dormants & persistance SSH (compte 'news')
#   4. Exposition des ports réseau sensibles (Docker TCP 2375/2376, Portainer 9001)
#   5. Filtrage Cloud IMDS (169.254.169.254) dans iptables DOCKER-USER
#   6. Durcissement Docker daemon (no-new-privileges, sockets locaux)
#
# Usage :
#   ./scripts/security_audit.sh         # audit standard (mode non-root possible)
#   sudo ./scripts/security_audit.sh    # audit complet (avec accès iptables/shadow)
# ==============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

TOTAL_CHECKS=0
ALERTS=0
WARNINGS=0

log_section() { printf "\n${BOLD}${BLUE}=== %s ===${NC}\n" "$*"; }
log_ok()      { printf "  ${GREEN}[✓] PASS :${NC} %s\n" "$*"; TOTAL_CHECKS=$((TOTAL_CHECKS + 1)); }
log_warn()    { printf "  ${YELLOW}[!] AVERTISSEMENT :${NC} %s\n" "$*"; TOTAL_CHECKS=$((TOTAL_CHECKS + 1)); WARNINGS=$((WARNINGS + 1)); }
log_err()     { printf "  ${RED}[✗] ALERTE SÉCURITÉ :${NC} %s\n" "$*"; TOTAL_CHECKS=$((TOTAL_CHECKS + 1)); ALERTS=$((ALERTS + 1)); }
log_info()    { printf "  ${NC}[*] Info : %s${NC}\n" "$*"; }

echo "========================================================"
echo "🛡️  Audit de Sécurité Hôte & Détection de Menaces"
echo "   Date : $(date)"
echo "   Hôte : $(hostname) (Kernel $(uname -r))"
echo "========================================================"

# ------------------------------------------------------------------------------
# 1. Contrôle Dynamic Linker & Rootkit Userland
# ------------------------------------------------------------------------------
log_section "1. Contrôle Dynamic Linker & Rootkit Userland (LD_PRELOAD)"

if [ -f /etc/ld.so.preload ]; then
    PRELOAD_CONTENT=$(cat /etc/ld.so.preload 2>/dev/null || true)
    if [ -n "$PRELOAD_CONTENT" ]; then
        log_err "/etc/ld.so.preload présent et NON VIDE : $PRELOAD_CONTENT"
    else
        log_warn "/etc/ld.so.preload présent mais vide (à surveiller)"
    fi
else
    log_ok "Aucun fichier /etc/ld.so.preload détecté (intégrité standard)"
fi

SUSPICIOUS_LIBS=(
    "/lib/libgcwrap.so"
    "/usr/lib/libgcwrap.so"
    "/usr/lib/libfsnkdev.so"
    "/usr/lib/libpprocps.so"
    "/lib64/libgcwrap.so"
)
FOUND_SUSPICIOUS_LIB=0
for lib in "${SUSPICIOUS_LIBS[@]}"; do
    if [ -f "$lib" ]; then
        log_err "Bibliothèque partagée malveillante identifiée : $lib"
        FOUND_SUSPICIOUS_LIB=1
    fi
done
if [ "$FOUND_SUSPICIOUS_LIB" -eq 0 ]; then
    log_ok "Aucune bibliothèque rootkit connue (libgcwrap/libfsnkdev) trouvée"
fi

# ------------------------------------------------------------------------------
# 2. Recherche d'Artefacts & Signatures Perfctl (avec contournement AAZHDE)
# ------------------------------------------------------------------------------
log_section "2. Recherche d'Artefacts Perfctl (Bypass AAZHDE=1)"

export AAZHDE=1

PERFCTL_PATHS=(
    "/tmp/.xdiag"
    "/tmp/.apid"
    "/tmp/smpr"
    "/tmp/.perf.c"
    "/usr/bin/wizlmsh"
    "/usr/bin/perfcc"
    "/usr/bin/perfctl"
    "/root/.config/cron/perfcc"
    "/etc/cron.d/perfclean"
)

FOUND_PERFCTL=0
for path in "${PERFCTL_PATHS[@]}"; do
    if [ -e "$path" ]; then
        log_err "Artefact Perfctl détecté sur le système : $path"
        FOUND_PERFCTL=1
    fi
done
if [ "$FOUND_PERFCTL" -eq 0 ]; then
    log_ok "Aucun artefact Perfctl / perfcc / wizlmsh trouvé dans les chemins standard"
fi

# ------------------------------------------------------------------------------
# 3. Intégrité des Comptes Système Dormants & Persistance SSH
# ------------------------------------------------------------------------------
log_section "3. Intégrité des Comptes Dormants & Persistance SSH"

# Vérification compte 'news' ciblé par Perfctl
if id "news" >/dev/null 2>&1; then
    NEWS_ENTRY=$(grep "^news:" /etc/passwd 2>/dev/null || true)
    NEWS_SHELL=$(echo "$NEWS_ENTRY" | awk -F: '{print $7}')
    if [ "$NEWS_SHELL" = "/usr/sbin/nologin" ] || [ "$NEWS_SHELL" = "/bin/false" ]; then
        log_ok "Compte 'news' désactivé avec shell nologin ($NEWS_SHELL)"
    else
        log_err "Compte 'news' possède un shell suspect : '$NEWS_SHELL' (au lieu de /usr/sbin/nologin)"
    fi
    
    # Vérification dossier SSH injecté
    if [ -d "/var/spool/news/.ssh" ] || [ -f "/var/spool/news/.ssh/authorized_keys" ]; then
        log_err "Dossier /var/spool/news/.ssh/ détecté ! Risque critique de persistance SSH Perfctl"
    else
        log_ok "Aucun dossier SSH frauduleux dans /var/spool/news/.ssh"
    fi
else
    log_ok "Compte 'news' non présent sur ce système"
fi

# Vérification globale des autres comptes dormants
for u in nobody daemon sync games lp mail operator; do
    if id "$u" >/dev/null 2>&1; then
        U_SHELL=$(grep "^$u:" /etc/passwd 2>/dev/null | awk -F: '{print $7}')
        if [ "$U_SHELL" != "/usr/sbin/nologin" ] && [ "$U_SHELL" != "/bin/false" ] && [ "$U_SHELL" != "/bin/sync" ] && [ -n "$U_SHELL" ]; then
            log_warn "Compte de service '$u' a un shell interactif : $U_SHELL"
        fi
    fi
done

# ------------------------------------------------------------------------------
# 4. Exposition des Ports Réseau Sensibles
# ------------------------------------------------------------------------------
log_section "4. Exposition des Ports Réseau Sensibles"

if command -v ss >/dev/null 2>&1; then
    LISTEN_PORTS=$(ss -tlnp 2>/dev/null || true)
elif command -v netstat >/dev/null 2>&1; then
    LISTEN_PORTS=$(netstat -tlnp 2>/dev/null || true)
else
    LISTEN_PORTS=""
fi

if [ -n "$LISTEN_PORTS" ]; then
    # Port 2375 (Docker HTTP non sécurisé)
    if echo "$LISTEN_PORTS" | grep -qE "(:2375\b|0\.0\.0\.0:2375|\[::\]:2375)"; then
        log_err "Port Docker Remote API (2375) ouvert publiquement sans chiffrement !"
    else
        log_ok "Port Docker non chiffré 2375 non exposé"
    fi

    # Port 9001 (Portainer Agent non sécurisé)
    if echo "$LISTEN_PORTS" | grep -qE "(:9001\b|0\.0\.0\.0:9001|\[::\]:9001)"; then
        log_err "Port Portainer Agent (9001) exposé publiquement ! Vecteur Perfctl direct"
    else
        log_ok "Port Portainer Agent 9001 non exposé"
    fi

    # Port 4444 (Selenium Grid)
    if echo "$LISTEN_PORTS" | grep -qE "(:4444\b|0\.0\.0\.0:4444|\[::\]:4444)"; then
        log_warn "Port Selenium Grid 4444 détecté en écoute"
    else
        log_ok "Port Selenium Grid 4444 non présent"
    fi

    # Dashboard Port 8088
    if echo "$LISTEN_PORTS" | grep -qE "127\.0\.0\.1:8088|\[::1\]:8088"; then
        log_ok "Dashboard Express (8088) lié en local (127.0.0.1) — accès sécurisé via tunnel SSH"
    elif echo "$LISTEN_PORTS" | grep -qE "0\.0\.0\.0:8088|\[::\]:8088"; then
        log_warn "Dashboard Express (8088) lié publiquement (0.0.0.0) — privilégiez un tunnel SSH ou reverse proxy Caddy"
    fi
else
    log_warn "Impossible d'auditer les ports d'écoute (outils ss/netstat absents ou permissions insuffisantes)"
fi

# ------------------------------------------------------------------------------
# 5. Filtrage Cloud IMDS (169.254.169.254) dans iptables
# ------------------------------------------------------------------------------
log_section "5. Filtrage Cloud IMDS (169.254.169.254)"

if command -v iptables >/dev/null 2>&1; then
    if iptables -L DOCKER-USER -n 2>/dev/null | grep -q "169.254.169.254"; then
        log_ok "Règle iptables DOCKER-USER bloquant 169.254.169.254 (IMDS Cloud) active"
    else
        if [ "$(id -u)" -eq 0 ]; then
            log_warn "Règle iptables DOCKER-USER bloquant 169.254.169.254 absente (exécutez scripts/optimize_vm.sh)"
        else
            log_info "Droits root nécessaires pour inspecter iptables (relancez avec sudo)"
        fi
    fi
else
    log_warn "iptables non installé ou non accessible"
fi

# ------------------------------------------------------------------------------
# 6. Configuration du Démon Docker
# ------------------------------------------------------------------------------
log_section "6. Configuration Démon Docker"

DAEMON_JSON="/etc/docker/daemon.json"
if [ -f "$DAEMON_JSON" ]; then
    if grep -q '"no-new-privileges": true' "$DAEMON_JSON"; then
        log_ok "daemon.json : no-new-privileges activé globalement"
    else
        log_warn "daemon.json : no-new-privileges non configuré globalement (géré au niveau Compose)"
    fi

    if grep -q '"hosts"' "$DAEMON_JSON" && grep -qE 'tcp://0\.0\.0\.0' "$DAEMON_JSON"; then
        log_err "daemon.json : écoute TCP non sécurisée configurée dans hosts !"
    else
        log_ok "daemon.json : aucun socket TCP non sécurisé configuré"
    fi
else
    log_info "/etc/docker/daemon.json non présent (configuration par défaut du démon)"
fi

# ------------------------------------------------------------------------------
# Synthèse & Bilan
# ------------------------------------------------------------------------------
printf "\n========================================================\n"
if [ "$ALERTS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
    printf "${GREEN}${BOLD}✅ BILAN : Système SAIN (%d vérifications réussies, 0 alerte)${NC}\n" "$TOTAL_CHECKS"
elif [ "$ALERTS" -eq 0 ]; then
    printf "${YELLOW}${BOLD}⚠️  BILAN : Système GLOBALEMENT SAIN (%d vérifications, %d avertissements mineurs)${NC}\n" "$TOTAL_CHECKS" "$WARNINGS"
else
    printf "${RED}${BOLD}❌ BILAN : %d ALERTE(S) CRITIQUE(S) DÉTECTÉE(S) ! Intervention requise.${NC}\n" "$ALERTS"
fi
echo "========================================================"

exit "$ALERTS"
