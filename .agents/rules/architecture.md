---
trigger: always_on
description: Architecture du système proxy_docker — passerelles ISP, namespace réseau, dashboard Express et orchestration Docker
---

# Architecture

## Vue d'ensemble

Système Docker de monétisation de bande passante : jusqu'à **4 passerelles ISP** (`gateway-isp-1..4`), chacune avec son propre namespace réseau et jusqu'à **5 providers** de monétisation (Wipter, Honeygain, PacketStream, Pawns.app, Repocket), pilotées par un **dashboard Express** (`controller/`) qui orchestre via le socket Docker.

Langue du projet : **français** — code, commentaires, messages de log et docs (sauf identifiants/termes techniques anglais).

## Principe central

**`network_mode: service:gateway-isp-{n}`** — chaque pool de providers partage le namespace réseau de SA passerelle. La passerelle crée un `tun0` (198.18.0.1/15), une table de routage dédiée (`0x22b`), un résolveur DoH local (`dnsproxy`, 127.0.0.1:53) et un `tun2socks` vers le proxy amont. Aucun port publié sur l'hôte pour les passerelles : le kill-switch L3 garantit qu'aucun trafic ne fuit sur l'IP de la VM si le proxy tombe.

## Arborescence

```
docker-compose.yml        # 4 passerelles × 5 providers, dashboard, caddy (profil tls)
gateway-isp/              # entrypoint.sh (TUN + routage + DoH + watchdog), healthcheck.sh, Dockerfile
controller/               # Dashboard Express.js + orchestration Docker (index.js, lib.js, public/)
scripts/                  # start.sh, lib.sh (bibliothèque partagée), outils ops
docs/                     # Documentation technique approfondie (Azure, multi-passerelles, routage)
docs/Wipter/              # Guide du provider Wipter (image techroy23/docker-wipter)
```

## Passerelles (`gateway-isp/`)

- `entrypoint.sh` : création TUN, policy routing (bypass 127.0.0.0/8, RFC1918, résolveurs DoH et IP du proxy via la table main ; capture du reste dans la table `0x22b`), DoH `dnsproxy`, bridge socat `127.0.0.1:23320` (test local), `tun2socks` avec **watchdog d'auto-guérison** (redémarrage du tunnel en cas de failover, vérif toutes les 20s, `MAX_FAILURES=2`).
- `healthcheck.sh` : vérifie **uniquement les processus** (tun2socks, dnsproxy, interface TUN) — pas la connectivité externe, qui dépend du proxy amont et du watchdog.

## Dashboard / controller (`controller/`)

Express.js (ESM, `"type": "module"`) sans framework frontend : `public/app.js` + `style.css` vanilla, assets **hashés par contenu** dans `public/dist/` (générés par `scripts/build-assets.mjs`, lancé par `start.sh` et le CI). Pas de dépendance de build frontend.

- Sécurité : token `DASHBOARD_TOKEN` (login), sessions signées HMAC-SHA256 (cookie `payload.signature`, TTL 7 jours), **CSRF**, rate limiting, CSP stricte, en-têtes de sécurité ; secrets **redactés** dans les logs (`redactSecrets` dans `lib.js` — toute nouvelle clé secrète doit y être ajoutée).
- API (toutes sous `requireAuth`, écritures aussi `requireCsrf`) :
  - `GET /healthz` · `POST /api/login|logout`
  - `GET|PUT /api/config` (édition `.env` en allowlist, clés `GW{n}_*` connues uniquement, champs secrets masqués)
  - `GET /api/status` (cache SWR : réponse instantanée + health-checks en arrière-plan)
  - `POST /api/gateways/:gwId/providers/:id/:action` (start/stop/restart d'un provider)
  - `GET /api/logs/container/:name` · `GET /api/logs/stream` (SSE)
- Le dashboard monte le socket Docker et le `.env` de l'hôte (`/var/run/docker.sock`, `./docker-compose.yml`, `./.env`).

## Docker

- L'environnement de dev cible est Docker Compose v2 + Docker Engine 20.10+, noyau avec `/dev/net/tun`.
- Les conteneurs gateway ont besoin de `CAP_NET_ADMIN` et du device `/dev/net/tun` ; le dashboard a besoin du socket Docker monté.
- Le fichier `docker-compose.yml` est aussi monté en lecture seule dans le dashboard (`/workspace/docker-compose.yml`) — le controller l'utilise pour orchestrer.