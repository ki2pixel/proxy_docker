#!/bin/bash
set -e

# Test external connectivity through tun0
RESULT=$(curl -s -k --max-time 5 https://ipinfo.io/json 2>/dev/null || true)

if [ -z "$RESULT" ] || echo "$RESULT" | grep -q "Rate limit"; then
    RESULT=$(curl -s --max-time 5 http://ip-api.com/json 2>/dev/null || true)
fi

if [ -z "$RESULT" ]; then
    RESULT=$(curl -s --max-time 5 https://ifconfig.co/json 2>/dev/null || true)
fi

if [ -z "$RESULT" ]; then
    echo "[-] Healthcheck failed: Unable to connect through ISP gateway"
    exit 1
fi

IP=$(echo "$RESULT" | jq -r '.ip // empty' 2>/dev/null || echo "$RESULT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
ORG=$(echo "$RESULT" | jq -r '.org // "Unknown"' 2>/dev/null || echo "Unknown")
CITY=$(echo "$RESULT" | jq -r '.city // "Unknown"' 2>/dev/null || echo "Unknown")
COUNTRY=$(echo "$RESULT" | jq -r '.country // "Unknown"' 2>/dev/null || echo "Unknown")

if [ -n "$IP" ]; then
    echo "[✓] ISP Gateway Healthy | Public IP: $IP | Location: $CITY, $COUNTRY | Org: $ORG"
    exit 0
else
    echo "[-] Healthcheck failed: Invalid response"
    exit 1
fi
