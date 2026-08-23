# Multi-Passerelles : Dimensionnement & Déploiement (4 pools d'IP)

## Pourquoi 4 passerelles ?

Chaque passerelle `gateway-isp-{n}` est un **namespace réseau Docker étanche** avec
son propre `tun2socks`, son propre `dnsproxy` DoH et son propre proxy amont
(bloc `GW{n}_*` du `.env`). Les plateformes de monétisation (Pawns, Honeygain,
Repocket, PacketStream) limitent généralement à **1 appareil actif par IP publique** :
avec 4 proxys distincts, on déclare 4 appareils par plateforme et on **multiplie les
gains par 4**, chaque pool disposant de son propre quota de connexions (ex. 4 × 1000).

## Consommation mesurée (VM Azure Standard B2ats_v2 — 2 vCPU, 1 Go RAM + 1 Go swap)

| Configuration | RAM estimée | CPU moyenne | Faisabilité |
| :--- | :--- | :--- | :--- |
| 1 passerelle (actuel) | ~180 Mo | ~8 % | 🟢 Très large |
| 2 passerelles | ~320 Mo | ~15 % | 🟢 Confortable |
| 3 passerelles | ~460 Mo | ~22 % | 🟢 Recommandé |
| 4 passerelles | ~600 Mo | ~30 % | 🟡 Possible (swap 1 Go) |

## Isolation : aucun conflit entre passerelles

Chaque conteneur `gateway-isp-{n}` possède son propre namespace réseau :

- `tun0` + `198.18.0.1/15` : **par conteneur** (pas de collision)
- table de routage `0x22b` / fwmark : **par conteneur**
- `dnsproxy` sur `127.0.0.1:53` et socat sur `127.0.0.1:23320` : **par conteneur**
- aucun port publié sur l'hôte (le dashboard seul expose `8088`)

Le seul prérequis hôte : le module `/dev/net/tun` (déjà configuré par les scripts cloud-init).

## Déploiement

### 1. Configuration

```bash
cp .env.example .env
```

Renseigner pour chaque passerelle active :

```ini
ENABLED_GATEWAYS="1,2,3,4"
COMPOSE_PROFILES="all"

GW1_ISP_PROXY_HOST="proxy1.example.com"   # + PORT/USER/PASS + identifiants GW1_*
GW2_ISP_PROXY_HOST="proxy2.example.com"   # + identifiants GW2_*
GW3_ISP_PROXY_HOST="proxy3.example.com"   # + identifiants GW3_*
GW4_ISP_PROXY_HOST="proxy4.example.com"   # + identifiants GW4_*
```

> ⚠️ Les clés historiques (`ISP_PROXY_*`, `PAWNS_EMAIL`, ...) servent de **fallback
> pour la passerelle 1 uniquement** : une migration depuis l'ancien `.env` fonctionne
> sans réécrire les secrets.

### 2. Démarrage

```bash
./scripts/start.sh
# équivaut à :
docker compose --profile gw1 --profile gw2 --profile gw3 --profile gw4 --profile all up -d --build
```

### 3. Vérification

```bash
./scripts/status.sh                                   # état + IP de chaque passerelle
docker exec gateway-isp-1 curl -s https://ipinfo.io/json
docker exec gateway-isp-2 curl -s https://ipinfo.io/json
# → 4 adresses IP publiques DIFFÉRENTES
```

## Profils Docker Compose (activation)

| Profil | Services activés |
| :--- | :--- |
| `gw{n}` | passerelle `gateway-isp-{n}` uniquement |
| `gw{n}-{type}` | provider `<type>-{n}` (type ∈ earnfm, honeygain, packetstream, pawns, repocket) |

- `scripts/start.sh`, `scripts/switch_provider.sh` et le pipeline CI construisent ces
  profils automatiquement depuis `ENABLED_GATEWAYS` + `COMPOSE_PROFILES`.
- **Fail-closed** : un provider ne peut jamais être activé sans sa passerelle (sinon
  compose échoue — aucun risque de fuite sur l'IP de la VM).

## Dashboard

- Une carte par passerelle active : IP, géolocalisation, ISP, latence, santé, proxy configuré.
- Les 5 providers de chaque passerelle sous sa carte (start/stop/restart par nœud).
- Éditeur `.env` en sections repliables : **Global**, **Passerelle 1..4**, **Clés héritées**.
- Onglets logs dynamiques : System + 1 onglet par passerelle + 1 par provider.

## Watchdog et failover

Chaque passerelle surveille sa connectivité via un watchdog interne (toutes les 20s).
En cas de perte de connexion du proxy amont, le tunnel est redémarré automatiquement
(failover). Avec un proxy à IP fixe (ex. Static ISP), aucune rotation de session n'est
possible ni nécessaire : l'IP de sortie ne change pas, le watchdog ne fait que rétablir
le tunnel.

## Migration depuis la mono-passerelle

1. `git pull` sur la VM, puis `docker compose down` (supprime les anciens conteneurs
   `gateway-isp`, `pawns`, ...) — **nécessaire une seule fois** (noms changés).
2. L'ancien `.env` est relu en fallback par `gateway-isp-1` : aucun secret à recopier.
3. `./scripts/start.sh` (ou le pipeline CI) déploie `gateway-isp-1` + ses 5 providers.
4. Passer à `ENABLED_GATEWAYS="1,2"` puis `"1,2,3,4"` au fur et à mesure des proxies.
