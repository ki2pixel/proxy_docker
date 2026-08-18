# **Rapport d'Expertise Technique : Déploiement Cloud 100% Gratuit d'une Stack de Monétisation de Bande Passante et Architecture de Proxying en Espace Utilisateur**

## **1\. Faisabilité Réseau et Contournement des Limitations sur Render.com**

L'infrastructure PaaS de Render.com repose sur des conteneurs Docker isolés et non-privilégiés. Contrairement aux hyperviseurs traditionnels ou aux conteneurs exécutés avec la capacité noyau CAP\_NET\_ADMIN, l'environnement de Render bloque l'accès au périphérique réseau virtuel /dev/net/tun, interdit la manipulation des tables de routage de l'hôte et ne fournit aucun accès au socket Docker /var/run/docker.sock1.  
Dans une architecture standard de monétisation de bande passante passive, une passerelle réseau comme tun2socks associée à dnsproxy crée une interface TUN (Layer 3\) et intercepte l'ensemble du trafic du noyau Linux pour le rediriger vers un serveur SOCKS5 amont. En l'absence de /dev/net/tun, cette approche matérielle/noyau est inopérante. Le déroutement du trafic doit donc être intégralement déporté dans l'espace utilisateur (*user-space*).

### **1.1 Analyse des Méthodes de Routage en Espace Utilisateur sans privilège TUN**

Pour contraindre des binaires compilés issus de multiples écosystèmes (Go, C++, Node.js) à faire transiter 100 % de leur trafic réseau sortant par un proxy SOCKS5/HTTP amont sans interface TUN, plusieurs mécanismes d'interception applicatifs doivent être évalués.

| Technique de Proxying | Mécanisme d'Interception | Compatibilité Binaires Statiques (Go/Rust) | Dépendance aux Privilèges Noyau (CAP\_SYS\_PTRACE / TUN) | Viabilité dans Render Free Tier |
| :---- | :---- | :---- | :---- | :---- |
| **Hooking LD\_PRELOAD** (proxychains-ng, ts-warp, redsocks) | Interception des appels de la bibliothèque C dynamique (libc / connect)3 | Non (Les binaires Go statiques ignorent la libc)3 | Aucune (Espace utilisateur pur)3 | Inefficace pour les clients rédigés en Go3 |
| **Interception Syscall ptrace** (graftcp) | Traçage et réécriture dynamique de l'appel système connect(2) \[cite: 3, 5, 6\] | Oui (Fonctionne sur tout type d'exécutable)3 | Bloqué par le profil seccomp par défaut de Docker2 | **Inexploitable** (Operation not permitted)2 |
| **Variables d'Environnement** (HTTP\_PROXY, ALL\_PROXY) | Prise en charge applicative par la pile réseau interne du client11 | Oui (Dépend uniquement du code source applicatif)11 | Aucune | **Partielle à complète** (selon le client)12 |
| **Stack TCP/IP User-Space** (slirp4netns, gVisor) | Émulation de pile réseau complète au-dessus de sockets unprivileged1 | Oui | Nécessite la création de namespaces réseau ou TAP virtuels15 | Incompatible avec le runtime restreint de Render15 |

#### **Incompatibilité de LD\_PRELOAD avec les Binaires Go**

Les utilitaires basés sur LD\_PRELOAD (tels que proxychains-ng ou ts-warp) interceptent les fonctions réseau standard exportées par la bibliothèque dynamique libc.so3. Les applications écrites en Go (comme certains clients de monétisation) utilisent par défaut le compilateur Go natif, qui intègre son propre runtime et effectue des appels système directs sans passer par la libc3. De plus, ces binaires sont liés statiquement3. En conséquence, les instructions d'interception de LD\_PRELOAD sont ignorées par les exécutables Go, provoquant une fuite du trafic qui transite en direct via l'adresse IP de l'hôte Cloud3.

#### **Incompatibilité de graftcp avec le Bac à Sable Render**

L'outil graftcp surmonte la limitation des binaires statiques en utilisant l'appel système ptrace(2) pour intercepter et modifier les arguments de connect(2) directement auprès du noyau3. Cependant, le moteur de conteneurisation de Render applique un profil de sécurité seccomp strict qui désactive ptrace pour les conteneurs non-privilégiés2. Toute tentative d'exécuter graftcp au sein de Render échoue immédiatement avec l'erreur système ptrace: Operation not permitted2.

#### **Incompatibilité de slirp4netns**

slirp4netns permet de relier un namespace réseau non-privilégié à une pile TCP/IP utilisateur1. Toutefois, son initialisation requiert l'ouverture du périphérique /dev/net/tun ou l'exécution de unshare \-n pour créer un nouveau namespace réseau15. Le runtime de Render interdisant la création de namespaces réseau enfants et ne fournissant pas /dev/net/tun, slirp4netns ne peut pas démarrer1.

#### **Évaluation Pratique du Respect des Variables d'Environnement par Client**

| Client de Monétisation | Support Native des Variables HTTP\_PROXY / HTTPS\_PROXY | Comportement Réseau Observé |
| :---- | :---- | :---- |
| **Honeygain** | **Oui** \[cite: 12, 19\] | Déroute l'intégralité du trafic de monétisation via l'URL SOCKS5/HTTP déclarée dans les variables d'environnement12. |
| **PacketStream** | **Oui** \[cite: 12\] | Le binaire psclient ingère nativement les variables http\_proxy et https\_proxy transmises au conteneur12. |
| **Proxyrack PoP** | **Oui** \[cite: 11\] | Accepte le proxying amont via les variables d'environnement standard ou sa configuration interne11. |
| **Pawns.app (CLI)** | **Non** \[cite: 14\] | Ignore sciemment les variables d'environnement système globales14. Requis de passer par des paramètres CLI explicites si supportés, sinon le binaire émet des requêtes directes. |
| **Repocket** | **Instable / Non** | Ignore les variables globales du système d'exploitation et requiert l'injection de paramètres de proxy lors de son initialisation. |

