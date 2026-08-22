---
trigger: model_decision
description: Validation et tests — node:test controller, npm audit, shellcheck, docker compose config
---

# Tests & Validation avant commit

## À exécuter avant tout commit

1. **Tests controller** : `cd controller && npm test` (node:test, fichiers `controller/test/`)
2. **npm audit** : `npm audit --omit=dev` (comme en CI)
3. **shellcheck** sur les scripts modifiés (`scripts/*.sh`, `gateway-isp/*.sh`)
4. **docker compose config** valide (CI avec profils `gw1` + types)

## Commandes utiles

| Action | Commande |
| :--- | :--- |
| Démarrage complet | `./scripts/start.sh` |
| Compose direct | `docker compose -p proxy_docker --profile gw1 --profile gw1-repocket ... up -d --build` |
| État complet | `./scripts/status.sh` |
| Tests controller | `cd controller && npm test` |
| Build assets cache-busting | `node scripts/build-assets.mjs` |
| Test connectivité proxy | `./scripts/test_proxy.sh [gateway]` |
| Benchmark stack | `./scripts/benchmark.sh` |

## CI

- `deploy.yml` : valide `docker compose config` localement, puis déploie sur la VM (recrée tous les conteneurs — impact Honeygain temporaire).
- `security.yml` : gitleaks + shellcheck + npm audit + tests.