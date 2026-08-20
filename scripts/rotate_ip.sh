#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

echo "========================================================"
echo " Rotation d'Adresse IP (Passerelles ISP)"
echo "========================================================"

# Usage : ./scripts/rotate_ip.sh [gateway]   (défaut : toutes les passerelles actives)
TARGET_GW="${1:-all}"

load_env

rotate_gateway() {
    local n="$1"
    local GW
    GW=$(gateway_container "$n")
    # Fallback vers les clés legacy pour la passerelle 1 (migration)
    if [ "$n" = "1" ]; then
        PROXY_USER=$(get_env "GW1_ISP_PROXY_USER" "$(get_env ISP_PROXY_USER)")
    else
        PROXY_USER=$(get_env "GW${n}_ISP_PROXY_USER")
    fi

    echo ""
    echo "--- Passerelle $GW ---"

    # Rotation de session : uniquement pour les proxys résidentiels à session
    # (type FlameProxies "session-..."). Pour un proxy classique HOST:PORT:USER:PASS,
    # il n'y a pas de session à faire tourner — on redémarre la passerelle.
    if [[ "$PROXY_USER" == *"session-"* ]]; then
        NEW_SESSION="fresh$(head -c 4 /dev/urandom | od -An -tu2 | tr -d ' ')"
        echo "[*] Détection d'un fournisseur avec rotation de session."
        echo "[*] Génération de la nouvelle session : $NEW_SESSION"

        # Met à jour GW{n}_ISP_PROXY_USER dans le .env (regex session-...)
        KEY="GW${n}_ISP_PROXY_USER"
        if grep -qE "^${KEY}=" .env; then
            sed -i -E "s|^(${KEY}=).*|\\1\"$(printf '%s' "$PROXY_USER" | sed -E 's/session-[a-zA-Z0-9]+/session-'"$NEW_SESSION"'/' | sed 's/\\/\\\\/g; s/"/\\"/g')\"|" .env
        else
            set_env "$KEY" "$PROXY_USER"
        fi
        # Redémarre le tunnel via compose (relecture du .env)
        docker compose -p "$PROJECT_NAME" up -d --no-recreate "$GW" 2>/dev/null || docker compose -p "$PROJECT_NAME" restart "$GW"
    else
        echo "[*] Proxy classique (sans session résidentielle) : redémarrage du tunnel uniquement."
        docker compose -p "$PROJECT_NAME" restart "$GW"
    fi
}

if [ "$TARGET_GW" = "all" ]; then
    for G in $(get_enabled_gateways); do
        rotate_gateway "$G"
    done
else
    if ! [[ "$TARGET_GW" =~ ^[1-4]$ ]]; then
        echo "[-] Numéro de passerelle invalide : 1 à 4 attendu."
        exit 1
    fi
    rotate_gateway "$TARGET_GW"
fi

echo ""
echo "[✓] Demande de rotation exécutée avec succès."
echo "[*] Vérification du nouveau statut dans 3 secondes :"
sleep 3
./scripts/status.sh
