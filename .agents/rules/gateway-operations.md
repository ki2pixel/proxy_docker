---
trigger: model_decision
description: Opérations sur les passerelles — rotation de session, bascule de proxy, providers, commandes d'exploitation
---

# Opérations Passerelles & Providers

## Commandes principales

| Action | Commande |
| :--- | :--- |
| Bascule proxy amont d'une passerelle | `./scripts/switch_isp_proxy.sh <HOST:PORT[:USER:PASS]> [socks5\|http] [gateway]` |
| Bascule du provider actif | `./scripts/switch_provider.sh` |
| Test connectivité proxy | `./scripts/test_proxy.sh [gateway]` |
| Benchmark stack | `./scripts/benchmark.sh` |

## Providers (docker-compose.yml)

Profils compose **combinés** `gw{n}-{type}` (ex. `gw1-traffmonetizer`) + profil passerelle `gw{n}`. Types : `traffmonetizer`, `honeygain`, `packetstream`, `pawns`, `repocket` (images officielles, sauf TraffMonetizer qui passe par un wrapper), ou `none`. Variable `COMPOSE_PROFILES="all|none|liste"`.

- **`network_mode: service:`** : les providers dépendent de `gateway-isp-{n}` sain (`condition: service_healthy`).
- Ne jamais activer un provider sans sa passerelle (fail-closed, voir `compose_profiles_args` dans `scripts/lib.sh`).

## Watchdog & failover

- Le **watchdog** de la passerelle gère le failover : redémarrage du tunnel en cas de perte de connexion (vérif toutes les 20s, `MAX_FAILURES=2`). Avec un proxy à IP fixe (Static ISP), aucune rotation de session n'est possible ni nécessaire.
- `healthcheck.sh` vérifie **uniquement les processus** (tun2socks, dnsproxy, interface TUN) — pas la connectivité externe, qui dépend du proxy amont.