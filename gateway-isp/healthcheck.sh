#!/bin/bash
set -e

# Healthcheck des PROCESSUS du gateway (pas de la connectivité externe).
# La santé du tunnel dépend du proxy amont (credentials/session tiers) et est
# déjà supervisée par :
#   - le watchdog interne (failover + rotation automatique)
#   - le dashboard (gatewayStatus via fetchCurrentGatewayIP)
# Un healthcheck Docker doit refléter la santé du processus local. Le
# kill-switch L3 garantit structurellement qu'aucun trafic ne fuit sur l'IP
# de la VM, même si le proxy amont est indisponible.

FAIL=0

# 1. tun2socks doit tourner
if ! pgrep -f "tun2socks" > /dev/null 2>&1; then
    echo "[-] Healthcheck failed: tun2socks not running"
    FAIL=1
fi

# 2. dnsproxy doit tourner
if ! pgrep -f "dnsproxy" > /dev/null 2>&1; then
    echo "[-] Healthcheck failed: dnsproxy not running"
    FAIL=1
fi

# 3. L'interface TUN (tun0 par défaut) doit exister et être up
TUN_NAME="${TUN:-tun0}"
if ! ip link show "$TUN_NAME" > /dev/null 2>&1; then
    echo "[-] Healthcheck failed: $TUN_NAME interface missing"
    FAIL=1
fi

if [ "$FAIL" -eq 1 ]; then
    exit 1
fi

# Info (non bloquant) : connectivité externe si disponible
IP=$(curl -s -k --max-time 3 https://ipinfo.io/json 2>/dev/null | jq -r '.ip // empty' 2>/dev/null || true)
if [ -n "$IP" ]; then
    echo "[✓] ISP Gateway Healthy (processus OK, egress: $IP)"
else
    echo "[✓] ISP Gateway Healthy (processus OK, proxy amont injoignable)"
fi
exit 0