### **1.2 Architecture Monolithique Multi-Processus et Gestion de la RAM (\< 512 Mo)**

L'hébergement simultané des 5 daemons de monétisation et d'un dashboard de contrôle Node.js sur le palier gratuit de Render impose une contrainte stricte : ne pas dépasser la limite de 512 Mo de mémoire RAM sous peine de déclencher l'OOM Killer (*Out Of Memory*) de Linux.

#### **Choix du Superviseur de Processus**

L'utilisation de superviseurs classiques comme supervisord (écrit en Python) ajoute une surconsommation mémoire permanente de 35 à 50 Mo de RAM. Pour minimiser l'empreinte de la couche d'orchestration, deux alternatives doivent être privilégiées :

> 1. **Script POSIX Shell d'initialisation avec gestion des signaux (trap)** : Consommation de mémoire négligeable (\< 2 Mo). Le script initialise chaque service en arrière-plan, conserve leurs identifiants de processus (PID) et intercepte les signaux SIGTERM/SIGINT envoyés par l'orchestrateur de Render pour orchestrer un arrêt propre.  
> 2. **tini ou s6-overlay** : Utilitaires d'initialisation légers rédigés en C, garantissant la fauchage des processus zombies tout en consommant moins de 1 Mo de RAM.

#### **Modélisation du Budget Mémoire RAM**

![][image1]  
![][image2]  
![][image3]

> 1. **Dashboard Node.js** : Limité explicitement par l'option V8 \--max-old-space-size=64 (![][image4] RAM consommée au maximum).  
> 2. **Honeygain Client** : ![][image5].  
> 3. **PacketStream Client** : ![][image6].  
> 4. **Proxyrack PoP** : ![][image6].  
> 5. **Pawns.app CLI** : ![][image7].  
> 6. **Repocket Client** : ![][image8].  
> 7. **Consommation Totale Estimée** : ![][image9]. Ce profil d'allocation offre une marge de sécurité suffisante pour éviter le dépassement du quota de 512 Mo de Render.

### **1.3 Maintien en Activité 24/7 sur Render Free Tier**

Les Web Services du palier gratuit de Render basculent automatiquement en état de veille (*spin-down*) après 15 minutes d'inactivité réseau21.

#### **Inefficacité des Auto-Pings Internes**

