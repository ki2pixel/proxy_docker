---
trigger: model_decision
description: Pièges connus et dépannage — frontend périmé, port 8088 squatté, déploiement CI
---

# Pièges connus & Dépannage (retour d'expérience)

## Tierhive : blocage port 1337 (proxys Proxiware)

- **Tierhive droppe le port 1337 sortant** (politique réseau, confirmée par leur support) — or les proxys statiques Proxiware écoutent tous sur **1337** (port fixe, non modifiable). Une VM Tierhive ne peut donc **jamais** joindre directement un proxy Proxiware.
- Symptôme : timeout TCP sur **tous les ports** vers les IPs Proxiware (1337, 443, 80...), **ICMP/ping OK** (0% perte, ~2ms), reste d'Internet OK (8.8.8.8, google, api.proxiware.com). Reproduit sur 2 IPs sources / 2 localisations Tierhive différentes — ce n'est PAS l'IP source, le swap ou la config.
- **Solution** : relais SOCKS5 sur la VM **Azure** (`scripts/proxiware_relay.py`, services systemd `proxiware-relay-{1..4}`, ports 10801-10804 avec `LimitNOFILE=65535`, `TasksMax=4096`, keepalive TCP agressif à 90s et timeout select de 300s) qui chaîne vers les proxys Proxiware:1337. Les gateways Tierhive pointent vers `68.210.184.174:1080{n}` (voir README, section « Relais SOCKS5 »).
- Si un gateway Tierhive est Healthy mais sans egress ISP : vérifier les services relais sur Azure (`systemctl status proxiware-relay-1`), les ports 10801-10804 (UFW **et** NSG Azure), puis le `.env2` (`GW{n}_ISP_PROXY_HOST` doit pointer vers Azure).
- ⚠️ La stack Tierhive **dépend de la VM Azure** pour ses proxys (dépendance documentée dans le README).

## Frontend périmé / port 8088

- Les assets sont hashés (`app.<hash>.js`, `max-age=1y, immutable`) — un redéploiement change le hash.
- Si un navigateur affiche encore une vieille UI en navigation privée, c'est qu'un **ancien conteneur ou tunnel local** squatte le port 8088 et shadow la VM.
- Vérifier `docker ps` / `ss -tlnp | grep 8088`, arrêter la stack locale — pas blâmer le cache d'abord.
- Après redéploiement, un **hard reload** (`Ctrl+Shift+R`) une fois ; `index.html` reste en revalidation (ETag).

## Providers

- **Repocket** : état « zombie » silencieux lors de micro-coupures réseau (`Peer not found` / `Failed to create connection: undefined`). Résolu par le watchdog `scripts/repocket_watchdog.sh` (timer systemd `repocket-watchdog.timer` toutes les 5 min).
- **Pawns.app** : rejet strict sur proxys ISP commerciaux Proxiware (`non_residential_ip`) provoquant une boucle de crash restart. Retirer `pawns` de `COMPOSE_PROFILES` pour préserver CPU et RAM.
- **Honeygain** : `Device with this name is already active` temporaire après redémarrage — auto-résorbable. L'erreur `Network Unusable` signale un blocage d'IP (proxy détecté ou période de refroidissement suite à un fort trafic).

## CI / Déploiement

- `deploy.yml` recrée tous les conteneurs à chaque push sur `main` — impact Honeygain temporaire (voir ci-dessus).
- `security.yml` scanne gitleaks/shellcheck/npm audit+tests.