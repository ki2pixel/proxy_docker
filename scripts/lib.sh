#!/usr/bin/env bash
# ==============================================================================
# Bibliothèque partagée des scripts proxy_docker
# Usage : source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# ==============================================================================

PROJECT_NAME="proxy_docker"
export PROJECT_NAME

# Racine du projet (2 niveaux au-dessus de scripts/)
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$LIB_DIR/.." && pwd)"
export PROJECT_ROOT

# -----------------------------------------------------------------------------
# get_enabled_gateways : liste des numéros de passerelles actives (ENABLED_GATEWAYS)
#   défaut : "1" (mono-passerelle rétro-compatible)
#   sortie : "1" | "1 2" | "1 2 3 4"
# -----------------------------------------------------------------------------
get_enabled_gateways() {
    local raw
    raw=$(get_env ENABLED_GATEWAYS "1")
    # Normalise : "1,2, 3" -> "1 2 3", filtre les numéros 1..4 valides
    echo "$raw" | tr ',' ' ' | tr -s ' ' | tr ' ' '\n' \
        | grep -E '^[1-4]$' | sort -n -u | tr '\n' ' ' | sed 's/ $//'
}

# -----------------------------------------------------------------------------
# get_gateway_env_prefix <n> : préfixe des clés .env d'une passerelle
#   ex. get_gateway_env_prefix 2 -> GW2_
# -----------------------------------------------------------------------------
get_gateway_env_prefix() {
    echo "GW${1}_"
}

# -----------------------------------------------------------------------------
# compose_profiles_args : construit les arguments --profile pour docker compose
#   à partir d'ENABLED_GATEWAYS (gw{n}) et de COMPOSE_PROFILES (types).
#   Avec le nouveau schéma de profils combinés gw{n}-{type}, on active :
#     - les profils gw{n} (passerelles)
#     - les profils combinés gw{n}-{type} pour chaque passerelle active × type
#   ATTENTION : il faut TOUJOURS passer au moins --profile gw{n} pour une
#   passerelle — sinon ses providers n'ont pas de réseau (fail-closed).
# -----------------------------------------------------------------------------
compose_profiles_args() {
    local gws types t g args=""
    gws=$(get_enabled_gateways)
    # COMPOSE_PROFILES peut être "all" | "none" | liste séparée par virgules
    types=$(get_env COMPOSE_PROFILES "none" | tr ',' ' ' | tr -s ' ')
    # "all" = tous les types ; "none" = aucun provider
    if [ "$types" = "all" ]; then
        types="proxyrack honeygain packetstream pawns repocket"
    elif [ "$types" = "none" ]; then
        types=""
    fi
    for g in $gws; do
        args="$args --profile gw${g}"
        for t in $types; do
            args="$args --profile gw${g}-${t}"
        done
    done
    echo "$args"
}

# -----------------------------------------------------------------------------
# gateway_container <n> : nom du conteneur passerelle
# -----------------------------------------------------------------------------
gateway_container() {
    echo "gateway-isp-$1"
}

# -----------------------------------------------------------------------------
# set_gateway_env <n> <KEY> <VALUE> : met à jour GW{n}_<KEY> dans le .env
# -----------------------------------------------------------------------------
set_gateway_env() {
    local n="$1" key="$2" value="$3"
    set_env "GW${n}_${key}" "$value"
}

# -----------------------------------------------------------------------------
# each_gateway <function> : exécute une fonction pour chaque passerelle active
# -----------------------------------------------------------------------------
each_gateway() {
    local fn="$1" g
    for g in $(get_enabled_gateways); do
        "$fn" "$g"
    done
}

# -----------------------------------------------------------------------------
# Lecture du .env : charge toutes les clés dans des variables d'environnement
# (sans écraser les variables déjà définies).
# -----------------------------------------------------------------------------
load_env() {
    local env_file="${1:-$PROJECT_ROOT/.env}"
    if [ ! -f "$env_file" ]; then
        log "Fichier $env_file introuvable." "WARN"
        return 1
    fi
    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
        # Ignore commentaires et lignes vides
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$line" ]] && continue
        # Format KEY=VALUE (avec ou sans quotes)
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            val="${BASH_REMATCH[2]}"
            # Retire les quotes simples/doubles entourantes
            if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then
                val="${BASH_REMATCH[1]}"
            fi
            # N'écrase pas une variable déjà définie (priorité à l'environnement)
            if [ -z "${!key:-}" ]; then
                export "$key=$val"
            fi
        fi
    done < "$env_file"
}

# -----------------------------------------------------------------------------
# get_env <KEY> [default] : renvoie la valeur ou le défaut
# -----------------------------------------------------------------------------
get_env() {
    local key="$1"
    local default="${2:-}"
    if [ -n "${!key:-}" ]; then
        echo "${!key}"
    else
        echo "$default"
    fi
}

# -----------------------------------------------------------------------------
# set_env <KEY> <VALUE> : met à jour (ou ajoute) une clé dans le .env
# Échappe les caractères spéciaux (backslash, double-quote).
# -----------------------------------------------------------------------------
set_env() {
    local env_file="${3:-$PROJECT_ROOT/.env}"
    local key="$1"
    local value="$2"
    if [ ! -f "$env_file" ]; then
        log "Fichier $env_file introuvable." "ERROR"
        return 1
    fi
    # Échappement : backslash et double-quote
    local escaped
    escaped=$(printf '%s' "$value" | sed 's/\\/\\\\/g; s/"/\\"/g')
    if grep -qE "^${key}=" "$env_file"; then
        sed -i "s|^${key}=.*|${key}=\"${escaped}\"|" "$env_file"
    else
        echo "${key}=\"${escaped}\"" >> "$env_file"
    fi
}

# -----------------------------------------------------------------------------
# require_env <KEY> : refuse de continuer si la clé est manquante ou placeholder
# -----------------------------------------------------------------------------
require_env() {
    local key="$1"
    local val
    val=$(get_env "$key")
    if [ -z "$val" ] || [[ "$val" == CHANGEME_* ]] || [[ "$val" == votre_* ]]; then
        log "Variable $key manquante ou placeholder (CHANGEME_). Renseignez-la dans .env." "ERROR"
        return 1
    fi
}

# -----------------------------------------------------------------------------
# log <msg> [LEVEL]
# -----------------------------------------------------------------------------
log() {
    local msg="$1"
    local level="${2:-INFO}"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $msg"
}
