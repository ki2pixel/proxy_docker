---
description: Mettre à jour la documentation (architecture multi-passerelles, Docker, scripts, controller) à partir du code, des tests et des configs
---

# Workflow Docs Updater

> Ce workflow harmonise la documentation de `proxy_docker` à partir
> du code réel, des configurations Docker Compose, des scripts et des tests.
> Il ne remplace pas la relecture humaine.

## Protocoles critiques

1. **Périmètre** : documentation uniquement (`docs/`, `README.md`, `AGENTS.md`,
   `.agents/rules/`, et commentaires descriptifs de `.env.example` si nécessaire).
   Ne pas modifier le code applicatif, les scripts, les tests ni la configuration Docker.
2. **Outils autorisés** : `read_file`, `search_files`, `edit_file`, `write_file`,
   outils de diagnostic en lecture/audit (`git`, `find`, `rg`, `wc`, `npm test`,
   `docker compose config`, `shellcheck`).
3. **Contexte** : lire `AGENTS.md`, `.agents/rules/` et `README.md` au démarrage,
   puis la documentation ciblée dans `docs/`.
4. **Source de vérité** : code réel, `docker-compose.yml`, `controller/lib.js`,
   scripts bash et tests > documentation existante > historique git.
   `AGENTS.md` et `.agents/rules/` fixent les conventions durables.
5. **Sécurité** : ne jamais inspecter `.env` ou `.env2` (secrets réels de production) ;
   ne jamais insérer de vrais tokens, mots de passe ou adresses IP privées/sensibles
   dans la documentation (utiliser les placeholders documentés et `.env.example`).
6. **Documents historiques et benchmarks** : `docs/Recherches/`, `docs/Azure/`,
   `docs/Oracle_Cloud/` et `docs/Divers/` (analyses malware/perfctl) documentent des
   études, métriques ou états à un instant T ; ne pas les réécrire pour masquer
   l'historique. Toute correction factuelle doit être contextualisée et datée.

## Étape 1 — Audit structurel, métrique et contractuel

### Cartographie

```sh
git ls-files 'docker-compose*.yml' 'controller/*.js' 'gateway-isp/*' 'scripts/*.sh' 'scripts/*.py' 'docs/**/*.md' '.env.example'
find docs -maxdepth 3 -type f -name '*.md' | sort
```

### Volumétrie

```sh
wc -l AGENTS.md README.md controller/lib.js controller/index.js gateway-isp/entrypoint.sh scripts/lib.sh
find docs -name '*.md' -print0 | xargs -0 wc -l | tail -1
```

### Tests, configuration et dette

```sh
cd controller && npm test
cd ..
DASHBOARD_TOKEN=validation_token_32chars_minimum DASHBOARD_SECRET=validation_secret_32chars_minimum \
docker compose --profile gw1 --profile gw1-pawns --profile gw1-honeygain --profile gw1-repocket --profile gw1-packetstream --profile gw1-wipter config --quiet
rg -n 'TODO|FIXME|HACK|XXX' --glob '!node_modules' --glob '!controller/public/dist'
```

### Fichiers récemment modifiés

```sh
git log --since='30 days ago' --name-only --pretty=format: | sort -u
```

## Étape 2 — Diagnostic triangulé

| Source | Rôle | Outil |
| --- | --- | --- |
| Intention | Le « pourquoi » | `AGENTS.md`, `.agents/rules/`, `README.md`, issues ou demandes utilisateur |
| Réalité | Le « quoi » et le « comment » | `docker-compose.yml`, `gateway-isp/`, `controller/`, `scripts/`, tests |
| Existant | L'état documenté | `docs/**/*.md`, `.env.example`, `README.md` |

Identifier les divergences :

- une variable d'environnement ajoutée ou supprimée dans `docker-compose.yml` ou `controller/lib.js` mais absente de `.env.example` ou de la doc ;
- un profil Compose, une image de provider ou un conteneur modifié dont la syntaxe ou le comportement a évolué ;
- un script dans `scripts/` dont les arguments, options ou prérequis ont changé sans mise à jour du `README.md` ou de `AGENTS.md` ;
- une route API Express (`controller/index.js`), un format d'événement SSE ou une clé de configuration modifiée ;
- un piège d'exploitation non consigné (ex. relais SOCKS5 Azure port 10801-10804 contournant le blocage du port 1337 sur Tierhive, watchdog Repocket anti-zombie, crash loop Pawns sur IP non-résidentielle, cooldown Honeygain) ;
- une référence à un fichier ou un script déplacé ou supprimé.

## Étape 3 — Sélection du standard de rédaction

