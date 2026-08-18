# Analyse Technique et Rétro-ingénierie : Image Docker Proxyrack PoP

> **Document de synthèse technique**  
> **Cible :** `proxyrack/pop:latest` (`proxyrack-pop-latest-linux-amd64.image`)  
> **Environnement d'extraction :** Système hôte sans moteur Docker (Extraction directe des couches OCI/Tar)  
> **Date de l'analyse :** Août 2026  

---

## 1. Contexte et Méthode d'Extraction Sans Docker

L'objectif était d'extraire et d'analyser l'intégralité du contenu de l'image Docker téléchargée localement sans avoir recours au démon Docker.

### 📦 Structure d'une image Docker / OCI
Une image exportée ou archivée se compose d'un fichier de métadonnées [`manifest.json`](./manifest.json) et d'un ensemble de couches (*layers*) compressées sous forme d'archives tar dans le dossier `blobs/sha256/` :

| Layer SHA256 (Préfixe) | Taille / Rôle | Contenu extrait |
| :--- | :--- | :--- |
| `b08e2ff4391ef7...` | Base OS | Distribution Ubuntu 24.04 minimale |
| `9fc0afa631d46f...` | Configuration | Création du répertoire de travail `/app` |
| `f546511a69987e...` | Code Source | Dépôt Git complet, `Dockerfile`, `run.sh` |
| `812cc003d69caf...` | Dépendances | `apt-get update` |
| `cf22521e597037...` | Mises à jour | `apt-get upgrade` |
| `362b2c8160e618...` | Paquets | `nodejs`, `wget`, `curl`, `netcat-traditional` |

---

## 2. Architecture Globale du Conteneur

L'analyse démontre que l'image Docker ne contient pas le code métier final statique. Elle agit comme un **bootstrap en cascade à 3 étages** :

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Lanceur Bash : /app/run.sh                               │
│    - Vérification réseau (point-of-presence.sock.sh:443)    │
│    - Téléchargement du superviseur JS                       │
│    - Enregistrement API optionnel (peer.proxyrack.com)      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Superviseur Node.js : script.js (désobfusqué)             │
│    - Vérification de version distante (go/version.txt)      │
│    - Téléchargement à chaud du binaire Go compilé           │
│    - Gestion du cycle de vie et redémarrage automatique     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Cœur applicatif : PoP_go (Binaire Go compilé)            │
│    - Tunneling chiffré TLS vers Proxyrack                   │
│    - Reverse Proxy TCP & UDP (Relais pair-à-pair résidentiel)│
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Analyse Détaillée des Composants

### Étage 1 : Lanceur Shell ([extracted_app/app/run.sh](./extracted_app/app/run.sh))
- **Point d'entrée du conteneur** (`ENTRYPOINT /bin/bash run.sh`).
- **Paramètres requis & optionnels** :
  - `UUID` *(Obligatoire)* : Identifiant unique du nœud.
  - `API_KEY` *(Optionnel)* : Clé d'API du compte Proxyrack.
  - `DEVICE_NAME` *(Optionnel)* : Nom d'affichage dans le dashboard (par défaut `Device-$UUID`).
- **Actions exécutées** :
  1. Test de connectivité TCP vers `point-of-presence.sock.sh` sur le port `443` via `nc -z`.
  2. Téléchargement de la dernière version du script superviseur :
     ```bash
     wget https://app-updates.sock.sh/peerclient/script/script.js
     ```
  3. Lancement du superviseur :
     ```bash
     node script.js --homeIp point-of-presence.sock.sh --homePort 443 --id $UUID --version $(curl -s https://app-updates.sock.sh/peerclient/script/version.txt) --clientKey proxyrack-pop-client --clientType PoP
     ```
  4. Si une `API_KEY` est fournie, enregistrement de l'appareil via `POST https://peer.proxyrack.com/api/device/add`.

---

### Étage 2 : Superviseur Node.js ([extracted_app/app/script_deobfuscated.js](./extracted_app/app/script_deobfuscated.js))
Le script téléchargé (1.68 Mo) est protégé par un obfusquateur JavaScript standard à table de chaînes. Après désobfuscation complète, voici son rôle :
- **Module de configuration et de mise à jour** (`module 0x64`) :
  - `exeUrl` : `https://app-updates.sock.sh/peerclient/go/client` (ou `client.exe` sous Windows).
  - `versionUrl` : `https://app-updates.sock.sh/peerclient/go/version.txt`.
  - `localVersionPath` : `./go_version.txt`.
  - `localExePath` : `./PoP_go`.
- **Mécanisme d'auto-mise à jour** :
  - Compare la version locale et distante.
  - Télécharge le binaire exécutable natif correspondant à la plateforme hôte.
  - Applique les droits d'exécution (`chmod 777`).
- **Gestion du sous-processus** :
  - Démarre le binaire via `child_process.spawn` avec les drapeaux CLI transmis (`--homeIp`, `--homePort`, `--id`, etc.).
  - Capture et journalise les flux `stdout`, `stderr` et relance le processus en cas de défaillance.

---

### Étage 3 : Cœur Applicatif Go ([extracted_app/app/PoP_go_linux](./extracted_app/app/PoP_go_linux))
L'analyse des symboles, des tables d'import et des chaînes de caractères du binaire Go compilé (5.6 Mo) met en évidence son implémentation :
- **Origine du code source** : Dépôt interne `bitbucket.org/vpn/go_client/rvrsproxy`.
- **Modules internes identifiés** :
  - `rvrsproxy.ReverseProxy` : Moteur de proxy inverse.
  - `rvrsproxy/connhandler` : Gestionnaire de connexions entrantes et sortantes.
  - `rvrsproxy/realconn` : Établissement des sockets réels vers Internet.
  - `rvrsproxy/udpproxy` & `NatHolePunch` : Traversée de pare-feu NAT et relais de paquets UDP.
- **Fonctionnement réel** :
  - Le conteneur se connecte en tant que **Point de Présence (PoP)** au réseau Proxyrack.
  - Il reçoit des demandes de routage provenant d'utilisateurs tiers du service Proxyrack et effectue les requêtes vers le web ouvert depuis votre adresse IP publique.

---

## 4. Bilan Sécurité, Réseau et Confidentialité

| Aspect | Constat technique | Niveau de risque |
| :--- | :--- | :--- |
| **Bande passante & IP** | Votre connexion Internet sert de relais de sortie public (nœud résidentiel). | ⚠️ **Élevé** (Trafic tiers attribué à votre adresse IP) |
| **Exécution dynamique** | Le code applicatif et le binaire exécutable sont téléchargés à chaud sans vérification de signature cryptographique forte. | ⚠️ **Moyen** (Dépendance totale envers l'infrastructure distante `sock.sh`) |
| **Accès Système** | Le conteneur tourne avec l'utilisateur `root` et dispose des outils réseau (`netcat`, `curl`, `wget`). | ℹ️ **Isolé si conteneurisé**, critique si exécuté directement sur l'hôte |

---

## 5. Synthèse des Composants Identifiés

- **Dockerfile & Entrypoint** : Base Ubuntu avec Node.js 20 LTS et outils réseau de base (`curl`, `wget`, `netcat`).
- **Superviseur JavaScript (`script.js`)** : Gestionnaire de cycle de vie et d'auto-mise à jour du binaire.
- **Binaire natif Go (`PoP_go`)** : Implémentation du protocole PoP et du reverse proxy pair-à-pair.
- **Implémentation locale de production** : Intégrée sous [`proxyrack/Dockerfile`](../../proxyrack/Dockerfile) et [`proxyrack/run.sh`](../../proxyrack/run.sh).