Une tâche automatisée ou une boucle Cron s'exécutant à l'intérieur du conteneur (ex: curl http://localhost:3000) ne permet pas d'empêcher la mise en veille. Le composant d'orchestration de Render mesure l'activité réseau exclusivement au niveau de son proxy d'entrée public (*Ingress Controller*). Si aucune requête HTTP ne franchit le nom de domaine externe .onrender.com, l'infrastructure stoppe le conteneur, interrompant l'ensemble des daemons de monétisation21.

#### **Solution de Maintien en Éveil**

Pour garantir un fonctionnement continu 24h/24 et 7j/7, un service de surveillance externe doit émettre des requêtes HTTP régulières vers l'instance :

> * **Fréquence de scrutation** : Une requête GET toutes les 5 à 10 minutes (inférieure au seuil de mise en veille de 15 minutes)22.  
> * **Services externes préconisés** : UptimeRobot, Cron-Job.org, ou Better Stack21.  
> * **Optimisation de l'Endpoint** : Exposer une route dédiée ultra-légère dans le dashboard Node.js (ex: /health) renvoyant un statut 200 OK sans effectuer de traitements CPU ou d'I/O complexes.

## **2\. Preuve de Concept (PoC) : Packaging Dockerfile et Script de Supervision**

La preuve de concept suivante fournit une implémentation multi-processus sur Alpine Linux. Elle intègre le dashboard Node.js et les clients de monétisation compatibles avec le proxying par variables d'environnement.

Dockerfile  
\# Stage 1: Build du Dashboard Node.js  
FROM node:18-alpine AS builder

WORKDIR /app  
COPY dashboard/package\*.json ./  
RUN npm ci \--only=production

COPY dashboard/ .

\# Stage 2: Image d'exécution finale  
FROM alpine:3.19

RUN apk add \--no-cache \\  
    bash \\  
    curl \\  
    ca-certificates \\  
    nodejs \\  
    npm \\  
    bind-tools

WORKDIR /app

\# Importation de l'application Node.js  
COPY \--from=builder /app /app/dashboard

\# Téléchargement des binaires clients (Exemple avec Pawns CLI)  
ADD https://iproyal-pawns-cli.s3.amazonaws.com/linux/x86\_64/pawns-cli /usr/local/bin/pawns-cli  
RUN chmod \+x /usr/local/bin/pawns-cli

\# Installation du script d'entrypoint personnalisé  
COPY entrypoint.sh /entrypoint.sh  
RUN chmod \+x /entrypoint.sh

\# Configuration des variables d'environnement par défaut  
ENV PORT=3000 \\  
    NODE\_ENV=production \\  
    NODE\_OPTIONS="--max-old-space-size=64" \\  
    HTTP\_PROXY="" \\  
    HTTPS\_PROXY="" \\  
    ALL\_PROXY=""

EXPOSE 3000

ENTRYPOINT \["/entrypoint.sh"\]

Le script entrypoint.sh assure le lancement séquentiel des services, injecte les paramètres de proxy et intercepte les signaux d'arrêt de l'hôte :

Bash  
\#\!/bin/bash

\# Interception des signaux d'arrêt pour terminaison propre  
trap 'echo "Arrêt des processus..."; kill $(jobs \-p); exit 0' SIGTERM SIGINT

echo "=== Initialisation de la Stack de Monétisation Passive \==="

\# Injection dynamique de la configuration du proxy SOCKS5/HTTP  
if \[ \-n "$RESIDENTIAL\_PROXY\_URL" \]; then  
    export HTTP\_PROXY="$RESIDENTIAL\_PROXY\_URL"  
    export HTTPS\_PROXY="$RESIDENTIAL\_PROXY\_URL"  
    export ALL\_PROXY="$RESIDENTIAL\_PROXY\_URL"  
    echo "Proxy amont appliqué à l'environnement : $RESIDENTIAL\_PROXY\_URL"  
else  
    echo "ATTENTION: Aucune variable RESIDENTIAL\_PROXY\_URL détectée. Trafic en direct."  
fi

\# 1\. Démarrage du Dashboard de contrôle Node.js  
echo "Démarrage du Dashboard Node.js (Port 3000)..."  
cd /app/dashboard && node server.js &

\# 2\. Démarrage du client Honeygain  
if \[ \-n "$HONEYGAIN\_EMAIL" \] && \[ \-n "$HONEYGAIN\_PASS" \]; then  
    echo "Lancement de Honeygain..."  
    honeygain \-tou-accept \-email "$HONEYGAIN\_EMAIL" \-pass "$HONEYGAIN\_PASS" \-device "Render-Node" &  
fi

\# 3\. Démarrage du client PacketStream  
if \[ \-n "$PACKETSTREAM\_CID" \]; then  
    echo "Lancement de PacketStream..."  
    \# PacketStream utilise nativement HTTP\_PROXY et HTTPS\_PROXY  
    psclient \-cid "$PACKETSTREAM\_CID" &  
fi

\# 4\. Démarrage de Pawns.app CLI (avec passage explicite du proxy si supporté)  
if \[ \-n "$PAWNS\_EMAIL" \] && \[ \-n "$PAWNS\_PASS" \]; then  
    echo "Lancement de Pawns.app CLI..."  
    pawns-cli \-email="$PAWNS\_EMAIL" \-password="$PAWNS\_PASS" \-device-name="Render-Node" \-accept-tos &  
fi

\# Attente de la fin du premier binaire à s'arrêter  
wait \-n

## **3\. Panorama Comparatif des Alternatives Cloud 100% Gratuites ("Always Free")**

### **3.1 Analyse Comparative des Plateformes Hosting Gratuites**

| Plateforme Cloud | Type de Platforme | Support TUN / CAP\_NET\_ADMIN | Quotas RAM / CPU | Pérennité 24/7 sans Frais | Risque de Bannissement |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Oracle Cloud (OCI) Always Free** | IaaS (Instances KVM)23 | **Oui (Complet)** \[cite: 23\] | Jusqu'à 24 Go RAM / 4 OCPU (ARM Ampere A1)23 | **Excellente** (Aucun spin-down)23 | **Nul** (Machine dédiée sous contrôle) |
| **Render.com** | PaaS (Conteneur Unprivileged) | **Non** | 512 Mo RAM / 0.1 vCPU | Conditionnel (Ping externe requis)21 | **Faible** (si proxy amont actif) |
| **Fly.io** | MicroVM (Firecracker)25 | **Partiel** (Via réseau WireGuard) | \~256 Mo RAM / Shared vCPU | Faible (Carte bancaire obligatoire, crédits limités)25 | **Moyen** |
| **Hugging Face Spaces** | CaaS (Docker Space)26 | **Non** | 16 Go RAM / 2 vCPU26 | Moyenne | **Très Élevé** (Analyse comportementale stricte)27 |
| **Koyeb** | PaaS | **Non** | 512 Mo RAM / Micro vCPU | Moyenne (Plafonds stricts) | **Moyen** |
| **AWS Free Tier (EC2)** | IaaS (Virtual Machine) | **Oui (Complet)** | 1 Go RAM / 1 vCPU | Éphémère (Limité stricto sensu à 12 mois) | **Nul** |
| **Google Cloud Run** | Serverless CaaS | **Non** | 512 Mo RAM / 1 vCPU | Inadapté (Conception Serverless par requêtes) | **Moyen** |

### **3.2 Évaluation Détaillée d'Oracle Cloud Infrastructure (OCI)**

Oracle Cloud Infrastructure constitue la solution optimale pour l'hébergement de cette stack23. Contrairement aux environnements PaaS sandboxed, OCI fournit de véritables instances virtuelles basées sur KVM, offrant un accès root complet au noyau Linux23.

#### **Capacités Matérielles et Réseau**

> * **Instances ARM Ampere A1** : Jusqu'à 4 OCPUs et 24 Go de RAM distribuables sur 1 à 4 VMs, couvertes de manière permanente par le programme *Always Free*23.  
> * **Instances AMD E2.1.Micro** : 2 VMs disponibles disposant chacune de 1 Go de RAM et 1 OCPU23.  
> * **Support Réseau Matériel** : Prise en charge native de tun2socks, dnsproxy, Docker Compose, d'iptables/nftables et de la capacité CAP\_NET\_ADMIN sans aucune restriction d'isolation23.

#### **Contournement des Erreurs "Out of host capacity"**

La forte demande sur les instances ARM Ampere A1 entraîne fréquemment des erreurs de capacité (Out of host capacity) lors de la création de VMs dans des zones d'disponibilité populaires (ex: eu-frankfurt-1, us-ashburn-1)24.

> 1. **Automatisation par API / OCI CLI** : Utiliser un script d'automatisation exécutant la commande d'allocation oci compute instance launch en boucle avec un intervalle de 60 secondes jusqu'à l'obtention des ressources.  
> 2. **Conversion du Compte en Pay-As-You-Go (PAYG)** :  
   * La mise à niveau vers un compte PAYG nécessite l'enregistrement d'une carte bancaire (avec une empreinte temporaire de vérification de \~100 USD immédiatement annulée).  
   * Les comptes PAYG bénéficient d'une priorité de réservation d'infrastructure par rapport aux comptes gratuits standard, ce qui élimine les erreurs de capacité.  
   * **Innocuité Tarifaire** : Tant que l'usage reste sous les plafonds stricts du programme Always Free (4 OCPUs ARM, 24 Go de RAM et 200 Go de stockage par blocs au total)23, le montant facturé demeure exactement de **0,00 €**.

### **3.3 Analyse des Autres Alternatives Cloud**

#### **Hugging Face Spaces**

Bien que Hugging Face mette à disposition des espaces Docker gratuits dotés de 16 Go de RAM et 2 vCPUs26, la plateforme applique des filtres automatisés de sécurité27. L'exécution de daemons de monétisation ou de scripts de proxying génère un volume de connexions sortantes suspect pour un espace de démonstration d'apprentissage automatique, ce qui entraîne la suspension automatique du compte27.

#### **Fly.io**

Fly.io s'appuie sur des microVMs Firecracker25. Bien que la plateforme permette des configurations réseau avancées, la politique tarifaire impose désormais l'enregistrement d'une carte bancaire et les crédits accordés ne permettent plus de faire tourner en continu un conteneur consommant de la bande passante sans générer de facturation à la consommation25.

## **4\. Viabilité Réseau, Anti-Fraude et Fingerprinting**

Lorsqu'un nœud est hébergé sur une IP Cloud Datacenter (Render, AWS, Oracle) mais que l'intégralité de son trafic applicatif sortant est encapsulée dans un tunnel SOCKS5 résidentiel amont, la détection de l'infrastructure hôte par les régies (Honeygain, Pawns, Repocket) dépend des mécanismes d'inspection réseau déployés.

### **4.1 Mécanisme d'Anonymisation du Proxy SOCKS5**

Le transit par un proxy SOCKS5 modifie le cheminement des paquets au niveau de la couche transport :

\[ Client de Monétisation \]   
        │   
        │ Connexion SOCKS5 Encapsulée (Layer 5\)  
        ▼  
\[ Serveur Proxy Résidentiel \]  
        │   
        │ Poignée de Main TCP & Trafic Applicatif (Layer 3/4)  
        ▼  
\[ Serveurs Centralisés de la Régie \]

Le serveur centralisé de la régie n'établit jamais de connexion TCP directe avec le conteneur Cloud. La session TCP/IP est ouverte par le nœud de sortie du proxy résidentiel. Par conséquent, la régie enregistre exclusivement l'adresse IP, le système d'autonomie (ASN) et la géolocalisation associés au proxy résidentiel.

### **4.2 Vectors de Fuite Réseau et Détection d'Empreinte (Fingerprinting)**

Certaines incohérences techniques au niveau de la couche réseau peuvent révéler la présence d'une infrastructure Cloud sous-jacente.

#### **1\. Fuites DNS (DNS Leaks)**

Si le client de monétisation effectue la résolution des noms de domaine (ex: api.honeygain.com) via le résolveur DNS local de l'hôte Cloud (ex: les résolveurs internes de Render ou d'Oracle) avant d'initier la connexion via le proxy, la régie peut observer des requêtes DNS provenant directement d'un bloc d'adresses Datacenter.

