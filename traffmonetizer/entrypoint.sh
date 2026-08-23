#!/bin/sh
# ==============================================================================
# Point d'entrée du client TraffMonetizer (voir Dockerfile)
# ------------------------------------------------------------------------------
# `start accept` connecte le client au serveur et accepte le trafic.
# Le token (TRAFFMONETIZER_TOKEN) et le nom du device
# (TRAFFMONETIZER_DEVICE_NAME, défaut Docker-ISP) sont lus depuis
# l'environnement — jamais passés en dur dans la commande.
# ==============================================================================
set -eu

if [ -z "${TRAFFMONETIZER_TOKEN:-}" ]; then
    echo "Erreur : TRAFFMONETIZER_TOKEN manquant (voir docs/TraffMonetizer/)." >&2
    exit 1
fi

exec /usr/local/bin/cli start accept \
  --token "$TRAFFMONETIZER_TOKEN" \
  --device-name "${TRAFFMONETIZER_DEVICE_NAME:-Docker-ISP}"
