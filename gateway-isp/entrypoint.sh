#!/bin/bash
# ==============================================================================
# Passerelle ISP Dédiée & Résidentielle avec Watchdog d'Auto-Rotation
# ==============================================================================
set -e

echo "========================================================"
echo " Starting Dedicated ISP / Residential Gateway"
echo "========================================================"

TUN="${TUN:-tun0}"
ADDR="${ADDR:-198.18.0.1/15}"
TABLE="0x22b"
FWMARK="0x22b"

# Configuration Proxy
PROTOCOL="${ISP_PROXY_PROTOCOL:-socks5}"
HOST="${ISP_PROXY_HOST:-}"
PORT="${ISP_PROXY_PORT:-}"
USER="${ISP_PROXY_USER:-}"
PASS="${ISP_PROXY_PASS:-}"
AUTO_ROTATE="${AUTO_ROTATE_SESSION:-true}"
AUTO_ROTATE_INTERVAL="${AUTO_ROTATE_INTERVAL:-50}" # Rotation préventive en minutes (0 = désactivé)

# Validation numérique (sinon défaut)
if ! [[ "$AUTO_ROTATE_INTERVAL" =~ ^[0-9]+$ ]]; then
    echo "[!] AUTO_ROTATE_INTERVAL invalide ('$AUTO_ROTATE_INTERVAL'), défaut à 50."
    AUTO_ROTATE_INTERVAL=50
fi

build_proxy_uri() {
    if [ -n "$PROXY" ]; then
        PROXY_URI="$PROXY"
    elif [ -n "$USER" ] && [ -n "$PASS" ]; then
        PROXY_URI="${PROTOCOL}://${USER}:${PASS}@${HOST}:${PORT}"
    elif [ -n "$HOST" ]; then
        PROXY_URI="${PROTOCOL}://${HOST}:${PORT}"
    else
        echo "[-] ERROR: ISP_PROXY_HOST or PROXY environment variable is required."
        exit 1
    fi
}

build_proxy_uri

LOG_LVL="${LOGLEVEL:-warning}"
if [ "$LOG_LVL" = "warn" ]; then
    LOG_LVL="warning"
fi

echo "[*] Target Proxy  : $PROTOCOL://${HOST:-custom}:$PORT"
echo "[*] TUN Interface : $TUN ($ADDR)"
echo "[*] Auto-Rotation : $AUTO_ROTATE (Watchdog actif)"

# 1. Create TUN Device
if ! ip link show "$TUN" >/dev/null 2>&1; then
    echo "[+] Creating TUN device $TUN..."
    ip tuntap add mode tun dev "$TUN"
    ip addr add "$ADDR" dev "$TUN"
    ip link set dev "$TUN" up
fi

# 2. Configure Policy Routing (L3 transparent capture with explicit priority)
echo "[+] Configuring policy routing..."
ip route replace default dev "$TUN" table "$TABLE"

# Clear any previous custom rules
for p in 1000 1001 1002 1003 1004 1005 1006 1007 1008 1009 2000 2001; do
    ip rule del pref "$p" 2>/dev/null || true
done
ip rule del not fwmark "$FWMARK" table "$TABLE" 2>/dev/null || true
ip rule del fwmark "$FWMARK" to "$ADDR" prohibit 2>/dev/null || true

# High priority bypass rules (pref 1000-1010 -> main table)
ip rule add pref 1000 to 127.0.0.0/8 table main
ip rule add pref 1001 to 10.0.0.0/8 table main
ip rule add pref 1002 to 172.16.0.0/12 table main
ip rule add pref 1003 to 192.168.0.0/16 table main
# Bypass rules for upstream DoH resolvers (Cloudflare, Google, Quad9)
ip rule add pref 1005 to 1.1.1.1 table main
ip rule add pref 1006 to 1.0.0.1 table main
ip rule add pref 1007 to 8.8.8.8 table main
ip rule add pref 1008 to 8.8.4.4 table main
ip rule add pref 1009 to 9.9.9.9 table main

if [ -n "$HOST" ]; then
    HOST_IPS=$(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1}' | sort -u || echo "$HOST")
    if [ -z "$HOST_IPS" ]; then
        HOST_IPS="$HOST"
    fi
    for h_ip in $HOST_IPS; do
        echo "[+] Adding bypass rule for proxy host IP: $h_ip"
        ip rule add pref 1004 to "$h_ip" table main 2>/dev/null || true
    done
fi

# Tunnel capture rules (pref 2000 -> TABLE)
ip rule add pref 2000 not fwmark "$FWMARK" table "$TABLE"
ip rule add pref 2001 fwmark "$FWMARK" to "$ADDR" prohibit

# 3. Start Secure Local DNS-over-HTTPS (DoH) Resolver
echo "[+] Starting local DNS-over-HTTPS resolver (dnsproxy)..."
pkill dnsproxy 2>/dev/null || true
dnsproxy \
    -l 127.0.0.1 -p 53 \
    -u https://1.1.1.1/dns-query \
    -u https://8.8.8.8/dns-query \
    -u https://9.9.9.9/dns-query \
    -b 1.1.1.1:53 \
    --cache \
    --cache-size 65536 \
    --insecure &

# Update container resolv.conf to local DNS resolver
echo "nameserver 127.0.0.1" > /etc/resolv.conf

