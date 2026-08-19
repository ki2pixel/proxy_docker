# Multi-Providers Monetization Hub & Residential ISP Gateway sur Docker

Système automatisé et sécurisé de monétisation de bande passante couplant une **passerelle réseau résidentielle / ISP dédiée** et **5 fournisseurs de monétisation** (Proxyrack, Honeygain, PacketStream, Pawns.app, Repocket) au sein d'un environnement Docker isolé avec bascule à chaud, watchdog d'auto-guérison et tableau de bord Web.

---

## 1. Architecture Réseau, Sécurité & Auto-Guérison

L'architecture repose sur l'isolation réseau totale de chaque nœud de monétisation grâce au partage d'espace de noms réseau (`network_mode: service:gateway-isp`). Tout le trafic L3/L4 des conteneurs est capturé et acheminé de manière transparente via `tun2socks` et un résolveur DNS-over-HTTPS chiffré (`dnsproxy`) vers un proxy amont ISP / Résidentiel.

```mermaid
graph TD
    subgraph Docker ["Environnement Docker (Local ou Cloud Azure)"]
        subgraph NetNamespace ["Namespace Réseau Partagé (network_mode: service:gateway-isp)"]
            
            subgraph GatewayContainer ["Conteneur : gateway-isp"]
                TUN["Interface Virtuelle tun0<br>(198.18.0.1/15)"]
                T2S["Moteur Transparent Proxy (tun2socks)<br>• Capture L3 transparente<br>• Routage de stratégie (table 0x22b)"]
                DOH["Résolveur DNS-over-HTTPS (dnsproxy)<br>• Port 127.0.0.1:53 (Cloudflare/Google DoH)<br>• Bypasses stricts anti-fuite DNS"]
                WD["🛡️ Watchdog d'Auto-Guérison<br>• Failover perte de connexion (3s)<br>• Rotation préventive (50 min)<br>• Auto-rotation au boot"]
                SOCAT["Pont Local TCP/SOCKS5 (socat)<br>0.0.0.0:23320 -> Proxy Amont"]
            end
            
            subgraph ProvidersContainers ["5 Fournisseurs de Monétisation Conteneurisés"]
                PR["proxyrack-pop (Node.js / Go Core v60)"]
                HG["honeygain (honeygain/honeygain)"]
                PS["packetstream (packetstream/psclient)"]
                PA["pawns (iproyal/pawns-cli)"]
                RP["repocket (repocket/repocket)"]
            end
        end

        subgraph DashboardContainer ["Conteneur : isp-dashboard"]
            DASH["Superviseur Express.js & WebSocket (Port :8088)<br>• Docker Engine Socket (/var/run/docker.sock)<br>• Métriques & Géolocalisation en direct<br>• Bouton 1-Clic de Rotation d'IP"]
        end

        UPSTREAM["Proxy Résidentiel / Static ISP Amont<br>(FlameProxies, PrivateProxy, etc.)"]
        INTERNET["Web Public (Trafic Monétisé Sortant)"]
    end

    PR -->|Trafic sortant PoP| TUN
    HG -->|Trafic sortant Honeygain| TUN
    PS -->|Trafic sortant PacketStream| TUN
    PA -->|Trafic sortant Pawns| TUN
    RP -->|Trafic sortant Repocket| TUN

    TUN --> T2S
    T2S -->|Encapsulation SOCKS5 / TCP| UPSTREAM
    UPSTREAM -->|Sortie sous IP Résidentielle / ISP| INTERNET

    WD -->|Surveillance & Auto-Rotation de session| T2S
    DASH -->|Pilotage à chaud via Docker Socket| ProvidersContainers
    DASH -->|Surveillance Santé & Déclencheur Rotation| GatewayContainer
```

### Points Clés de l'Architecture :
* 🛡️ **Isolation 100% Garantie (Kill-Switch / Zéro Fuite)** : Le trafic des conteneurs ne touche jamais la connexion IP personnelle ou l'IP publique du serveur hôte. Si le proxy amont tombe, le trafic est instantanément bloqué.
* 🔄 **Watchdog d'Auto-Guérison (Self-Healing)** : Détecte les déconnexions de sessions résidentielles et génère automatiquement une nouvelle session active en 3 secondes.
* ⏰ **Rotation Préventive (50 min)** : Anticipe la limite des sessions temporaires de 60 minutes pour assurer un service ininterrompu 24h/24.
* ⚡ **DNS-over-HTTPS (DoH)** : Prévention absolue des fuites DNS grâce au résolveur local `dnsproxy` routé via DoH Cloudflare / Google / Quad9.
* 📊 **Tableau de Bord & API en Temps Réel** : Suivi des métriques de connexion, logs en continu (SSE) et pilotage individuel des conteneurs via interface Web (port `8088`).

