---
trigger: model_decision
description: Pièges connus et dépannage — frontend périmé, port 8088 squatté, déploiement CI
---

# Pièges connus & Dépannage (retour d'expérience)

## Frontend périmé / port 8088

- Les assets sont hashés (`app.<hash>.js`, `max-age=1y, immutable`) — un redéploiement change le hash.
- Si un navigateur affiche encore une vieille UI en navigation privée, c'est qu'un **ancien conteneur ou tunnel local** squatte le port 8088 et shadow la VM.
- Vérifier `docker ps` / `ss -tlnp | grep 8088`, arrêter la stack locale — pas blâmer le cache d'abord.
- Après redéploiement, un **hard reload** (`Ctrl+Shift+R`) une fois ; `index.html` reste en revalidation (ETag).

## Providers

- **Proxyrack** : API `/api/device/add` limitée à 5 requêtes/min — espacer les enregistrements.
- **Honeygain** : `Device with this name is already active` temporaire après redémarrage — auto-résorbable.
- **Pawns/Honeygain** : rejet temporaire d'une IP (`tcpip-forward denied` / `Network Unusable`) — délai plateforme.

## CI / Déploiement

- `deploy.yml` recrée tous les conteneurs à chaque push sur `main` — impact Honeygain temporaire (voir ci-dessus).
- `security.yml` scanne gitleaks/shellcheck/npm audit+tests.