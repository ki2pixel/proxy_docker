# Guide d'installation Docker du client Antgain

## Ce que fait Antgain

Antgain rémunère le partage de bande passante résiduelle. Le client officiel est distribué via l'image multi-arch **`pinors/antgain-cli:latest`** (Docker Hub, binaires statiques musl `linux/amd64`, `linux/arm64`, `linux/arm/v7`).

## Prérequis

1. Connectez-vous sur https://antgain.app.
2. Récupérez votre **API Key** dans vos paramètres : https://antgain.app/dashboard/settings.
3. Générez un **UUID v4 stable** par conteneur (`ANTGAIN_DEVICE_ID`), par exemple :
   ```bash
   uuidgen | tr '[:upper:]' '[:lower:]'
   ```

> ⚠️ **Important (UUID de device)** : Le serveur Antgain associe le nœud à son `ANTGAIN_DEVICE_ID`. Il faut **hardcoder** un UUID fixe par passerelle dans le `.env` et **conserver le même UUID** lors des recréations/mises à jour de conteneurs.

## Intégration dans la stack `proxy_docker`

Antgain est un provider standard multi-passerelles :

* **Profil compose** : `gw{n}-antgain`, service `antgain-{n}`,
* **Image** : `pinors/antgain-cli:latest` (image officielle Docker Hub),
* **Clé API** : `ANTGAIN_API_KEY` (clé **globale**, partagée entre toutes les passerelles),
* **Device ID** : `GW{n}_ANTGAIN_DEVICE_ID` (UUID unique et fixe par passerelle),
* **Activation** : `COMPOSE_PROFILES="antgain"` (ou `all`, ou `antgain,repocket,...`) puis `./scripts/start.sh`,
* **Tableau de bord** : visible sous chaque carte passerelle dans le dashboard Web (icône 🐜, lien direct vers https://antgain.app).

## Commandes utiles

```bash
# Voir les logs d'un conteneur
docker logs -f antgain-1

# Voir le journal d'audit interne du client
docker exec -it antgain-1 antgain logs -f

# Vérifier le statut du client à l'intérieur du conteneur
docker exec -it antgain-1 antgain status
docker exec -it antgain-1 antgain info
```
