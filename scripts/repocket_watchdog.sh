#!/usr/bin/env bash
# ==============================================================================
# Watchdog pour les conteneurs Repocket
# Détecte l'état « zombie » (Failed to create connection / Peer not found)
# et force un redémarrage automatique du conteneur.
# ==============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$DIR/lib.sh"

cd "$PROJECT_ROOT"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]]; then
    DRY_RUN=1
fi

GATEWAYS=$(get_enabled_gateways)

for g in $GATEWAYS; do
    CONTAINER="repocket-$g"

    # Vérifie si le conteneur existe et est en cours d'exécution
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
        continue
    fi

    # Vérifie depuis combien de secondes le conteneur tourne
    STARTED_AT=$(docker inspect --format '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || echo "")
    if [ -n "$STARTED_AT" ]; then
        STARTED_TS=$(date --date="$STARTED_AT" +%s 2>/dev/null || echo 0)
        NOW_TS=$(date +%s)
        UPTIME_SEC=$((NOW_TS - STARTED_TS))
        # Laisser au moins 60 secondes au conteneur pour s'enregistrer au démarrage
        if [ "$UPTIME_SEC" -lt 60 ]; then
            continue
        fi
    fi

    # Récupère les 25 dernières lignes de logs
    LOGS=$(docker logs --tail 25 "$CONTAINER" 2>&1 | tr -d '\0' || true)

    # Détection de l'état zombie :
    # 1. Contient une signature d'échec de reconnexion
    # 2. Ne contient PAS de signature de connexion active récente
    IS_ZOMBIE=0
    if echo "$LOGS" | grep -Eq "Failed to create connection|Peer not found|ERR_STREAM_WRITE_AFTER_END"; then
        if ! echo "$LOGS" | grep -Eq "peer connected|isAlive|Settings Packet"; then
            IS_ZOMBIE=1
        fi
    fi

    if [ "$IS_ZOMBIE" -eq 1 ]; then
        echo "[!] Conteneur $CONTAINER détecté en état zombie (déconnexion non résolue)."
        if [ "$DRY_RUN" -eq 1 ]; then
            echo "    [Dry-Run] docker restart $CONTAINER"
        else
            echo "    [*] Redémarrage de $CONTAINER..."
            docker restart "$CONTAINER"
            echo "    [+] $CONTAINER redémarré avec succès."
        fi
    fi
done
