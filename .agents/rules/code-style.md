---
trigger: always_on
description: Conventions de code du projet — controller ESM, scripts bash, compose, langage français
---

# Conventions de code

## Controller (Express.js)

- **ESM** : `import`/`export`, `"type": "module"` dans `controller/package.json`.
- Tests `node:test` dans `controller/test/` (`npm test`).
- Utiliser `lib.js` pour toute logique partagée (redaction des secrets, sessions, .env, validation).

## Scripts bash

- `#!/usr/bin/env bash`
- `set -euo pipefail`
- Toute logique partagée dans `scripts/lib.sh` (ne pas dupliquer).
- Doivent passer **shellcheck** (workflow `security.yml`).

## Docker Compose

- Limiter les ressources (`mem_limit`, `cpus`, `pids_limit`) sur chaque service.
- Logging borné (`max-size: 10m`, `max-file: 3`).
- Healthchecks présents.

## Langue

- Le projet est en **français** : code, commentaires, messages de log et docs.
- Les identifiants et termes techniques anglais restent en anglais.