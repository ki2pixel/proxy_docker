# Guide d'installation Docker du client Wipter

## Ce que fait Wipter

Wipter rémunère le partage de bande passante résiduelle (payouts en crypto/USDT). L'application cliente officielle est distribuée sous forme de paquet desktop Electron. L'image communautaire multi-arch **`techroy23/docker-wipter:latest`** (Docker Hub, `linux/amd64` et `linux/arm64`) permet de faire tourner le client Wipter de façon isolée et headless sur un serveur Linux.

## Fonctionnement sous Docker

L'image `techroy23/docker-wipter:latest` intègre :
- Une pile graphique headless (`Xvfb` + `openbox`),
- Un gestionnaire de secrets (`dbus` + `gnome-keyring`),
- Une simulation d'identité système desktop (`lsb_release`, `hostnamectl`, vendor matériel, machine-id dynamique),
- L'application Electron Wipter qui orchestre le moteur de tunnel rathole (`wipter-tunnel`),
- L'injection automatique des identifiants (`WIPTER_EMAIL` et `WIPTER_PASSWORD`) via `xte` (xautomation) lors du premier lancement.

Par défaut, l'accès VNC/noVNC est désactivé (`ENABLE_VNC=false`) pour économiser les ressources RAM/CPU.

## Configuration & Intégration dans proxy_docker

Wipter est configuré comme provider standard multi-passerelles :

* **Profil compose** : `gw{n}-wipter`, service `wipter-{n}`,
* **Image** : `techroy23/docker-wipter:latest`,
* **Réseau** : `network_mode: "service:gateway-isp-{n}"` (acheminement transparent via le proxy amont de la passerelle),
* **Identifiants globaux** : `WIPTER_EMAIL` et `WIPTER_PASSWORD` dans le `.env`,
* **Identifiants spécifiques par passerelle** : `GW{n}_WIPTER_EMAIL` et `GW{n}_WIPTER_PASSWORD` (optionnels, repli vers les globaux),
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
