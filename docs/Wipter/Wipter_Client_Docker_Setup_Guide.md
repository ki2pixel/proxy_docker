# Guide d'installation Docker du client Wipter

## Ce que fait Wipter

Wipter rémunère le partage de bande passante résiduelle (payouts en crypto/USDT). L'application cliente officielle est distribuée sous forme de paquet desktop Electron. L'image communautaire multi-arch **`techroy23/docker-wipter:latest`** (Docker Hub, `linux/amd64` et `linux/arm64`) permet de faire tourner le client Wipter de façon isolée et headless sur un serveur Linux.

## Fonctionnement sous Docker

L'image `techroy23/docker-wipter:latest` intègre :
- Une pile graphique headless (`Xvfb` + `openbox`),
- Un gestionnaire de secrets (`dbus` + `gnome-keyring`),
- Une simulation d'identité système desktop (`lsb_release`, `hostnamectl`, vendor matériel, machine-id dynamique),
- L'application Electron Wipter qui orchestre le moteur de tunnel rathole (`wipter-tunnel`),
- L'injection automatique des identifiants (`WIPTER_EMAIL` et `WIPTER_PASSWORD`) via `xte` (xautomation) lors du premier lancement,
- La capacité `cap_add: DAC_OVERRIDE` au niveau Compose pour permettre l'écriture initiale de `/etc/machine-id` et le démarrage de `dbus`.

Par défaut, l'accès VNC/noVNC est désactivé (`ENABLE_VNC=false`) pour économiser les ressources RAM/CPU.

## Configuration & Intégration dans proxy_docker

Wipter est configuré comme provider standard multi-passerelles :

* **Profil compose** : `gw{n}-wipter`, service `wipter-{n}`,
* **Image** : `techroy23/docker-wipter:latest`,
* **Réseau** : `network_mode: "service:gateway-isp-{n}"` (acheminement transparent via le proxy amont de la passerelle),
* **Identité hôte** : simulation de nom d'hôte desktop (`GW{n}_HOSTNAME`, ex. `DESKTOP-D8F2A14`),
* **Identifiants globaux** : `WIPTER_EMAIL` et `WIPTER_PASSWORD` dans le `.env`,
* **Identifiants spécifiques par passerelle** : `GW{n}_WIPTER_EMAIL` et `GW{n}_WIPTER_PASSWORD` (optionnels, repli vers les globaux),
* **Surveillance Discord (optionnel)** :
  * `WIPTER_DISCORD_WEBHOOK` : URL du webhook Discord pour recevoir des captures d'écran périodiques de l'état de l'application cliente sans activer VNC.
  * `WIPTER_DISCORD_INTERVAL` : Intervalle en secondes entre chaque notification (défaut : 3600s).
  * Déclinaisons par passerelle : `GW{n}_WIPTER_DISCORD_WEBHOOK` et `GW{n}_WIPTER_DISCORD_INTERVAL`.
* **Activation** : `COMPOSE_PROFILES="wipter"` (ou `all`, ou `wipter,repocket,...`) puis `./scripts/start.sh`,
* **Tableau de bord** : visible sous chaque carte passerelle dans le dashboard Web (icône 🌐, lien direct vers https://wipter.com).

## Ressources système recommandées

- **RAM** : `mem_limit: 256m`, `shm_size: '256m'`. L'empreinte mémoire mesurée au repos est d'environ ~190-200 MiB par conteneur.
- **CPU** : `cpus: 0.25`. Utilisation CPU négligeable (< 0.5% au repos).
- **PIDs** : `pids_limit: 160`.

## Dépannage et Vérification

Afficher les logs de démarrage et de connexion :

```bash
docker logs -f wipter-1
```

Vérifier la consommation de ressources :

```bash
docker stats wipter-1
```

### Vérification visuelle (Discord Webhook)

Si `WIPTER_DISCORD_WEBHOOK` est renseigné dans `.env`, le conteneur poste automatiquement dans votre salon Discord une capture d'écran du bureau virtuel headless toutes les heures (ou selon `WIPTER_DISCORD_INTERVAL`). Cela permet de confirmer visuellement que le client Electron est authentifié et que le trafic circule sans nécessiter d'ouvrir un port VNC.
