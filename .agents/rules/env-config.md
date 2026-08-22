---
trigger: model_decision
description: Gestion du .env et de la configuration — clés par passerelle, globals, placeholders interdits
---

# .env & Configuration

## Clés par passerelle

- Clés préfixées `GW{n}_` (ex. `GW1_ISP_PROXY_HOST`), fallback sur les clés historiques non préfixées pour la passerelle 1.
- Passerelles supportées : 1 à 4 (`GATEWAY_NUMS = [1, 2, 3, 4]` dans `controller/lib.js`).

## Clés globales

- `DASHBOARD_PORT` (défaut 8088, bind 127.0.0.1)
- `DASHBOARD_TOKEN`, `DASHBOARD_SECRET`
- `ENABLED_GATEWAYS` (ex. `"1,2,3,4"`)
- `COMPOSE_PROFILES` (`all` | `none` | liste)
- `GATEWAY_LOGLEVEL`

## Règles

- `.env` est **gitignoré** ; ne jamais le commiter.
- `.env.example` est la source de vérité des clés.
- Le démarrage (`scripts/start.sh`) refuse les valeurs placeholder : `CHANGEME_*` et `votre_*`.
- L'éditeur du dashboard (`PUT /api/config`) utilise une **allowlist** de clés connues — pas de mode fichier brut.
- Les champs secrets sont masqués (champ vide = inchangé).
- `scripts/sync_env.sh` écrase le `.env` distant (confirmation requise) — attention à ne pas écraser les changements faits via le dashboard.