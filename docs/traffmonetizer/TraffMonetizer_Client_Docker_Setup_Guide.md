# Guide d'installation Docker du client TraffMonetizer

## Ce que fait TraffMonetizer

TraffMonetizer rémunère le partage de bande passante. Le client officiel est
distribué via l'image **`traffmonetizer/cli_v2`** (binaire statique, ~1,3 Mo —
sans shell, d'où le wrapper Alpine de ce dépôt dans `traffmonetizer/`).

## Où trouver votre token

1. Connectez-vous sur https://app.traffmonetizer.com.
2. Dans le Dashboard, cliquez sur **Token** (la valeur se termine par `=`).
3. **Un seul token** suffit pour toutes les passerelles : le compteur de
   devices du panel accepte plusieurs instances avec le même token.

## Utilisation autonome (ripper en dehors de la stack)

```bash
docker pull traffmonetizer/cli_v2:latest
docker run -d --name tm traffmonetizer/cli_v2 start accept \
  --token "VOTRE_TOKEN_ICI" --device-name "mon-device"
```

Commandes interactives utiles (`docker exec -it tm ...`) :

| Commande        | Effet                                              |
| :-------------- | :------------------------------------------------- |
| `start`         | connecte le client au serveur                     |
| `stop`          | déconnecte du serveur                              |
| `accept`        | indique que l'application peut accepter du trafic |
| `end-accept`    | connecté mais n'accepte pas de trafic              |
| `statistics`    | `Inbound/Outgoing/Requests`                        |
| `status`        | `Connected / Accepting`                            |
| `exit`          | arrête l'application                               |

## Intégration dans la stack proxy_docker

TraffMonetizer est un provider standard multi-passerelles :

* **Profil compose** : `gw{n}-traffmonetizer`, service `traffmonetizer-{n}`,
  `network_mode: service:gateway-isp-{n}` (trafic routé par le proxy ISP).
* **Image** : wrapper `traffmonetizer/` (Alpine + binaire officiel) construit
  en local, tag `isp-traffmonetizer:latest`.
* **Token** : `TRAFFMONETIZER_TOKEN` (clé **globale**, une seule, sensible —
  jamais affichée par le dashboard, jamais dans les logs).
* **Device** : `GW{n}_TRAFFMONETIZER_DEVICE_NAME` (par passerelle, défaut
  `Docker-ISP-{n}-TraffMonetizer`) — visible dans le panel pour distinguer
  chaque passerelle.
* **Activation** : `COMPOSE_PROFILES="traffmonetizer"` (ou `all`, ou
  `traffmonetizer,honeygain,...`) puis `./scripts/start.sh`.
* **Dashboard** : état et contrôle start/stop/restart via le dashboard
  (`TraffMonetizer`, lien vers https://app.traffmonetizer.com).

## Architecture (multi-IP) et ARM

* Machines multi-IP : `docker network create` + SNAT iptables par sous-réseau
  puis une instance par réseau — dans cette stack, chaque passerelle possède
  déjà son namespace réseau, donc un conteneur par `gw{n}` suffit.
* ARM : images `traffmonetizer/cli_v2:arm64v8` et `:arm32v7` disponibles si
  besoin (le wrapper Dockerfile cible `latest` = x86_64).

## Mise à jour automatique (optionnel)

`start accept` + Watchtower (recommandé par l'éditeur, affecte les gains) :

```bash
docker run -d --name watchtower -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower --cleanup --interval 43200
```