- **Passerelles & Réseau** : TUN `tun0` (198.18.0.1/15), table de routage `0x22b`, DoH local `dnsproxy` (127.0.0.1:53), bridge socat 127.0.0.1:23320, `tun2socks`, watchdog d'auto-guérison (vérif 20s, failover), étanchéité kill-switch L3 sans port exposé sur l'hôte.
- **Tableau de Bord / Controller** : Express ESM, API REST (`/api/status`, `/api/config`, `/healthz`), SSE (`/api/logs/stream`), sessions HMAC-SHA256, CSRF, gestion du `.env` par allowlist stricte, masquage des secrets (`redactSecrets`), métriques `/proc` hôte (`HostMetricsCollector`).
- **Providers de monétisation** : Wipter (image Docker headless, rathole, identifiants `WIPTER_EMAIL`/`PASSWORD`), Honeygain (et utilitaire Lucky Pot `honeygain-pot`), PacketStream, Pawns.app (contraintes IP résidentielle), Repocket (watchdog anti-zombie `repocket_watchdog.sh`). Rattachement via `network_mode: service:gateway-isp-{n}`.
- **Exploitation & Scripts** : `scripts/start.sh`, `scripts/status.sh`, `scripts/switch_isp_proxy.sh`, `scripts/switch_provider.sh`, `scripts/test_proxy.sh`, `scripts/security_audit.sh`, `scripts/sync_env.sh`, `scripts/build-assets.mjs`.
- **Infrastructure multi-VM** : Différenciation Azure (`.env`) vs Tierhive (`.env2`, port SSH 2755, relais SOCKS5 Azure `68.210.184.174`).
- **Sécurité & Durcissement** : `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`, chaîne iptables `DOCKER-USER` bloquant l'IMDS Cloud (`169.254.169.254`), verrouillage des comptes dormants Linux.

## Étape 4 — Proposition de mise à jour

Produire un plan structuré avant d'appliquer les modifications :

```markdown
## Plan de mise à jour de la documentation

### Audit
- Cible : `docs/Multi_Gateways_4_Proxies.md`
- Constat : la commande de bascule de proxy ne mentionne pas la passerelle cible.

### Modifications
- Type : exploitation / réseau
- Diagnostic : paramètre obsolète ou incomplet
- Correction : ajout de l'argument [gateway] et exemple multi-passerelles

### Vérification
- Commandes et options validées avec le script réel
- Cohérence avec `README.md` et `AGENTS.md`
```

## Étape 5 — Application et finalisation

1. Appliquer avec `edit_file` (modification ciblée) ou `write_file` (réécriture complète).
2. Vérifier la validité des commandes, chemins, options compose, noms de conteneurs et variables cités.
3. Mettre à jour `README.md` et `AGENTS.md` si des commandes principales, profils ou variables globales changent.
4. Mettre à jour `.env.example` si de nouvelles options de configuration sont documentées.
5. Lancer `cd controller && npm test` pour s'assurer qu'aucune régression n'a été introduite.
6. Lancer `git diff --check` pour vérifier l'absence d'erreurs de syntaxe ou d'espaces superflues.
7. Vérifier `git status` : seuls les documents prévus doivent être modifiés ; aucun fichier `.env`, `.env2` ou secret de production.

## Checkpoints

Avant :

- [ ] Sources de vérité lues (`AGENTS.md`, `.agents/rules/`, code source, configs Docker).
- [ ] Public cible et périmètre du document identifiés.
- [ ] Vérification que le document cible n'est pas une archive historique intouchable.

Pendant :

- [ ] Commandes copiables et testées.
- [ ] Tableau de paramètres / options clair.
- [ ] Style factuel, précis, rédigé en français.
- [ ] Exemples de configuration utilisant des valeurs factices / placeholders conformes.

Après :

- [ ] Chemins de fichiers et liens relatifs valides.
- [ ] Variables d'environnement cohérentes avec `.env.example` et `controller/lib.js`.
- [ ] Cohérence avec `AGENTS.md`, `README.md` et `.agents/rules/`.
- [ ] Aucun secret ni information de connexion de production exposé.

## Traçabilité

- Le message de commit mentionne explicitement les documents mis à jour et la nature des synchronisations.
- Les décisions architecturales ou durables sont consignées dans `AGENTS.md` ou `.agents/rules/`.
- Les rapports de métriques et études comparatives sont conservés dans `docs/Recherches/` ou `docs/Azure/`.

## Références principales

- `AGENTS.md`
- `.agents/rules/` (`architecture.md`, `code-style.md`, `security.md`, `env-config.md`, `gateway-operations.md`, `providers.md`, `testing.md`, `troubleshooting.md`)
- `README.md`
- `docker-compose.yml`
- `gateway-isp/entrypoint.sh`, `gateway-isp/healthcheck.sh`
- `controller/lib.js`, `controller/index.js`
- `scripts/lib.sh`, `scripts/start.sh`, `scripts/status.sh`, `scripts/security_audit.sh`, `scripts/proxiware_relay.py`, `scripts/repocket_watchdog.sh`
- `.env.example`
- `docs/Multi_Gateways_4_Proxies.md`
- `docs/Integration_Passerelle_ISP_Residential.md`
- `docs/Honeygain/honeygain-pot.md`
- `docs/Wipter/Wipter_Client_Docker_Setup_Guide.md`
- `docs/Divers/Sécurité_Docker_Perfctl_et_Proxyjacking.md`
