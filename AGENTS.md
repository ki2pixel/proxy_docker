# AGENTS.md — proxy_docker

Mémoire projet pour les agents de code. Ce fichier décrit les conventions, l'architecture et les pièges du dépôt. Le `README.md` reste la référence fonctionnelle complète ; ce document priorise les règles durables de travail.

## Vue d'ensemble

Système Docker de monétisation de bande passante : jusqu'à **4 passerelles ISP** (`gateway-isp-1..4`), chacune avec son propre namespace réseau et jusqu'à **5 providers** de monétisation (TraffMonetizer, Honeygain, PacketStream, Pawns.app, Repocket), pilotées par un **dashboard Express** (`controller/`) qui orchestre via le socket Docker.

Langue du projet : **français** — code, commentaires, messages de log et docs (sauf identifiants/termes techniques anglais).

## Commandes principales

| Action | Commande |
| :--- | :--- |
| Démarrage complet | `./scripts/start.sh` (construit les profils compose depuis `ENABLED_GATEWAYS` + `COMPOSE_PROFILES`, refuse les placeholders `CHANGEME_`/`votre_` dans `.env`) |
| Compose direct | `docker compose -p proxy_docker --profile gw1 --profile gw1-repocket ... up -d --build` |
| État complet | `./scripts/status.sh` |
| Tests controller | `cd controller && npm test` (node:test) |
| Build assets cache-busting | `node scripts/build-assets.mjs` |
| Bascule proxy amont d'une passerelle | `./scripts/switch_isp_proxy.sh <HOST:PORT[:USER:PASS]> [socks5\|http] [gateway]` |
| Bascule du provider actif | `./scripts/switch_provider.sh` |
| Test connectivité proxy | `./scripts/test_proxy.sh [gateway]` |
| Benchmark stack | `./scripts/benchmark.sh` |

## Architecture

```
docker-compose.yml        # 4 passerelles × 5 providers, dashboard, caddy (profil tls)
gateway-isp/              # entrypoint.sh (TUN + routage + DoH + watchdog), healthcheck.sh, Dockerfile
controller/               # Dashboard Express.js + orchestration Docker (index.js, lib.js, public/)
traffmonetizer/            # wrapper Alpine du client officiel (binaire statique sans shell)
scripts/                  # start.sh, lib.sh (bibliothèque partagée), outils ops
scripts/proxiware_relay.py # Relais SOCKS5 (déployé sur Azure) : chaînage vers les proxys Proxiware — contourne le blocage port 1337 de Tierhive
docs/                     # Documentation technique approfondie (Azure, multi-passerelles, routage)
```

### Principe central

**`network_mode: service:gateway-isp-{n}`** — chaque pool de providers partage le namespace réseau de SA passerelle. La passerelle crée un `tun0` (198.18.0.1/15), une table de routage dédiée (`0x22b`), un résolveur DoH local (`dnsproxy`, 127.0.0.1:53) et un `tun2socks` vers le proxy amont. Aucun port publié sur l'hôte pour les passerelles : le kill-switch L3 garantit qu'aucun trafic ne fuit sur l'IP de la VM si le proxy tombe.

### Passerelles (`gateway-isp/`)

- `entrypoint.sh` : création TUN, policy routing (bypass 127.0.0.0/8, RFC1918, résolveurs DoH et IP du proxy via la table main ; capture du reste dans la table `0x22b`), DoH `dnsproxy`, bridge socat `127.0.0.1:23320` (test local), `tun2socks` avec **watchdog d'auto-guérison** (redémarrage du tunnel en cas de failover, vérif toutes les 20s, `MAX_FAILURES=2`).
- `healthcheck.sh` : vérifie **uniquement les processus** (tun2socks, dnsproxy, interface TUN) — pas la connectivité externe, qui dépend du proxy amont et du watchdog.

### Dashboard / controller (`controller/`)

Express.js (ESM, `"type": "module"`) sans framework frontend : `public/app.js` + `style.css` vanilla, assets **hashés par contenu** dans `public/dist/` (générés par `scripts/build-assets.mjs`, lancé par `start.sh` et le CI). Pas de dépendance de build frontend.

