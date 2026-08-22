---
trigger: model_decision
description: Comportement des providers de monétisation — Proxyrack, Honeygain, PacketStream, Pawns.app, Repocket — et leurs pièges
---

# Providers de monétisation

## Types supportés

| Fournisseur | Image Docker | Variables Clés (`.env`, par passerelle) |
| :--- | :--- | :--- |
| **Pawns.app** | `iproyal/pawns-cli:latest` | `GW{n}_PAWNS_EMAIL`, `GW{n}_PAWNS_PASSWORD`, `GW{n}_PAWNS_DEVICE_NAME` |
| **Repocket** | `repocket/repocket:latest` | `GW{n}_REPOCKET_EMAIL`, `GW{n}_REPOCKET_API_KEY` |
| **PacketStream** | `packetstream/psclient:latest` | `GW{n}_PACKETSTREAM_CID` |
| **Honeygain** | `honeygain/honeygain:latest` | `GW{n}_HONEYGAIN_EMAIL`, `GW{n}_HONEYGAIN_PASSWORD`, `GW{n}_HONEYGAIN_DEVICE_NAME` |
| **Proxyrack** | `./proxyrack/Dockerfile` | `GW{n}_API_KEY`, `GW{n}_DEVICE_NAME`, `GW{n}_UUID` *(laisser vide = auto-généré)* |

## Pièges connus (retour d'expérience)

- **Proxyrack** : UUID par passerelle (volume `proxyrack_data_{n}`) ; laisser `GW{n}_UUID` vide pour l'auto-génération. API `/api/device/add` limitée à 5 requêtes/min — espacer les enregistrements.
- **Honeygain** : après un redémarrage, `Device with this name is already active` temporaire — auto-résorbable en quelques minutes.
- **Validation IP plateformes** : Pawns/Honeygain peuvent rejeter une IP temporairement (`tcpip-forward denied` / `Network Unusable`) — délai plateforme, pas un bug de la stack.