---
trigger: always_on
description: Règles de sécurité du projet — secrets, redaction des logs, dashboard, CI (gitleaks)
---

# Sécurité & Secrets

## Secrets

- Jamais de secret en dur dans le code.
- Jamais de `.env`, `.pem` ou clé privée commités.
- Le CI scanne chaque push/PR avec **gitleaks** (`.gitleaks.toml`).
- Le `.env` est gitignoré ; `.env.example` est la source de vérité des clés.

## Dashboard (controller)

- Token `DASHBOARD_TOKEN` (login), sessions signées HMAC-SHA256 (cookie `payload.signature`, TTL 7 jours).
- **CSRF**, rate limiting, CSP stricte, en-têtes de sécurité (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`).
- Secrets **redactés** dans les logs : `redactSecrets` dans `controller/lib.js`.
  - Toute nouvelle clé secrète (ex. `GW{n}_API_KEY`, `GW{n}_PASSWORD`) doit être ajoutée à `SECRET_KEYS` / `BASE_SECRET_KEYS` dans `lib.js`.
  - Les sessions résidentielles (`session-*`) sont aussi masquées.
- API : toutes les routes sous `requireAuth`, les écritures aussi sous `requireCsrf`.

## Durcissement Conteneurs & Hôte (Anti-Perfctl / Proxyjacking)

- **Conteneurs** : tous les services (providers, dashboard, honeygain-pot, caddy) ont `security_opt: [no-new-privileges:true]` et `cap_drop: [ALL]`. Seules les passerelles `gateway-isp` ont `cap_add: [NET_ADMIN, NET_BIND_SERVICE]`.
- **Hôte Linux** : comptes dormants (`news`, `nobody`, `daemon`, etc.) verrouillés avec shell `/usr/sbin/nologin` et mot de passe désactivé.
- **Réseau** : chaîne iptables `DOCKER-USER` bloquant l'accès à l'IMDS Cloud (`169.254.169.254/32`) pour les conteneurs Docker.
- **Audit** : `./scripts/security_audit.sh` pour auditer l'intégrité de la VM hôte.

## CI

- `security.yml` scanne : gitleaks (secrets), shellcheck (scripts bash), npm audit + tests (controller).