---
trigger: model_decision
description: Comportement des providers de monétisation — Antgain, Honeygain, PacketStream, Pawns.app, Repocket — et leurs pièges
---

# Providers de monétisation

## Types supportés

| Fournisseur | Image Docker | Variables Clés (`.env`, par passerelle) |
| :--- | :--- | :--- |
| **Pawns.app** | `iproyal/pawns-cli:latest` | `GW{n}_PAWNS_EMAIL`, `GW{n}_PAWNS_PASSWORD`, `GW{n}_PAWNS_DEVICE_NAME` |
| **Repocket** | `repocket/repocket:latest` | `GW{n}_REPOCKET_EMAIL`, `GW{n}_REPOCKET_API_KEY` |
| **PacketStream** | `packetstream/psclient:latest` | `GW{n}_PACKETSTREAM_CID` |
| **Honeygain** | `honeygain/honeygain:latest` | `GW{n}_HONEYGAIN_EMAIL`, `GW{n}_HONEYGAIN_PASSWORD`, `GW{n}_HONEYGAIN_DEVICE_NAME` |
| **Antgain** | `pinors/antgain-cli:latest` | `ANTGAIN_API_KEY` *(global, partagé)*, `GW{n}_ANTGAIN_DEVICE_ID` *(UUID unique et stable)* |

## Pièges connus (retour d'expérience)

- **Antgain** : une clé API globale partagée (`ANTGAIN_API_KEY`) + un UUID de device unique et stable par passerelle (`GW{n}_ANTGAIN_DEVICE_ID`). L'image officielle `pinors/antgain-cli:latest` est utilisée directement. L'UUID doit rester fixe lors des recréations de conteneurs pour conserver l'identité du nœud sur le serveur.
- **Honeygain** : après un redémarrage, `Device with this name is already active` temporaire — auto-résorbable en quelques minutes.
- **Validation IP plateformes** : Pawns/Honeygain peuvent rejeter une IP temporairement (`tcpip-forward denied` / `Network Unusable`) — délai plateforme, pas un bug de la stack.