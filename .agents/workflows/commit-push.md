---
description: Exécuter les contrôles de validation, committer et pousser la branche courante
---

# Commit & Push (branche courante)

## Prérequis

- Des fichiers modifiés existent (`git status`).
- Le remote `origin` est configuré (`git remote -v`).
- **Secrets** : Aucun secret dans le diff (`.env`, `.env2`, clés privées SSH, tokens). `.env` et `.env2` doivent rester gitignorés. Seul `.env.example` est versionnable avec des valeurs factices/placeholders.
- **Assets frontend** : Si `controller/public/app.js` ou `controller/public/style.css` a été modifié, régénérer les assets hashés (`node scripts/build-assets.mjs` ou `cd controller && npm run build:assets`).
- **Données de mesure / temporaires** : Aucun fichier temporaire ou dump involontaire ne doit être présent dans le diff (ex. `benchmark_data.json` non sollicité, logs locaux).

## Étapes

1. Vérifier l'état git :
   ```sh
   git status
   git diff --stat
   ```

2. Lancer les contrôles de validation obligatoires :
   ```sh
   # 1. Tests unitaires du controller Express (node:test)
   cd controller && npm test

   # 2. Audit des dépendances du controller (comme en CI)
   npm audit --omit=dev
   cd ..

   # 3. Validation syntaxique Shellcheck des scripts bash
   shellcheck -S warning scripts/*.sh gateway-isp/*.sh

   # 4. Validation de la configuration Docker Compose
   DASHBOARD_TOKEN=validation_token_32chars_minimum DASHBOARD_SECRET=validation_secret_32chars_minimum \
   docker compose --profile gw1 --profile gw1-pawns --profile gw1-honeygain --profile gw1-repocket --profile gw1-packetstream --profile gw1-wipter config --quiet

   # 5. Vérification du diff (espaces traînantes, retours chariot)
   git diff --check
   ```

3. Stager explicitement les fichiers voulus :
   ```sh
   git add <fichiers>
   git diff --cached --check
   ```
   Éviter `git add -A` par défaut afin de ne jamais inclure par mégarde un fichier `.env`, `.env2` ou des fichiers non suivis non prévus.

4. Committer avec un message respectant la convention Conventional Commits dont le résumé est en **français** :
   ```sh
   git commit -m "<type>: <résumé court en français>"
   ```
   Types usuels : `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`.

5. Pousser sur le dépôt distant :
   ```sh
   git push -u origin "$(git branch --show-current)"
   ```

## Exécution étape par étape

```sh
BRANCH=$(git branch --show-current)

git status
git diff --stat

# Tests et audits
cd controller && npm test
npm audit --omit=dev
cd ..

shellcheck -S warning scripts/*.sh gateway-isp/*.sh

DASHBOARD_TOKEN=validation_token_32chars_minimum DASHBOARD_SECRET=validation_secret_32chars_minimum \
docker compose --profile gw1 --profile gw1-pawns --profile gw1-honeygain --profile gw1-repocket --profile gw1-packetstream --profile gw1-wipter config --quiet

git diff --check

# Staging & commit
git add <fichiers>
git diff --cached --check
git commit -m "<type>: <résumé court en français>"
git push -u origin "$BRANCH"
```

## Notes & Pièges connus

- **CI / CD GitHub Actions** :
  - `security.yml` scanne automatiquement : `gitleaks` (détection de fuite de secrets), `shellcheck` (scripts bash), `npm audit` et `npm test` (controller).
  - `deploy.yml` se déclenche sur chaque push sur `main` et redéploie automatiquement sur la VM Azure VPS (pull git, build assets, redémarrage des conteneurs via Compose).
- **Honeygain & Déploiement** : Le redémarrage complet de la stack lors d'un déploiement peut entraîner un état temporaire `Device with this name is already active` côté Honeygain. Cet état s'auto-résorbe en quelques minutes.
- **Nouvelles clés secrètes** : Si une nouvelle variable sensible est ajoutée (ex. nouveau mot de passe de provider ou clé API `GW{n}_*`), elle **doit impérativement** être déclarée dans `SECRET_KEYS` ou `BASE_SECRET_KEYS` dans `controller/lib.js` pour être masquée dans les logs et l'API de configuration.
- **Ressources conteneurs** : Tout conteneur ajouté dans `docker-compose.yml` doit comporter des limites de ressources strictes (`mem_limit`, `cpus`, `pids_limit`), des logs bornés (`max-size: 2m`, `max-file: 2`), `security_opt: [no-new-privileges:true]` et `cap_drop: [ALL]` (sauf conteneurs de passerelle ayant besoin de `NET_ADMIN`).
- En cas d'échec d'un check, corriger la cause racine avant de committer ; ne jamais contourner les vérifications.
