#!/bin/bash
set -e

echo "========================================================"
echo " Starting Dedicated ISP / Residential Gateway"
echo "========================================================"

TUN="${TUN:-tun0}"
ADDR="${ADDR:-198.18.0.1/15}"
TABLE="0x22b"
FWMARK="0x22b"

# Build Proxy URL
PROTOCOL="${ISP_PROXY_PROTOCOL:-socks5}"
HOST="${ISP_PROXY_HOST:-}"
PORT="${ISP_PROXY_PORT:-1085}"
USER="${ISP_PROXY_USER:-}"
PASS="${ISP_PROXY_PASS:-}"

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

LOG_LVL="${LOGLEVEL:-warning}"
if [ "$LOG_LVL" = "warn" ]; then
    LOG_LVL="warning"
fi

echo "[*] Target Proxy  : $PROTOCOL://${HOST:-custom}:$PORT"
echo "[*] TUN Interface : $TUN ($ADDR)"

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
ip rule del pref 1000 2>/dev/null || true
ip rule del pref 1001 2>/dev/null || true
ip rule del pref 1002 2>/dev/null || true
ip rule del pref 1003 2>/dev/null || true
ip rule del pref 1004 2>/dev/null || true
ip rule del pref 1005 2>/dev/null || true
ip rule del pref 1006 2>/dev/null || true
ip rule del pref 1007 2>/dev/null || true
ip rule del pref 1008 2>/dev/null || true
ip rule del pref 1009 2>/dev/null || true
ip rule del pref 2000 2>/dev/null || true
ip rule del pref 2001 2>/dev/null || true
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

# 4. Optional Socat Bridge for Local Host Testing (Port 23320)
if [ -n "$HOST" ] && [ -n "$PORT" ]; then
    echo "[+] Starting local socat bridge (port 23320 -> $HOST:$PORT)..."
    pkill socat 2>/dev/null || true
    socat TCP-LISTEN:23320,fork,reuseaddr TCP:"$HOST":"$PORT" &
fi

echo "[+] Starting tun2socks engine..."
echo "========================================================"

cleanup() {
    echo "[*] Stopping gateway services..."
    pkill dnsproxy 2>/dev/null || true
    pkill socat 2>/dev/null || true
    pkill tun2socks 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

exec tun2socks \
    --loglevel "$LOG_LVL" \
    --fwmark "$FWMARK" \
    --device "$TUN" \
    --proxy "$PROXY_URI"