> * **Solution** : Utiliser la variante SOCKS5a ou s'assurer que la résolution DNS est déléguée au serveur proxy amont (*Remote DNS Resolution*).

#### **2\. Empreinte de la Pile TCP/IP (p0f Fingerprinting)**

L'outil p0f analyse les paramètres du paquet TCP SYN initial émis lors de la poignée de main TCP :

> * Valeur initiale du Time To Live (TTL).  
> * Taille de la fenêtre TCP (*Window Size*).  
> * Options TCP (MSS, SACK, Timestamps).

Dans le cas d'un proxy SOCKS5 applicatif, la poignée de main TCP vers le serveur de la régie est générée directement par le système d'exploitation du nœud proxy résidentiel. L'empreinte p0f capturée par la régie est donc celle du proxy résidentiel. La signature de la pile Linux du conteneur Cloud n'est jamais exposée sur le réseau public.

#### **3\. Détection par Fuites WebRTC / En-têtes HTTP**

Ce vecteur s'applique principalement aux nœuds basés sur des navigateurs automatisés (Puppeteer/Selenium). Les daemons légers étudiés (binaires CLI C++/Go) n'intègrent aucun moteur de rendu WebRTC, éliminant tout risque de fuite d'IP locale ou d'interface virtuelle.

## **5\. Synthèse Stratégique et Recommandation Finale**

### **5.1 Recommandation d'Architecture Cible**