- Sécurité : token `DASHBOARD_TOKEN` (login), sessions signées HMAC-SHA256 (cookie `payload.signature`, TTL 7 jours), **CSRF**, rate limiting, CSP stricte, en-têtes de sécurité ; secrets **redactés** dans les logs (`redactSecrets` dans `lib.js` — toute nouvelle clé secrète doit y être ajoutée).
- API (toutes sous `requireAuth`, écritures aussi `requireCsrf`) :
  - `GET /healthz` · `POST /api/login|logout`
  - `GET|PUT /api/config` (édition `.env` en allowlist, clés `GW{n}_*` connues uniquement, champs secrets masqués)
  - `GET /api/status` (cache SWR : réponse instantanée + health-checks en arrière-plan)
  - `POST /api/gateways/:gwId/providers/:id/:action` (start/stop/restart d'un provider)
  - `GET /api/logs/container/:name` · `GET /api/logs/stream` (SSE)
- Le dashboard monte le socket Docker et le `.env` de l'hôte (`/var/run/docker.sock`, `./docker-compose.yml`, `./.env`).

### Providers (`docker-compose.yml`)

Profils compose **combinés** `gw{n}-{type}` (ex. `gw1-traffmonetizer`) + profil passerelle `gw{n}`. Types : `traffmonetizer`, `honeygain`, `packetstream`, `pawns`, `repocket` (images officielles, sauf TraffMonetizer qui passe par un wrapper), ou `none`. Variable `COMPOSE_PROFILES="all|none|liste"`.

### .env

- Clés par passerelle préfixées `GW{n}_` (ex. `GW1_ISP_PROXY_HOST`), fallback sur les clés historiques non préfixées pour la passerelle 1.
- Clés globales : `DASHBOARD_PORT` (défaut 8088, bind 127.0.0.1), `DASHBOARD_TOKEN`, `DASHBOARD_SECRET`, `ENABLED_GATEWAYS`, `COMPOSE_PROFILES`, `GATEWAY_LOGLEVEL`.
- `.env` est **gitignoré** ; `.env.example` est la source de vérité des clés. Le démarrage refuse les valeurs placeholder (`CHANGEME_*`, `votre_*`).

## Conventions de code

- **Controller** : ESM, `import`/`export`, tests `node:test` dans `controller/test/` (`npm test`). Utiliser `lib.js` pour toute logique partagée (redaction, sessions, .env, validation).
- **Scripts bash** : `#!/usr/bin/env bash`, `set -euo pipefail`, toute logique partagée dans `scripts/lib.sh` (ne pas dupliquer). Doivent passer **shellcheck** (workflow `security.yml`).
- **Compose** : limiter ressources (`mem_limit`, `cpus`, `pids_limit`) sur chaque service, logging borné (`max-size: 10m`, `max-file: 3`), healthchecks présents.
- **Secrets** : jamais de secret en dur, jamais de `.env`/`.pem`/clé privée commités (gitleaks dans le CI).

## Validation avant commit

1. `cd controller && npm test` (tests node:test)
2. `npm audit --omit=dev` (CI)
3. shellcheck sur les scripts modifiés (`scripts/*.sh`, `gateway-isp/*.sh`)
4. `docker compose config` valide (CI, avec profils `gw1` + types)

## Pièges connus (retour d'expérience)

- **Tierhive bloque le port 1337 sortant** : les proxys statiques Proxiware écoutent tous sur 1337 (port fixe), donc une VM Tierhive ne peut jamais les joindre directement — timeout TCP tous ports vers les IPs Proxiware, ICMP OK, reste d'Internet OK. Symptôme identique sur plusieurs IPs sources/localisations → ce n'est PAS un problème d'IP source, de swap ou de config. **Solution** : relais SOCKS5 sur la VM Azure (`scripts/proxiware_relay.py`, services `proxiware-relay-{1..4}`, ports 10801–10804) ; les gateways Tierhive pointent vers `68.210.184.174:1080{n}` via `.env2` (USER/PASS vides). Voir README « Relais SOCKS5 Azure → Proxiware ».
- **Frontend périmé** : les assets sont hashés (`app.<hash>.js`, `max-age=1y, immutable`) — un redéploiement change le hash. Si un navigateur affiche encore une vieille UI en navigation privée, c'est qu'un **ancien conteneur ou tunnel local** squatte le port 8088 et shadow la VM — vérifier `docker ps` / `ss -tlnp | grep 8088`, arrêter la stack locale, pas blâmer le cache d'abord.
- **TraffMonetizer** : un token global partagé (`TRAFFMONETIZER_TOKEN`, Dashboard → Token sur app.traffmonetizer.com — un seul token pour les 4 devices) + un nom de device par passerelle (`GW{n}_TRAFFMONETIZER_DEVICE_NAME`). L'image officielle `traffmonetizer/cli_v2` est un binaire statique **sans shell** : on passe par le wrapper `traffmonetizer/` (Alpine + `entrypoint.sh` qui exécute `cli start accept --token "$TRAFFMONETIZER_TOKEN"`). Le token reste en variable d'env (jamais dans `Config.Cmd` ni les logs). Aucun volume.
- **Honeygain** : après un redémarrage, `Device with this name is already active` temporaire — auto-résorbable en quelques minutes.
- **Validation IP plateformes** : Pawns/Honeygain peuvent rejeter une IP temporairement (`tcpip-forward denied` / `Network Unusable`) — délai plateforme, pas un bug de la stack.
- **`network_mode: service:`** : les providers dépendent de `gateway-isp-{n}` sain (`condition: service_healthy`) — ne jamais activer un provider sans sa passerelle (fail-closed, voir `compose_profiles_args` dans `scripts/lib.sh`).
- **CI** : `deploy.yml` recrée tous les conteneurs à chaque push sur `main` (impact Honeygain, voir ci-dessus) ; `security.yml` scanne gitleaks/shellcheck/npm audit+tests.

## Docker

- L'environnement de dev cible est Docker Compose v2 + Docker Engine 20.10+, noyau avec `/dev/net/tun`.
- Les conteneurs gateway ont besoin de `CAP_NET_ADMIN` et du device `/dev/net/tun` ; le dashboard a besoin du socket Docker monté.
- Le fichier `docker-compose.yml` est aussi monté en lecture seule dans le dashboard (`/workspace/docker-compose.yml`) — le controller l'utilise pour orchestrer.