---

## 2. Fournisseurs de Monétisation Supportés

| Fournisseur | Image Docker | Variables Clés (`.env`) | Tableau de Bord | Comportement & Validation en Production |
| :--- | :--- | :--- | :--- | :--- |
| **Pawns.app** | `iproyal/pawns-cli:latest` | `PAWNS_EMAIL`, `PAWNS_PASSWORD`, `PAWNS_DEVICE_NAME` | [pawns.app](https://pawns.app) | 🟢 **100% Actif** (IP reconnue comme résidentielle au tarif plein $0.20/GB). |
| **Repocket** | `repocket/repocket:latest` | `REPOCKET_EMAIL`, `REPOCKET_API_KEY` | [repocket.com](https://repocket.com) | 🟢 **100% Actif** (Pair connecté avec succès, échange de paquets réels validé). |
| **PacketStream** | `packetstream/psclient:latest` | `PACKETSTREAM_CID` | [packetstream.io](https://packetstream.io) | 🟢 **100% Opérationnel** (Tunnel actif, trafic relayé et comptabilisé en direct). |
| **Honeygain** | `honeygain/honeygain:latest` | `HONEYGAIN_EMAIL`, `HONEYGAIN_PASSWORD`, `HONEYGAIN_DEVICE_NAME` | [dashboard.honeygain.com](https://dashboard.honeygain.com) | 🟢 **100% Connecté** (Authentification réussie, rafraîchissement périodique). |
| **Proxyrack** | `./proxyrack/Dockerfile` | `API_KEY`, `DEVICE_NAME`, `UUID` *(optionnel)* | [peer.proxyrack.com](https://peer.proxyrack.com) | 🟢 **100% Connecté** (Génération d'UUID persisté sur volume et auto-enregistrement API). |

---

## 3. Déploiement Cloud sur Microsoft Azure (750h/mois Gratuites)

Le projet est optimisé pour tourner **24h/24 et 7j/7 gratuitement** sur Microsoft Azure.

### Spécifications Recommandées :
* **Instance** : `Standard B2ats_v2` (2 vCPUs AMD EPYC, 1 Go RAM, burstable).
* **Système d'exploitation** : `Debian 13 "Trixie"` x64 (empreinte minimale : ~65 Mo RAM au repos).
* **Consommation mesurée de la stack** : **106,7 MiB RAM** et **8,46% CPU** *(très en dessous de la ligne de base de 20% CPU, accumulant continuellement des crédits processeur)*.

### 🚀 Déploiement en 1 Commande sur Azure :
Connectez-vous à votre VM Azure et lancez le script d'initialisation :
```bash
sudo curl -fsSL https://raw.githubusercontent.com/ki2pixel/proxy_docker/main/scripts/azure_cloud_init.sh | sudo bash
```

Ce script configure automatiquement :
1. Fichier de Swap SSD de 1 Go.
2. Module noyau `/dev/net/tun` et `CAP_NET_ADMIN`.
3. Installation officielle de Docker CE & Docker Compose.
4. Clonage du projet dans `/opt/proxy_docker` et démarrage automatique.

### 🌐 Déblocage du Tableau de Bord (Port 8088) :
Sur le [Portail Azure](https://portal.azure.com/) ➔ Votre VM ➔ **Mise en réseau** ➔ **Ajouter une règle de port entrant** :
* Port de destination : `8088`
* Protocole : `TCP`
* Action : `Autoriser`
* Tableau de bord disponible sur : `http://<IP_PUBLIQUE_AZURE>:8088`

---

## 4. Démarrage Rapide en Local

### Prérequis
* Docker Engine 20.10+ et Docker Compose v2+
* Noyau Linux avec module TUN actif (`/dev/net/tun`).

### Étape 1 : Configuration (`.env`)
```bash
cp .env.example .env
```

Éditez le fichier `.env` pour renseigner vos identifiants :
```ini
# Port du tableau de bord Web
DASHBOARD_PORT=8088

# Fournisseurs actifs : proxyrack | honeygain | packetstream | pawns | repocket | all
COMPOSE_PROFILES="all"

# --- Passerelle ISP / Residential Dédiée ---
ISP_PROXY_PROTOCOL="socks5"
ISP_PROXY_HOST="proxy.flameproxies.com"
ISP_PROXY_PORT="1080"
ISP_PROXY_USER="votre_identifiant_session"
ISP_PROXY_PASS="votre_mot_de_passe"
GATEWAY_LOGLEVEL="warn"

# --- Auto-Rotation & Watchdog ---
AUTO_ROTATE_SESSION="true"
AUTO_ROTATE_INTERVAL="50"

# --- Identifiants Fournisseurs de Monétisation ---
API_KEY="votre_cle_api_proxyrack"
HONEYGAIN_EMAIL="votre_email_honeygain"
HONEYGAIN_PASSWORD="votre_mot_de_passe"
PACKETSTREAM_CID="votre_customer_id"
PAWNS_EMAIL="votre_email_pawns"
PAWNS_PASSWORD="votre_mot_de_passe"
REPOCKET_EMAIL="votre_email_repocket"
REPOCKET_API_KEY="votre_cle_api_repocket"
```

### Étape 2 : Lancement
```bash
./scripts/start.sh
```
Ou directement :
```bash
docker compose up -d --build
```

Tableau de bord Web : **[http://localhost:8088](http://localhost:8088)**.

---

## 5. Scripts Utilitaires & Automatisation

| Script | Description |
| :--- | :--- |
| [`scripts/sync_env.sh`](scripts/sync_env.sh) | **Synchronise le `.env` local vers la VM Azure** et relance la stack en 2 secondes. |
| [`scripts/azure_cloud_init.sh`](scripts/azure_cloud_init.sh) | Script cloud-init d'installation automatique pour VM Azure Debian 13. |
| [`scripts/rotate_ip.sh`](scripts/rotate_ip.sh) | Déclenche une rotation manuelle immédiate de la session résidentielle. |
| [`scripts/status.sh`](scripts/status.sh) | Affiche l'état complet des conteneurs, le statut de la passerelle et la géolocalisation de l'IP. |
| [`scripts/test_isp_proxy.sh`](scripts/test_isp_proxy.sh) | Teste la connectivité du proxy amont via le port de test local `23321`. |
| [`scripts/switch_isp_proxy.sh`](scripts/switch_isp_proxy.sh) | Bascule à chaud le proxy amont (`./scripts/switch_isp_proxy.sh <HOST:PORT> [socks5|http]`). |
| [`scripts/benchmark.sh`](scripts/benchmark.sh) | Lance un benchmark en temps réel mesurant la RAM, le CPU et les PIDs de la stack. |

---

## 6. Déploiement Continu (CI/CD GitHub Actions)

Le fichier [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) déploie automatiquement chaque mise à jour sur votre VM Azure lors d'un `git push origin main`.

### Configuration des Secrets GitHub :
Dans votre dépôt GitHub (***Settings ➔ Secrets and variables ➔ Actions***), ajoutez :
* `AZURE_HOST_IP` : L'adresse IP publique de votre VM Azure (ex: `68.210.184.174`).
* `AZURE_SSH_KEY` : Le contenu intégral de votre clé privée SSH (`ProxyMonetisation_key.pem`).
* `AZURE_USERNAME` *(optionnel)* : `azureuser` (par défaut).

---

## 7. Documentation Technique Approfondie

* 📄 [Évaluation Déploiement Stack Docker sur Azure](docs/Recherches/Évaluation_Stack_Docker_sur_Azure.md) : Analyse Hyper-V, TUN/TAP, dimensionnement VM série B, quotas de bande passante et sécurité.
* 📄 [Guide d'Intégration Passerelle ISP / Static Residential](docs/Integration_Passerelle_ISP_Residential.md) : Comparatif des fournisseurs de proxys et guide d'optimisation.
* 📄 [Rapport de Recherche sur le Routage Docker](docs/Recherches/Routage_Docker_Monétisation_Bande_Passante.md) : Analyse des solutions Dongle 4G, VPN Dédiés et Proxies ISP.