# 4. Socat Bridge pour Test Local (Port 23320) — lié à loopback uniquement
if [ -n "$HOST" ] && [ -n "$PORT" ]; then
    echo "[+] Starting local socat bridge (127.0.0.1:23320 -> $HOST:$PORT)..."
    pkill socat 2>/dev/null || true
    socat TCP-LISTEN:23320,bind=127.0.0.1,fork,reuseaddr TCP:"$HOST":"$PORT" &
fi

# 5. Tun2socks Process Management & Auto-Rotation Watchdog
TUN2SOCKS_PID=""

start_tun2socks() {
    build_proxy_uri
    echo "[+] Starting tun2socks engine..."
    tun2socks \
        --loglevel "$LOG_LVL" \
        --fwmark "$FWMARK" \
        --device "$TUN" \
        --proxy "$PROXY_URI" &
    TUN2SOCKS_PID=$!
    echo "[✓] tun2socks démarré (PID: $TUN2SOCKS_PID)"
}

# Arrêt propre de tun2socks : TERM puis wait avec timeout, sinon KILL
stop_tun2socks() {
    if [ -n "$TUN2SOCKS_PID" ] && kill -0 "$TUN2SOCKS_PID" 2>/dev/null; then
        kill -TERM "$TUN2SOCKS_PID" 2>/dev/null || true
        for _ in $(seq 1 5); do
            kill -0 "$TUN2SOCKS_PID" 2>/dev/null || break
            sleep 1
        done
        if kill -0 "$TUN2SOCKS_PID" 2>/dev/null; then
            kill -9 "$TUN2SOCKS_PID" 2>/dev/null || true
        fi
        wait "$TUN2SOCKS_PID" 2>/dev/null || true
    fi
    TUN2SOCKS_PID=""
}

rotate_session() {
    local reason="${1:-failover}"
    if [[ "$USER" == *"session-"* ]]; then
        local new_sess
        new_sess="live$(head -c 4 /dev/urandom | od -An -tu2 | tr -d ' ')"
        USER=$(echo "$USER" | sed -E "s/session-[a-zA-Z0-9_-]+/session-${new_sess}/")
        echo "========================================================"
        echo "🔄 [Watchdog] Auto-rotation de session ($reason) -> session-${new_sess}"
        echo "========================================================"
        
        stop_tun2socks
        start_tun2socks
        sleep 3
        # Diagnostic immédiat
        /usr/local/bin/healthcheck.sh || true
    else
        echo "[!] [Watchdog] Déconnexion détectée, redémarrage du tunnel..."
        stop_tun2socks
        start_tun2socks
    fi
}

set +e

cleanup() {
    echo "[*] Stopping gateway services..."
    pkill dnsproxy 2>/dev/null || true
    pkill socat 2>/dev/null || true
    stop_tun2socks
    # Nettoyage des règles de routage et du device TUN
    echo "[*] Removing routing rules and TUN device..."
    for p in 1000 1001 1002 1003 1004 1005 1006 1007 1008 1009 2000 2001; do
        ip rule del pref "$p" 2>/dev/null || true
    done
    ip rule del not fwmark "$FWMARK" table "$TABLE" 2>/dev/null || true
    ip rule del fwmark "$FWMARK" to "$ADDR" prohibit 2>/dev/null || true
    ip link del "$TUN" 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Démarrage initial de tun2socks
start_tun2socks

# Vérification immédiate au démarrage et rotation si la session initiale est expirée
sleep 2
if ! curl -s --max-time 3 http://ip-api.com/json >/dev/null 2>&1 && ! curl -s -k --max-time 3 https://ipinfo.io/json >/dev/null 2>&1; then
    if [[ "$USER" == *"session-"* ]]; then
        echo "[!] [Démarrage] Session initiale expirée ou inaccessible. Auto-rotation immédiate..."
        rotate_session "démarrage initial"
    fi
fi

# 6. Boucle de Surveillance Active (Watchdog)
echo "========================================================"
echo "🛡️ Watchdog de Surveillance & Auto-Guérison Activé"
echo "========================================================"

FAIL_COUNT=0
MAX_FAILURES=2
CHECK_INTERVAL=20

while true; do
    sleep "$CHECK_INTERVAL"

    # Vérifier que tun2socks tourne
    if ! kill -0 "$TUN2SOCKS_PID" 2>/dev/null; then
        echo "[!] tun2socks s'est arrêté inopinément, relance..."
        start_tun2socks
        continue
    fi

    # Test de connectivité actif (Failover uniquement — la rotation préventive
    # est déclenchée par le controller via /api/proxy/rotate)
    if [ "$AUTO_ROTATE" = "true" ]; then
        if curl -s --max-time 4 http://ip-api.com/json >/dev/null 2>&1 || \
           curl -s -k --max-time 4 https://ipinfo.io/json >/dev/null 2>&1 || \
           curl -s -k --max-time 4 https://ifconfig.co/json >/dev/null 2>&1; then
            FAIL_COUNT=0
        else
            FAIL_COUNT=$((FAIL_COUNT + 1))
            echo "[!] [Watchdog] Échec du test de connectivité ($FAIL_COUNT/$MAX_FAILURES)..."
            if [ "$FAIL_COUNT" -ge "$MAX_FAILURES" ]; then
                rotate_session "perte de connexion"
                FAIL_COUNT=0
            fi
        fi
    fi
done
