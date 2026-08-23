---
trigger: model_decision
description: Comportement des providers de monétisation — TraffMonetizer, Honeygain, PacketStream, Pawns.app, Repocket — et leurs pièges
---

# Providers de monétisation

## Types supportés

| Fournisseur | Image Docker | Variables Clés (`.env`, par passerelle) |
| :--- | :--- | :--- |
| **Pawns.app** | `iproyal/pawns-cli:latest` | `GW{n}_PAWNS_EMAIL`, `GW{n}_PAWNS_PASSWORD`, `GW{n}_PAWNS_DEVICE_NAME` |
| **Repocket** | `repocket/repocket:latest` | `GW{n}_REPOCKET_EMAIL`, `GW{n}_REPOCKET_API_KEY` |
| **PacketStream** | `packetstream/psclient:latest` | `GW{n}_PACKETSTREAM_CID` |
| **Honeygain** | `honeygain/honeygain:latest` | `GW{n}_HONEYGAIN_EMAIL`, `GW{n}_HONEYGAIN_PASSWORD`, `GW{n}_HONEYGAIN_DEVICE_NAME` |
| **TraffMonetizer** | `traffmonetizer/cli_v2:latest` (wrapper Alpine) | `TRAFFMONETIZER_TOKEN` *(global, partagé — Dashboard → Token sur app.traffmonetizer.com)*, `GW{n}_TRAFFMONETIZER_DEVICE_NAME` |

## Pièges connus (retour d'expérience)

- **TraffMonetizer** : un token global partagé + un nom de device par passerelle (`GW{n}_TRAFFMONETIZER_DEVICE_NAME`) — image officielle sans shell, passage obligé par le wrapper `traffmonetizer/`, token en variable d'env (jamais dans `Config.Cmd` ni les logs). Aucun volume.
- **Honeygain** : après un redémarrage, `Device with this name is already active` temporaire — auto-résorbable en quelques minutes.
- **Validation IP plateformes** : Pawns/Honeygain peuvent rejeter une IP temporairement (`tcpip-forward denied` / `Network Unusable`) — délai plateforme, pas un bug de la stack.