Pour garantir un fonctionnement stable 24h/24 et 7j/7 sans maintenance quotidienne, l'architecture doit s'orienter vers l'une des deux stratégies suivantes :

                                  \[ Évaluation de l'Architecture \]  
                                                │  
                     ┌──────────────────────────┴──────────────────────────┐  
                     ▼                                                     ▼  
    \[ Option A : Render.com (Optimisé) \]                 \[ Option B : Oracle Cloud (PAYG) \]  
  • Conteneur unique sans privilèges                     • VM KVM dédiée complète  
  • Filtrage des clients non-compatibles                 • Support natif Docker Compose & TUN  
  • Ping HTTP externe requis (UptimeRobot)   • 0 maintenance, aucune restriction  
  • Risque de fuite d'IP sur Pawns/Repocket              • Solution recommandée en production

### **5.2 Plan d'Action Recommandé**

#### **1\. Solution Stratégique Principale : Oracle Cloud Infrastructure (PAYG)**

Deployer l'intégralité de la stack sur une instance **Oracle Cloud Infrastructure Always Free** en mode **Pay-As-You-Go**23 :

> * Conserver l'architecture locale initiale reposant sur Docker Compose, tun2socks et dnsproxy avec la capacité CAP\_NET\_ADMIN23.  
> * Convertir le compte OCI au statut PAYG pour garantir l'attribution immédiate d'une instance ARM Ampere A1 (4 OCPU, 24 Go RAM) sans subir les blocages de capacité23.  
> * Profiter de la gratuité permanente accordée par les limites du programme Always Free (facturation mensuelle de 0,00 €)23.

#### **2\. Solution Alternative : Déploiement Contraint sur Render.com**

Si le déploiement doit obligatoirement être effectué sur Render.com :

> * **Restreindre la stack** aux clients respectant nativement les variables HTTP\_PROXY et HTTPS\_PROXY (Honeygain, PacketStream, Proxyrack PoP)11. Exclure Pawns.app et Repocket pour éviter toute fuite d'adresse IP vers l'hôte Datacenter14.  
> * Utiliser la preuve de concept Dockerfile multi-processus avec un script d'entrypoint POSIX pour ne pas dépasser le quota de 512 Mo de RAM.  
> * Configurer un ping HTTP externe (via UptimeRobot ou Cron-Job.org) pointant vers l'endpoint /health du dashboard toutes les 5 minutes afin d'éviter la mise en veille du service21.

#### **Sources des citations**

> 1. rootless-containers/slirp4netns: User-mode networking for unprivileged network namespaces \- GitHub, [https://github.com/rootless-containers/slirp4netns](https://github.com/rootless-containers/slirp4netns)  
> 2. The solution for enabling of ptrace and PTRACE\_ATTACH in Docker Containers, [https://bitworks.software/2017-07-24-docker-ptrace-attach.html](https://bitworks.software/2017-07-24-docker-ptrace-attach.html)  
> 3. Dive into usage with proxy | Amyangfei's Blog, [https://amyangfei.me/2021/03/07/dive-into-proxy-usage/](https://amyangfei.me/2021/03/07/dive-into-proxy-usage/)  
> 4. proxychains4 with Go lang · Issue \#199 · rofl0r/proxychains-ng \- GitHub, [https://github.com/rofl0r/proxychains-ng/issues/199](https://github.com/rofl0r/proxychains-ng/issues/199)  
> 5. cproxy 4.2.1 \- Docs.rs, [https://docs.rs/crate/cproxy/latest/source/README.md](https://docs.rs/crate/cproxy/latest/source/README.md)  
> 6. Releases · hmgle/graftcp \- GitHub, [https://github.com/hmgle/graftcp/releases](https://github.com/hmgle/graftcp/releases)  
> 7. cproxy/README.md at master \- GitHub, [https://github.com/NOBLES5E/cproxy/blob/master/README.md](https://github.com/NOBLES5E/cproxy/blob/master/README.md)  
> 8. gdb in docker container returns "ptrace: Operation not permitted." \- Stack Overflow, [https://stackoverflow.com/questions/42029834/gdb-in-docker-container-returns-ptrace-operation-not-permitted](https://stackoverflow.com/questions/42029834/gdb-in-docker-container-returns-ptrace-operation-not-permitted)  
> 9. How to solve "ptrace operation not permitted" when trying to attach GDB to a process?, [https://stackoverflow.com/questions/19215177/how-to-solve-ptrace-operation-not-permitted-when-trying-to-attach-gdb-to-a-pro](https://stackoverflow.com/questions/19215177/how-to-solve-ptrace-operation-not-permitted-when-trying-to-attach-gdb-to-a-pro)  
> 10. boot2docker (Mac OS X) 1.10 failing ptrace/gdb \- Machine \- Docker Community Forums, [https://forums.docker.com/t/boot2docker-mac-os-x-1-10-failing-ptrace-gdb/6005](https://forums.docker.com/t/boot2docker-mac-os-x-1-10-failing-ptrace-gdb/6005)  
> 11. Defend Yourself Against HTTProxy Exploit \- Proxyrack, [https://www.proxyrack.com/blog/defend-yourself-against-httproxy-exploit/](https://www.proxyrack.com/blog/defend-yourself-against-httproxy-exploit/)  
> 12. packetstream/packetstream.py at main · enwaiax/packetstream \- GitHub, [https://github.com/enwaiax/packetstream/blob/main/packetstream.py](https://github.com/enwaiax/packetstream/blob/main/packetstream.py)  
> 13. Developer Proxy Guides | Code Integration \- Proxies.sx, [https://www.proxies.sx/use-cases/developers](https://www.proxies.sx/use-cases/developers)  
> 14. Docker networking and proxy settings \- Reddit, [https://www.reddit.com/r/docker/comments/18tty8n/docker\_networking\_and\_proxy\_settings/](https://www.reddit.com/r/docker/comments/18tty8n/docker_networking_and_proxy_settings/)  
> 15. slirp4netns — How does it work \- M Castelino \- Medium, [https://mcastelino.medium.com/slirp4netns-how-does-it-work-5c0bd31200ce](https://mcastelino.medium.com/slirp4netns-how-does-it-work-5c0bd31200ce)  
> 16. Podman in rootless mode on LXC container \- Proxmox Support Forum, [https://forum.proxmox.com/threads/podman-in-rootless-mode-on-lxc-container.141790/](https://forum.proxmox.com/threads/podman-in-rootless-mode-on-lxc-container.141790/)  
> 17. CHANGELOG.md \- mezantrop/ts-warp \- GitHub, [https://github.com/mezantrop/ts-warp/blob/master/CHANGELOG.md](https://github.com/mezantrop/ts-warp/blob/master/CHANGELOG.md)  
> 18. JVM in Docker and PTRACE\_ATTACH, [https://jarekprzygodzki.dev/post/jvm-in-docker-and-ptrace\_attach/](https://jarekprzygodzki.dev/post/jvm-in-docker-and-ptrace_attach/)  
> 19. On a service provider VPS this doesn't work · Issue \#169 · engageub/InternetIncome, [https://github.com/engageub/InternetIncome/issues/169](https://github.com/engageub/InternetIncome/issues/169)  
> 20. How to create a simple Image HTTP proxy using Node.js \- Proxyrack, [https://www.proxyrack.com/blog/create-simple-image-http-proxy-using-node-js/](https://www.proxyrack.com/blog/create-simple-image-http-proxy-using-node-js/)  
> 21. Solution for Render.com Web services spin down due to inactivity. \- DEV Community, [https://dev.to/harshgit98/solution-for-rendercom-web-services-spin-down-due-to-inactivity-2h8i](https://dev.to/harshgit98/solution-for-rendercom-web-services-spin-down-due-to-inactivity-2h8i)  
> 22. Artemis43/telegram-support-bot: A helpdesk inbox, inside Telegram. \- GitHub, [https://github.com/Artemis43/telegram-support-bot](https://github.com/Artemis43/telegram-support-bot)  
> 23. Getting Started with Oracle Cloud Free Tier: Create Modern Web Applications Using Always Free Resources \[1st ed.\] 9781484260104, 9781484260111 \- DOKUMEN.PUB, [https://dokumen.pub/getting-started-with-oracle-cloud-free-tier-create-modern-web-applications-using-always-free-resources-1st-ed-9781484260104-9781484260111.html](https://dokumen.pub/getting-started-with-oracle-cloud-free-tier-create-modern-web-applications-using-always-free-resources-1st-ed-9781484260104-9781484260111.html)  
> 24. Oracle cloud, a1.flex "Out of capacity" ERROR FİXED\!\! DEFINITELY TRY IT\! : r/oraclecloud \- Reddit, [https://www.reddit.com/r/oraclecloud/comments/1oobbq1/oracle\_cloud\_a1flex\_out\_of\_capacity\_error\_fixed/](https://www.reddit.com/r/oraclecloud/comments/1oobbq1/oracle_cloud_a1flex_out_of_capacity_error_fixed/)  
> 25. Fly.io Pricing 2026: Free Tier, Postgres & Alternatives \- srvrlss, [https://www.srvrlss.io/provider/fly/](https://www.srvrlss.io/provider/fly/)  
> 26. What is Hugging Face? Leading Platform for NLP and AI \- Artoon Solutions, [https://artoonsolutions.com/glossary/hugging-face/](https://artoonsolutions.com/glossary/hugging-face/)  
> 27. Unable to login to huggingface \- Beginners \- Hugging Face Forums, [https://discuss.huggingface.co/t/unable-to-login-to-huggingface/164273](https://discuss.huggingface.co/t/unable-to-login-to-huggingface/164273)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAmwAAAAmCAYAAAB5yccGAAAFm0lEQVR4Xu3cV4hkRRTG8WNEMaGiKKI+GJ5MGMCA2origpgxgSAIJlgVUUQEfVHMWQwoyGLOAUUwN+acMaHuvig+uGJADJjOR9Vxzq25PQO73YPK/weHrlt154bqgXuoqttmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/3F7eSzX1G3gcanHGXX7NI+bppon5hOP59vKJXS2x28en9fPxR6fefxVYxzafpq0cz129Fjb49WmTdZrtvfzeK/GsU2bbOPxu5X+0L20oq++s+n/IwAAYI4sbyWRua5tcG96DNP2uJKc7L5mezcrScQ43JrKd3scmLZvTuU+y3osaitHaPtpkn6xktQ+0tQvsnId7Xe0e/1UsqXEdcPUFgYe13u83dSvauW+2mMCAIA5pgf1IVYeyrs0ba/YZBO2eTY9YdvIY7umbknlY7cJ2/6p3Odjj2/ayhHafpokjRCOcqZ1vyMlndretG5f5nHqVPM/Bh5XWtn3/FT/kJGwAQDwr/CFxypWHsqXN21tIpIf3Mt4vGFlVCdPtWla7S6PFz2eq3XHWDmOpvBuq3WihOjX+hlJWkzBhRM9XrJynqCRou+tTPfd6/F+ahulTdiyZ63c6yV1WwmOrutPK9d2cq1/0uNRj6c9dqp1kvtpfY87PF7wWFDrxmmhlcTsA4/Vm7Y2YZO9U/mJZjsMrCRsX1t3VFF9NrTuMTXqpsTv5doGAADmwFH1s286bVTCtmsqy3EeW9Xyzx6rWZlqvb3WHWBlqlP28NinlqUdYdN6sHyenGQpgYrzKElbuZY1SjgbJZFtwqbr/DZtb+4xv5Z1Xe0I25FWElVNL+paQu4nrQdTAiz7emxRy+OyZSqrn/I99SVsQUnkD21lNbCSsCkJzX+v/h02dbpvrZ8LX6YyAACYkDXq51k2/WE/KmHTere8r5Kx8zxWtO5IWKbkRSNu73oclurbhO1i655HSVRQvc4j76T6a6xM/82kL2HTdbT3rJEx6UvYtLbuCiv3kf8u95NebtC2Qn2xZ62fBF3DjWl7poTtJyuJWZ+BlYRNNOKq7zGmUYfWPeZXqSyjzgcAAMbkgmb7I+su+B+VsF2byqJptgutjMh8mOqD9j2+lpXcHW5TI2UP1M9z6udF1j1PHqFSvc4jmo4NV9nsbzD2JWyHWvc+lKjonuUemxp9u99jE48767ZopEkL+Ne1bj/ppYDZrkXXPlNEEt1H1xtrDVXOb+72JWxrWfleg/q+NfC4upY1gqdpZk15ytC6x2yT2PZ8AABgzNrkSqNXMYIlr1t/wqZRo/yg1hqvHWr5D4+NU5uSIO0biddBHkd4PFy3tbBd4rw5YdN5lFQF1cd58gibEjZNwc6kL2Fb08rPVQQlkafXsqZzo01r1jStO79u6+90LVrAf7B1+0n1eVStfZFjacX1ic6Vp5f7ErbHrLxUEnQfrYGVUcqg7/CGWh5a95gqr5O22wQOAACMiRIqPXgV29c6rQP7sdYpUdk57aMXAhbWcjygNQX5Vo0Tap1s5vGglRcMYm3ZSR6fWhkN0vkW21Ty85qVEaBYGxa/CTavtp9iZRpV5wmaltM+Wj+l35DT3+iY8XJAdrSVNu2vUTG9rBBrzIKmOJUAajo2aLRQI2v6+YxIUDT69ZSVtWxKghZYSciinzQ6qRcBlEDqmrVof9y2tXK9evEij+Q9blN9p2lN0T3EtUWsVNvC1qktfktOb8jq+7gltel71/mUrGpaWC89PFP3BwAAEzDbei+JEatIpOJBP9t039LS+WSmEbMV0qf2i2vUaN5ca/sJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP6v/gabwER7JSInjAAAAABJRU5ErkJggg==>

[image2]: <data:image/png;base64,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>

[image3]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAmwAAAAmCAYAAAB5yccGAAAGuUlEQVR4Xu3cB4hcVRTG8WNvUbBihYAVsYGIFRNFNHZFBQWVCBFRVFREEURWsCF2BQtigopYUUHsyir2XmLDFnvvir2cz3uPc+ZmZrNZN9Ek/x8c9t373pud97Lwvtx7Z8wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBwLeS1YNsJAACAf+dbrz/rz0+9PvM62WuRfNAwPGvlddZod4yCeI+/eH3l9ZPX81YC4mg43GuXtnOUfWnlGvTev/P62mtC1xFzhiW9Pmw7q+ua9r1W/i5OavplIyv3QPdklWaf7Ghl389eCzT7AACYJz3ktXzT1sNyZh1sIw9sx1sJTv2c5TWx6RvJe5Q7vNZL7WW8Fk3tWUXvd2Jqv1L7RkLX8F/40Xq/5yu8bkztU9P2SlaCXi8XWwl12Rivm6z8nhWbfQAAzLMU0JZL7alef6R2a/G2o5pkIwtsCkt6OM+OwLaslfNyYNO1r5raw9XvPvTTBrYXa9/MijAzu+3gdaxN/7vv8xpr3YHtFK8pdVtBvp/zrLzeaanvFq+laj+BDQCAKge2hb1+9TqytvUg1YPzDCvThtrW8eESrze8Jlt5SEdg0+to5ETHarTlWisjJ3KN19PWeaBfZuV1v/d6v/a1hgpsmnL7xusIK9N1h1kZ1VGA0LTcgfU4ecnKeZpajSm837wG4gC3ptcHXg9aCQ6vem1v5bzHrFyHtlWxZk9TyJqmvcdrw9rXyoEtQuqV/+wtnvQa9Nq7thUsb659Cmqi+6RzP7fuacj23NGk63zYegc2/btLDmyrWTnuRK9nUn9Lge1jr2mpL64pBzbd87O9HrVyjQAAzHPaETattxpM7QhsIQLb0V6bpX49zCOwaX1S0Pl71e1zvZao2ztbZ6RLx8xohO09r+e8XrPy4J4/7df5l3ttY2V9lB70MbLzgJXjg47NI2wKAwN1+1brDiQ6L0KkRsQU2EIEtt3rtmjqr9/oZA5sW3qd09n1N61vCwpfCkA6Z5/at379qfuU3+MKNv25o033QWsG28Cm9Y4hBzb9G0cQbwNepsC2uXUfs1j9mQOb7qlGR4MC9cyuswQAYI7WBjaNruUHqLZ7BbZB654WzIHto9Sv8xVqRKNxCj0qjbJtm46ZUWAbar/OV4DMVrYy4qXRtJdTv47NgU3XMFC3NdqmEbVwtXUCm0YMewU2BUVtx3W9m47JcmCL9k5NO17jda/bvN6p/RdZJxy3gW3/2s7njjaFa8mBTaNog3VbcmCbUn/uZmUkcI/Ori4KbPKWlVHZ+PuRHNjaDzpo33ZNHwAAc7U2sK1l5YGoaTvR9pmd3V2BLY9y5MB2nJUpRYUyPdiDpg17fepPv0NB8VDr/SAeTmCblNpvWwk7cr+VBf5r17aO3cDrKithTSM6A3WfPomqY0MObI97PZH26XUU2M6v2zOiYyY2bQXK3G5p3Zgo+GhkcT4rU75xrK5hz9QeigLVU0NUP8dYmbZUxXTsC1Y+URz9Ko3y6ee69ZhMHy7o5YL6U6OHN9j0I6ER2BT6Mu2b0PQBADBXawOb1oLlB662tX5IFLYeqdtHWZl+DAppWv8lWjjey4B1RtVEU4Oi36HXO8H6Bza9r350fg5saseIj0KiRs0iHGif3vddVqb5cmDTOrE8palAFYFNYUIBNOh1NCo0vm6HcWk70zEHNW1N84rum9bhhTFe11vZr5AmW9dtTfXG79M1aJ1de+6sopG+NoyJ/n7ifisE66tLsn2bdrgwbf9uZU1kyIFN2/mTzApw8R8KAADmevEdZ/q6Bj0E9eBXUFg9HbOVldGlyV6HWDl+fN03xetuK2FID1/t0xShpsC0HZWnSDUipdGvvGB+VyujYhpha8V3mKny2rgQv1dBa+PaN9bKlOKlXutYmVLTWi/RhxQ0ErRFbev1df2317Y+NKApVH11hl4jAps+yHCnlftwunXekyhIaWROo3mb1L4srkFTrvqOMRlnJfwO1m1ReNa9OaC29Xpa66b3phGooGvQ2ry4BmnPHW37WXn/uo48EqbtL6wErmmpX2v+3rTOtGeme6wROb2Wgr4oVOs+6oMY+jvUPv276D8JS1tZ/zjVyj0BAAAzECM+rbye7QfrfIJSa6/a79r6P1Eg0DX1WsSeA1ur19QuAADAHEPrm2LKalObNQvhZwd9LcgnbScAAAD+H/S1ITGayGgaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzP4CXTSieBDPjO4AAAAASUVORK5CYII=>

[image4]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAE0AAAAZCAYAAAB0FqNRAAADh0lEQVR4Xu2XWahNURjHP1PmmaTQTSG8mDPEvQmJkqEMD5J4UIbEA0rsZHyQF4lSMqQoJFMiLpnyYCYRmYfIPJXx//etdffe39ln3/Pguvdh/+pXZ39rnXP2+tba31pbJCMjIyOjEB7ATjaYQDd4Ep6Bl+B8WC3WI84s+AH+dt6ON+ewRsK+X+CReHPVoa6EN5rkLtevHXwDJ7vrZvAWXOyu02AyHon+Xi/T5qkumiT2ue+uqyydRW/0LXwOn8In8Bn8Dvu4fhskd6XMgJ9hYxO3BHCV6P+sizeVMRgukMJWZKUzEq61QbBQwlXER/Al3BM2/6VEdJDjTdwSwNHwnujE1Ii1KpthkVRw0urDljaYQC0bMHAwQ02sBzwu4eDaiA5mS1kPpbuLcxWlEYj+zwrR/sNirSK14WH3uUKS1gBuhz/gN3gHTpHkgsy6sNIGy4EDuADbRmK9RQezKRIjXV18m4lbAtGk+f5bY60i4+Bs9zlf0jhuPhFX4HlYCgdGO6SxHi6FTUQT1R8ehGdhz0g/MkfCmymUJaKFO0qx6GA2mrivh/tM3BKIJo1cgx9hvbJWkd2wlfuclDQ/kZw0v0EMEP2d4b5TGna2PSNE/+yc6EzySMDdiH9YKE3he9GjRZQS+XdJWyT6nUnumpPPSfckJY219RdsbuI7RTeucsfYwQYicBY4A1NhX9NWCHPhJ8nd7vM9nl1cfIeJWwIJk1Yk+h2fqOlwmvtMkpLGow13cwufCvYfYhuS4G51SvT55hbeOt4cgzdVKHwEbtqg6O8n1SK/Eaw2cUsAx0Su+TTwONMCHhVd4Z6kpHH1PzQxwh2e/blIUuHhkoNj4gaJFnr+YNIXWXiX22AeGsKfogU2iRfwgIlx1+VNTzRxSwDHRq5ZZ/k97rr20U5KGifytYkRvxuXW9dYNHmKj8IjwSHRAfPcxUd4ArwO24fdUuEhljeQ79WFh9u7JjZP9HWHdSmNQHSH9LDoc/fnJNmEJyVtmYvbI9Ze0WTWMfEc0nZDrj6uwlfwNOwXb05llOiN7bcNDk7MO9HjDeEAHosW9jS4S3Ii+AhHa+Ux0frJ86bHv9LxNSp6hGoEr4qeE2u6WDH8KvHJ+O90FE02N4N88NBbCi/Cy5I+gWSm6GpiIihXJTcqwjLDJHj4tsB235cv+tFdlXWP9fuG84Toq1dGRkZGRkZGRmXzB7fU2R6q3T+tAAAAAElFTkSuQmCC>

[image5]: <data:image/png;base64,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>

[image6]: <data:image/png;base64,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>

[image7]: <data:image/png;base64,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>

[image8]: <data:image/png;base64,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>

[image9]: <data:image/png;base64,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>