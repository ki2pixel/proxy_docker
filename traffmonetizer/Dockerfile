# ==============================================================================
# Wrapper Alpine autour du client officiel TraffMonetizer
# ------------------------------------------------------------------------------
# L'image officielle traffmonetizer/cli_v2 (~1,3 Mo) est un binaire statique
# sans shell : on ne peut pas y brancher un entrypoint sh -c. Ce wrapper
# recopie le binaire dans une image Alpine minimale et exécute la commande
# standard `cli start accept --token ...` via entrypoint.sh.
#
# Le token reste en variable d'environnement (TRAFFMONETIZER_TOKEN) : il
# n'apparaît ni dans `docker inspect` (Config.Cmd), ni dans les logs.
# ==============================================================================
FROM traffmonetizer/cli_v2:latest AS source
FROM alpine:latest

COPY --from=source /usr/local/bin/cli /usr/local/bin/cli
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
