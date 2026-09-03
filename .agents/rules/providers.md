---
trigger: model_decision
description: Comportement des providers de monétisation — Wipter, Honeygain, PacketStream, Pawns.app, Repocket — et leurs pièges
---

# Providers de monétisation

## Types supportés

| Fournisseur | Image Docker | Variables Clés (`.env`, par passerelle) |
| :--- | :--- | :--- |
| **Pawns.app** | `iproyal/pawns-cli:latest` | `GW{n}_PAWNS_EMAIL`, `GW{n}_PAWNS_PASSWORD`, `GW{n}_PAWNS_DEVICE_NAME` |
| **Repocket** | `repocket/repocket:latest` | `GW{n}_REPOCKET_EMAIL`, `GW{n}_REPOCKET_API_KEY` |
| **PacketStream** | `packetstream/psclient:latest` | `GW{n}_PACKETSTREAM_CID` |
| **Honeygain** | `honeygain/honeygain:latest` | `GW{n}_HONEYGAIN_EMAIL`, `GW{n}_HONEYGAIN_PASSWORD`, `GW{n}_HONEYGAIN_DEVICE_NAME` |
| **Wipter** | `techroy23/docker-wipter:latest` | `WIPTER_EMAIL`, `WIPTER_PASSWORD`, `GW{n}_WIPTER_EMAIL`, `GW{n}_WIPTER_PASSWORD` |

## Pièges connus (retour d'expérience)

- **Wipter** : identifiants `WIPTER_EMAIL` et `WIPTER_PASSWORD` (globaux ou par passerelle `GW{n}_WIPTER_*`). L'image `techroy23/docker-wipter:latest` utilise un environnement headless (Xvfb/Openbox/gnome-keyring) pour démarrer l'application desktop et injecter les identifiants via `xte`. VNC est désactivé par défaut (`ENABLE_VNC=false`).
- **Repocket** : état « zombie » silencieux lors de coupures de socket (`Failed to create connection: undefined` / `Peer not found`). Nécessite le watchdog `scripts/repocket_watchdog.sh` (timer systemd) pour auto-guérir via `docker restart`.
- **Validation IP plateformes** : Pawns/Honeygain peuvent rejeter une IP (`tcpip-forward denied` / `Network Unusable` / `non_residential_ip`). Sur proxys Proxiware commerciaux, Pawns quitte avec code 1 en boucle : retirer `pawns` de `COMPOSE_PROFILES` pour éviter le thrashing CPU/RAM. Honeygain `Network Unusable` peut être un délai de refroidissement après un pic de trafic ou un blocage de l'ASN.