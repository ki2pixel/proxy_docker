# **Architecture et Optimisation Mémoire Haute Densité pour Moteur Docker sous Contrainte Extrême (1 GiB RAM)**

## **1\. Analyse Causale de l'Effondrement Système et Bilan des Ressources**

### **Mécanismes de Saturation et Swap-Thrashing**

L'incident ayant entraîné le blocage complet de l'instance Azure Standard B2ats v2 trouve son origine dans une rupture d'équilibre entre la vitesse de réclamation de la mémoire par le noyau et la bande passante d'entrée/sortie (I/O) du support de stockage sous-jacent. L'hôte dispose de 1 GiB de mémoire physique et d'un disque managé standard de 30 Go, intrinsèquement contraint par un plafond d'environ 500 IOPS et des temps de latence élevés lors des accès concurrents.  
Lorsque l'empreinte mémoire cumulée des 22 conteneurs et des composants d'infrastructure a dépassé la capacité de la mémoire vive, le démon d'échange du noyau (*kswapd*) a été sollicité pour évincer les pages anonymes vers le fichier de swap résidant sur ce disque standard. Cette sollicitation a immédiatement saturé la file d'attente I/O du contrôleur de bloc virtuel. En conséquence, les processus effectuant des allocations mémoire se sont retrouvés placés en attente ininterruptible (*D-state*), provoquant une envolée du *load average* et du pourcentage d'attente I/O (*iowait*).  
Le démon dockerd ainsi que containerd n'ont plus été en mesure de traiter les requêtes synchrones transitant par leurs sockets UNIX respectives dans les délais alloués. Ce phénomène d'écroulement par pagination (*swap-thrashing*) a figé la couche d'exécution des conteneurs sans que le mécanisme standard de l'OOM Killer (*Out-Of-Memory*) du noyau ne s'active à temps, rendant le système inaccessible et imposant un redémarrage forcé de la machine virtuelle.

### **Cartographie et Bilan d'Allégement Mémoire**

La configuration par défaut d'un environnement Docker moderne alloue des structures de données généreuses et maintient des processus intermédiaires conçus pour des serveurs disposant de plusieurs dizaines de gigaoctets de mémoire vive1. Sur un total de 22 conteneurs, le coût cumulé des runtimes, des tampons de logs et des ramasse-miettes excède la mémoire physique réelle disponible.

| Composant / Couche Système | Empreinte Initiale (RSS) | Cause Principale du Surcoût | Empreinte Cible (RSS) | Gain Net Estimé |
| :---- | :---- | :---- | :---- | :---- |
| **dockerd** | \~70 Mo | Ramasse-miettes Go non borné, goroutines, parsing logs | \~32 Mo | \-38 Mo |
| **containerd** | \~24 Mo | Plugins internes chargés, metadata boltdb | \~14 Mo | \-10 Mo |
| **Shims OCI (×22)** | \~110 Mo (4 à 8 Mo/shim) | containerd-shim-runc-v2 basé sur le runtime Go | \~22 Mo (1 Mo/shim via crun) | \-88 Mo |
| **Fournisseurs Proxy (×16)** | \~260 Mo (3 à 20 Mo/unité) | Absence de quotas bas (memory.high), tas Node | \~160 Mo | \-100 Mo |
| **Passerelles Réseau (×4)** | \~40 Mo (10 Mo/unité) | tun2socks, dnsproxy, socat | \~32 Mo | \-8 Mo |
| **Dashboard & Métriques** | \~45 Mo (Node 23 Mo \+ Scraper) | Moteur V8 non bridé, collecteur d'hôte redondant | \~20 Mo (Node bridé, metrics retiré) | \-25 Mo |
| **Système d'Exploitation & Caches** | \~140 Mo | Buffers journald, structures fs, page cache | \~95 Mo | \-45 Mo |
| **Total Global Alloué** | **\~689 Mo** | *(Sans compter les pics dynamiques de charge)* | **\~375 Mo** | **\-314 Mo (\~45%)** |

## **2\. Rationalisation du Démon Docker et du Runtime de Conteneurs**

### **Élimination de l'Overhead Go via GOMEMLIMIT et crun**

Les démons dockerd et containerd sont développés en langage Go. Le comportement par défaut du ramasse-miettes (*Garbage Collector*) de Go consiste à doubler la taille du tas alloué avant d'engager un cycle de nettoyage (GOGC=100)3. Cette stratégie privilégie le débit d'exécution au détriment de l'empreinte mémoire, autorisant des expansions de mémoire résidente qui déstabilisent un système restreint à 1 GiB de RAM physique3. L'introduction de la variable d'environnement GOMEMLIMIT force le moteur d'exécution Go à intensifier la collecte des objets inutilisés dès que l'allocation globale approche un seuil prédéterminé, stabilisant ainsi l'empreinte mémoire des démons centraux3.  
Parallèlement, l'exécuteur OCI par défaut runc introduit un surcoût structurel majeur1. Chaque conteneur instancie un processus containerd-shim-runc-v2 qui embarque son propre runtime Go, consommant entre 4 et 8 Mo de mémoire RSS par instance indépendamment de la légèreté du processus encapsulé1.  
Le remplacement de runc par crun, une implémentation OCI écrite intégralement en langage C, supprime totalement le fardeau du runtime Go et de son ramasse-miettes1. Le binaire crun présente une empreinte résidente inférieure à 1 Mo par shim, permettant d'économiser près de 90 Mo de mémoire vive sur l'ensemble des 22 conteneurs de l'architecture1.

### **Driver de Journalisation et Optimisation Réseau**

Le pilote standard json-file maintient des tampons d'analyse en mémoire vive et génère une amplification de mémoire au sein du processus dockerd sous fort débit de journalisation. L'adoption du pilote local résout cette problématique en écrivant directement les messages dans des fichiers binaires optimisés et paginés sur disque avec rotation stricte8. Pour les conteneurs de relais de bande passante générant des logs volumineux et sans valeur opérationnelle, la suppression pure et simple de la journalisation (driver: "none") élimine l'allocation de tampons de communication inter-processus.  
La désactivation du composant userland-proxy dans la configuration Docker supprime l'instanciation des processus docker-proxy en espace utilisateur, déléguant la totalité des redirections de flux aux tables de routage du noyau Linux via iptables.

### **Configuration Complète du Démon Docker (/etc/docker/daemon.json)**

JSON  
{  
  "default-runtime": "crun",  
  "runtimes": {  
    "crun": {  
      "path": "/usr/bin/crun"  
    }  
  },  
  "log-driver": "local",  
  "log-opts": {  
    "max-size": "5m",  
    "max-file": "2",  
    "compress": "true"  
  },  
  "log-level": "warn",  
  "live-restore": true,  
  "userland-proxy": false,  
  "iptables": true,  
  "ip6tables": false,  
  "no-new-privileges": true,  
  "default-ulimits": {  
    "nofile": {  
      "Name": "nofile",  
      "Hard": 4096,  
      "Soft": 2048  
    }  
  }  
}

### **Surcharges Systemd pour dockerd et containerd**

Pour brider définitivement l'allocation des processus de contrôle, des fichiers de configuration additionnels sont déployés sous systemd.  
Création de /etc/systemd/system/docker.service.d/override.conf :

Ini, TOML  
\[Service\]  
Environment="GOMEMLIMIT=40MiB"  
Environment="GOGC=50"  
MemoryMin=32M  
MemoryLow=48M  
MemoryMax=80M

Création de /etc/systemd/system/containerd.service.d/override.conf :

Ini, TOML  
\[Service\]  
Environment="GOMEMLIMIT=18MiB"  
Environment="GOGC=50"  
MemoryMin=16M  
MemoryLow=24M  
MemoryMax=45M

## **3\. Configuration Noyau et Substitution du Disque par zRAM**

### **Élimination des Goulots d'Étranglement I/O par la Mémoire Compressée**

L'utilisation d'un swap sur fichier ou partition disque dans un environnement cloud aux performances d'E/S limitées constitue une vulnérabilité critique9. La technologie zRAM crée un périphérique bloc virtuel directement dans la mémoire vive, compressant à la volée les pages anonymes inactives11.  
En exploitant l'algorithme zstd, le taux de compression atteint régulièrement un facteur de 1:2.5 à 1:310. Allouer un volume zRAM de 1024 MiB (égal à 100% de la RAM physique) mobilise environ 350 MiB de mémoire réelle compressée pour stocker 1 GiB de données applicatives, tout en offrant une bande passante interne de plusieurs gigaoctets par seconde et une latence inférieure à la microseconde, immunisant ainsi l'hôte contre tout blocage disque9.

### **Déploiement de systemd-zram-generator et Réglages Sysctl**

L'installation et l'initialisation du module sont assurées nativement sous Debian 13 par le générateur systemd12.

Bash  
sudo apt-get update && sudo apt-get install \-y systemd-zram-generator crun

Configuration de l'unité dans /etc/systemd/zram-generator.conf10 :

Ini, TOML  
\[zram0\]  
zram-size \= ram \* 1  
compression-algorithm \= zstd  
swap-priority \= 100  
fs-type \= swap

Le fichier de swap traditionnel présent sur le disque dur Azure doit être définitivement désactivé afin d'empêcher le sous-système de mémoire virtuelle d'y diriger des flux asynchrones9 :

Bash  
sudo swapoff \-a  
sudo sed \-i '/swap/s/^/\#/' /etc/fstab

Les paramètres du noyau Linux doivent être réalignés afin de tirer pleinement parti du mécanisme zRAM et d'assurer une gestion fluide des réserves de mémoire.  
Configuration des variables dans /etc/sysctl.d/99-memory-tuning.conf :

Ini, TOML  
\# Intensification de l'éviction précoce vers le zRAM rapide  
vm.swappiness \= 180

\# Désactivation de la lecture groupée de pages (accès unitaire optimal en RAM)  
vm.page-cluster \= 0

\# Seuil de déclenchement du nettoyage mémoire d'arrière-plan (1.5% de la RAM)  
vm.watermark\_scale\_factor \= 150  
vm.watermark\_boost\_factor \= 0

\# Préservation accrue du cache des métadonnées de fichiers (dentry/inode)  
vm.vfs\_cache\_pressure \= 50

\# Politique d'engagement mémoire avec vérification heuristique  
vm.overcommit\_memory \= 0

Le paramètre vm.swappiness \= 180 indique au noyau d'arbitrer agressivement en faveur de la compression des pages anonymes peu actives dans le zRAM plutôt que de détruire les caches de fichiers du système de fichiers nécessaires aux exécutables et bibliothèques partagées14. La valeur vm.page-cluster \= 0 supprime le regroupement de lecture en blocs de ![][image1] pages contiguës hérité des disques magnétiques, éliminant l'amplification mémoire inutile14.

## **4\. Stratégie de Quotas cgroup v2 et Optimisations Applicatives**

### **Articulation memory.high et memory.max**

Le standard cgroup v2, activé nativement avec le noyau 6.12, introduit une distinction fondamentale entre régulation souple et terminaison brutale2. Auparavant, un conteneur configuré avec une limite statique de 512 Mo pouvait consommer librement l'intégralité de la RAM physique sans déclencher la moindre action de régulation, avant d'engager subitement le système dans un état d'OOM global2.  
Le contrôle précis de la hiérarchie cgroup v2 repose sur deux niveaux de contrainte2 :

> * La limite souple memory.high (correspondant à mem\_reservation ou deploy.resources.reservations.memory dans Docker Compose) agit comme un seuil de pression2. Lorsque l'allocation d'un conteneur dépasse cette valeur, le noyau ralentit l'exécution des processus incriminés et force la réclamation de leur mémoire interne sans interrompre leur fonctionnement2.  
> * La limite stricte memory.max (correspondant à mem\_limit ou deploy.resources.limits.memory) définit la frontière infranchissable2. En cas de dépassement, l'OOM Killer localisé termine le processus interne fautif sans déstabiliser les conteneurs voisins ni impacter la machine hôte2.

| Catégorie de Conteneur | Empreinte RSS Typique | Limite Souple (memory.high) | Limite Stricte (memory.max) | Quota CPU (cpus) | Quota PIDs (pids) |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Passerelle Réseau** | 8 à 12 Mo | 24 Mo | 48 Mo | 0.40 | 64 |
| **Provider (Node.js)** | 18 à 22 Mo | 20 Mo | 36 Mo | 0.15 | 32 |
| **Provider (Go/C++)** | 5 à 18 Mo | 16 Mo | 32 Mo | 0.15 | 32 |
| **Provider Léger** | 3 à 8 Mo | 12 Mo | 24 Mo | 0.15 | 32 |
| **Dashboard UI** | 15 à 22 Mo | 24 Mo | 40 Mo | 0.20 | 32 |

### **Confinement Applicatif et Moteur JavaScript V8**

Les applications développées sur la plateforme Node.js (telles que le dashboard de contrôle et le client Repocket) dimensionnent par défaut leur tas mémoire en fonction de la capacité globale de la machine virtuelle. En injectant les drapeaux d'optimisation V8 \--max-old-space-size=20 et \--max-semi-space-size=2 via la variable d'environnement NODE\_OPTIONS, le moteur d'exécution JavaScript réorganise ses cycles de compaction et restreint son espace résiduel à une vingtaine de mégaoctets, empêchant toute dérive progressive5.  
Le conteneur metrics-host, consommateur superflu de mémoire et de cycles d'exécution, est totalement éliminé. La collecte d'informations statistiques s'effectue désormais par lecture directe des fichiers exposés par le pseudo-système de fichiers cgroup v2.

### **Spécification du Déploiement Docker Compose**

YAML  
version: "3.8"

x-logging-disabled: \&logging-disabled  
  logging:  
    driver: "none"

x-logging-buffered: \&logging-buffered  
  logging:  
    driver: "local"  
    options:  
      max-size: "1m"  
      max-file: "1"

services:  
  \# Passerelle Réseau Référence (1 sur 4\)  
  gateway-isp-1:  
    image: custom-gateway:latest  
    container\_name: gateway-isp-1  
    restart: unless-stopped  
    cap\_add:  
      \- NET\_ADMIN  
    devices:  
      \- /dev/net/tun  
    \<\<: \*logging-buffered  
    deploy:  
      resources:  
        limits:  
          cpus: '0.40'  
          memory: 48M  
          pids: 64  
        reservations:  
          memory: 24M

  \# Clients de Partage de Bande Passante  
  honeygain-1:  
    image: honeygain/honeygain:latest  
    container\_name: honeygain-1  
    restart: unless-stopped  
    network\_mode: "service:gateway-isp-1"  
    environment:  
      \- TOU\_ACCEPT=1  
    \<\<: \*logging-disabled  
    deploy:  
      resources:  
        limits:  
          cpus: '0.15'  
          memory: 32M  
          pids: 32  
        reservations:  
          memory: 16M

  repocket-1:  
    image: repocket/repocket:latest  
    container\_name: repocket-1  
    restart: unless-stopped  
    network\_mode: "service:gateway-isp-1"  
    environment:  
      \- RP\_EMAIL=${RP\_EMAIL}  
      \- RP\_API\_KEY=${RP\_API\_KEY}  
      \- NODE\_OPTIONS=--max-old-space-size=20 \--max-semi-space-size=2  
    \<\<: \*logging-disabled  
    deploy:  
      resources:  
        limits:  
          cpus: '0.15'  
          memory: 36M  
          pids: 32  
        reservations:  
          memory: 20M

  pawns-1:  
    image: iproyal/pawns-cli:latest  
    container\_name: pawns-1  
    restart: unless-stopped  
    network\_mode: "service:gateway-isp-1"  
    \<\<: \*logging-disabled  
    deploy:  
      resources:  
        limits:  
          cpus: '0.15'  
          memory: 32M  
          pids: 32  
        reservations:  
          memory: 16M

  packetstream-1:  
    image: packetstream/psclient:latest  
    container\_name: packetstream-1  
    restart: unless-stopped  
    network\_mode: "service:gateway-isp-1"  
    \<\<: \*logging-disabled  
    deploy:  
      resources:  
        limits:  
          cpus: '0.15'  
          memory: 24M  
          pids: 32  
        reservations:  
          memory: 12M

  \# Interface d'Administration  
  dashboard:  
    image: node-dashboard:latest  
    container\_name: dashboard  
    restart: unless-stopped  
    ports:  
      \- "127.0.0.1:3000:3000"  
    environment:  
      \- NODE\_ENV=production  
      \- NODE\_OPTIONS=--max-old-space-size=24 \--max-semi-space-size=2  
    \<\<: \*logging-buffered  
    deploy:  
      resources:  
        limits:  
          cpus: '0.20'  
          memory: 40M  
          pids: 32  
        reservations:  
          memory: 24M

## **5\. Surveillance Haute Résolution et Détection Préventive**

### **Indicateurs de Pression PSI et Protection par earlyoom**

L'évaluation traditionnelle de l'occupation mémoire par l'outil free ou docker stats est incapable de détecter l'imminence d'un blocage d'I/O. Le mécanisme PSI (*Pressure Stall Information*) intégré au noyau Linux quantifie avec précision la perte d'efficacité imposée aux tâches par manque de ressources physiques via /proc/pressure/memory5.  
La métrique some avg10 indique le pourcentage de temps processeur durant lequel au moins un thread a été suspendu dans l'attente de pages mémoire, tandis que la métrique full avg10 reflète un blocage simultané de l'ensemble des tâches actives5. Dès lors que la valeur full avg10 franchit le seuil critique de 15%, le système entre en situation avérée de thrashing5.  
Pour parer à tout verrouillage de la machine en cas de défaillance imprévue d'un conteneur, le démon utilisateur earlyoom est configuré afin de procéder à des purges ciblées dès que les réserves physiques deviennent critiques, court-circuitant la latence de l'OOM Killer du noyau19.  
Installation et configuration de earlyoom :

Bash  
sudo apt-get install \-y earlyoom

Édition de /etc/default/earlyoom :

Ini, TOML  
\# Déclenchement préventif si la RAM disponible descend sous 7% et le Swap zRAM sous 10%  
EARLYOOM\_ARGS="-m 7 \-s 10 \-r 30 \--avoid '(systemd|sshd|dockerd|containerd)' \--prefer '(honeygain|pawns|repocket|packetstream)'"

Activation du service de protection :

Bash  
sudo systemctl enable \--now earlyoom

### **Script Sentinelle sans Overhead**

Pour auditer l'état des conteneurs sans introduire de processus de métrique permanent, le script d'inspection directe suivant extrait les métriques directement depuis l'arborescence cgroup v2 :

Bash  
\#\!/usr/bin/env bash  
set \-euo pipefail

echo "================================================================="  
echo "               ÉTAT DE LA MÉMOIRE & PRESSION PSI                 "  
echo "================================================================="  
free \-h  
echo ""  
echo "Pression PSI (/proc/pressure/memory):"  
cat /proc/pressure/memory  
echo ""  
echo "-----------------------------------------------------------------"  
printf "%-20s | %-12s | %-12s | %-15s\\n" "CONTENEUR" "USAGE (MiB)" "PEAK (MiB)" "OOM EVENTS"  
echo "-----------------------------------------------------------------"

for cg in /sys/fs/cgroup/system.slice/docker-\*.scope; do  
    if \[ \-d "$cg" \]; then  
        cid=$(basename "$cg" | sed \-E 's/docker-(\[a-f0-9\]{12})\[a-f0-9\]\*\\.scope/\\1/')  
        c\_name=$(docker ps \--filter "id=$cid" \--format "{{.Names}}" 2\>/dev/null || echo "$cid")  
          
        current\_bytes=$(cat "$cg/memory.current" 2\>/dev/null || echo 0\)  
        peak\_bytes=$(cat "$cg/memory.peak" 2\>/dev/null || echo 0\)  
        oom\_kills=$(grep "oom\_kill " "$cg/memory.events" 2\>/dev/null | awk '{print $2}' || echo 0\)  
          
        usage\_mib=$(( current\_bytes / 1024 / 1024 ))  
        peak\_mib=$(( peak\_bytes / 1024 / 1024 ))  
          
        printf "%-20s | %-12s | %-12s | %-15s\\n" "$c\_name" "$usage\_mib" "$peak\_mib" "$oom\_kills"  
    fi  
done  
echo "================================================================="

### **Points Critiques d'Exploitation et Intégrité Réseau**

L'isolation stricte des passerelles réseau (gateway-isp-{n}) requiert une attention particulière quant au dimensionnement de leur limite mémoire. La coupure brutale d'une passerelle par l'OOM Killer entraîne l'effondrement de son interface tunnel tun0, détruisant le mécanisme de kill-switch réseau de niveau 3 et provoquant des fuites de trafic ou des déconnexions en cascade pour les quatre fournisseurs qui lui sont rattachés. Le plancher mémoire d'une passerelle ne doit en aucun cas descendre sous 48M de memory.max.  
De plus, l'usage de directives healthcheck invoquant des interpréteurs shell lourds ou des commandes curl à cadence élevée génère des allocations mémoires périodiques par clonage de processus (*fork bomb* miniature) qui consomment 10 à 15 Mo de mémoire résidente transitoire. Il convient d'espacer les vérifications d'intégrité à un intervalle minimal de 60 secondes ou de s'appuyer sur des contrôles de connectivité TCP passifs.

## **6\. Plan d'Exécution Priorisé et Matrice Décisionnelle**

### **Matrice Priorisée des Interventions**

| Priorité | Axe d'Intervention | Complexité / Risque | Gain Mémoire Direct | Résilience Système |
| :---- | :---- | :---- | :---- | :---- |
| **P0** | **Substitution du swap disque par zRAM (zstd)** | Faible / Nul | \~1000 Mo virtuels | **Supprime 100% des blocages par swap-thrash** \[cite: 9, 10, 14\] |
| **P0** | **Migration du runtime Docker vers crun** | Faible / Nul | **\~88 Mo réels** | Divise par 5 l'empreinte des 22 shims1 |
| **P1** | **Bridage mémoire Go (GOMEMLIMIT)** | Faible / Nul | **\~48 Mo réels** | Élimine les explosions de tas des démons3 |
| **P1** | **Resserrement des quotas cgroup v2** | Faible / Faible | **\~100 Mo réels** | Isole et contient chaque conteneur2 |
| **P2** | **Pilotes de journalisation local et none** | Faible / Nul | **\~25 Mo réels** | Supprime les tampons d'E/S en espace utilisateur8 |
| **P2** | **Bridage du tas JavaScript V8 (NODE\_OPTIONS)** | Faible / Nul | **\~15 Mo réels** | Stabilise la consommation du dashboard et Repocket5 |
| **P3** | **Retrait de metrics-host et ajout de earlyoom** | Faible / Nul | **\~20 Mo réels** | Assure une autodéfense proactive hors-noyau19 |

### **Protocole de Déploiement Séquentiel**

L'exécution des modifications doit suivre un ordonnancement strict pour éviter toute interruption d'accès à l'hôte distant.  
Le déploiement débute par la configuration de l'infrastructure noyau : installation des paquets systemd-zram-generator et crun, écriture du fichier /etc/systemd/zram-generator.conf, désactivation du swap sur disque via swapoff \-a avec mise à jour du fichier /etc/fstab, et application des directives sysctl dans /etc/sysctl.d/99-memory-tuning.conf9.  
La seconde phase porte sur la reconfiguration du moteur Docker : mise en place de /etc/docker/daemon.json, création des répertoires de surcharge pour docker.service et containerd.service intégrant les variables GOMEMLIMIT, puis rechargement des services via systemctl daemon-reload && systemctl restart containerd docker3.  
La phase finale consiste à mettre à jour la description des services dans le fichier docker-compose.yml en y intégrant les limites cgroup v2 ainsi que les options Node.js, puis à relancer la pile complète par les commandes docker compose down et docker compose up \-d5.  
La validation opérationnelle s'effectue en vérifiant avec zramctl l'activité de la mémoire compressée et en confirmant via ps aux | grep crun l'effondrement de la consommation résidente de chaque shim en dessous du seuil de 1 Mo1.

#### **Sources des citations**

> 1. Docker vs Podman 2026: Rootless Networking, Benchmarks & Migration Guide \- sanj.dev, [https://sanj.dev/post/docker-vs-podman-comparison/](https://sanj.dev/post/docker-vs-podman-comparison/)  
> 2. Linux memory limits in containers (cgroups, Docker, Kubernetes) \- GoLinuxCloud, [https://www.golinuxcloud.com/linux-container-memory-limits-cgroups/](https://www.golinuxcloud.com/linux-container-memory-limits-cgroups/)  
> 3. GOMEMLIMIT is a game changer for high-memory applications \- Weaviate, [https://weaviate.io/blog/gomemlimit-a-game-changer-for-high-memory-applications](https://weaviate.io/blog/gomemlimit-a-game-changer-for-high-memory-applications)  
> 4. feat: Correctly setting GOMEMLIMIT to prevent OOM generation · Issue \#18849 · minio/minio, [https://github.com/minio/minio/issues/18849](https://github.com/minio/minio/issues/18849)  
> 5. cgroups v2 (Control Groups) — Linux | Cracking Walnuts, [https://crackingwalnuts.com/linux/cgroups](https://crackingwalnuts.com/linux/cgroups)  
> 6. Mirantis Container Runtime Boosts Performance with Support for crun, [https://www.mirantis.com/blog/mirantis-container-runtime-boosts-performance-with-support-for-crun/](https://www.mirantis.com/blog/mirantis-container-runtime-boosts-performance-with-support-for-crun/)  
> 7. How does Docker actually work? The Hard Way: A Technical Deep Diving \- Medium, [https://medium.com/@furkan.turkal/how-does-docker-actually-work-the-hard-way-a-technical-deep-diving-c5b8ea2f0422](https://medium.com/@furkan.turkal/how-does-docker-actually-work-the-hard-way-a-technical-deep-diving-c5b8ea2f0422)  
> 8. How to Redirect Docker Logs to a File \- Dash0, [https://www.dash0.com/faq/how-to-redirect-docker-logs-to-a-file](https://www.dash0.com/faq/how-to-redirect-docker-logs-to-a-file)  
> 9. Gérer le swap sous Linux : fichier, partition, zram et swappiness \- Stephane Robert, [https://blog.stephane-robert.info/docs/admin-serveurs/linux/stockage/swap/](https://blog.stephane-robert.info/docs/admin-serveurs/linux/stockage/swap/)  
> 10. Speed Up Your Linux System with Zram | Lorenzo Bettini, [https://www.lorenzobettini.it/2025/06/speed-up-your-linux-system-with-zram/](https://www.lorenzobettini.it/2025/06/speed-up-your-linux-system-with-zram/)  
> 11. Si on mettait un peu de zRAM dans notre Debian? \- Seb's blog, [https://passiongnulinux.free.nf/blog/2024-11-17-si-on-mettait-un-peu-de-zram-dans-notre-debian/](https://passiongnulinux.free.nf/blog/2024-11-17-si-on-mettait-un-peu-de-zram-dans-notre-debian/)  
> 12. ZRam \- Debian Wiki, [https://wiki.debian.org/ZRam](https://wiki.debian.org/ZRam)  
> 13. Installation, Configuration and Management of zram on SUSE Linux Micro, [https://documentation.suse.com/sle-micro/6.1/html/Micro-zram/index.html](https://documentation.suse.com/sle-micro/6.1/html/Micro-zram/index.html)  
> 14. \[HowTo\] Install and configure zram using zram-generator \- Tutorials \- Manjaro Linux Forum, [https://forum.manjaro.org/t/howto-install-and-configure-zram-using-zram-generator/168610](https://forum.manjaro.org/t/howto-install-and-configure-zram-using-zram-generator/168610)  
> 15. Systemd unit generator for zram devices \- GitHub, [https://github.com/systemd/zram-generator](https://github.com/systemd/zram-generator)  
> 16. How to Understand Docker runc and Container Runtimes \- OneUptime, [https://oneuptime.com/blog/post/2026-02-08-how-to-understand-docker-runc-and-container-runtimes/view](https://oneuptime.com/blog/post/2026-02-08-how-to-understand-docker-runc-and-container-runtimes/view)  
> 17. How to Set Up cgroups v2 for Resource Control on Ubuntu \- OneUptime, [https://oneuptime.com/blog/post/2026-01-15-setup-cgroups-v2-resource-control-ubuntu/view](https://oneuptime.com/blog/post/2026-01-15-setup-cgroups-v2-resource-control-ubuntu/view)  
> 18. Killed by the Kernel: What Really Happens ... \- Code With Karani, [https://www.codewithkarani.com/blog/linux-out-of-memory-oom-killer-explained](https://www.codewithkarani.com/blog/linux-out-of-memory-oom-killer-explained)  
> 19. Running out of memory \- Linux Kernel Internals, [https://kernel-internals.org/mm/oom/](https://kernel-internals.org/mm/oom/)  
> 20. Does Linux's memory management suck? : r/linux \- Reddit, [https://www.reddit.com/r/linux/comments/ulgdbc/does\_linuxs\_memory\_management\_suck/](https://www.reddit.com/r/linux/comments/ulgdbc/does_linuxs_memory_management_suck/)  
> 21. how to switch docker runtime between runc and oci \- Server Fault, [https://serverfault.com/questions/864836/how-to-switch-docker-runtime-between-runc-and-oci](https://serverfault.com/questions/864836/how-to-switch-docker-runtime-between-runc-and-oci)  
> 22. Code review for this compose stack? \- Docker Community Forums, [https://forums.docker.com/t/code-review-for-this-compose-stack/132294](https://forums.docker.com/t/code-review-for-this-compose-stack/132294)  
> 23. Compose ファイル version 2 リファレンス — Docker-docs-ja 24.0 ドキュメント, [https://docs.docker.jp/compose/compose-file/compose-file-v2.html](https://docs.docker.jp/compose/compose-file/compose-file-v2.html)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADgAAAAZCAYAAABkdu2NAAACMklEQVR4Xu2WS0hVQRjHv3RTCD4qShBbRC4yKNyG6VV8FYSBQiAILXqIRJDgUkJypShuBEEoEHHnMheiJC7KwEdFodGLNhEhCFKCROn/3zenO2fuM4J7j3R+8MMz38y9ztyZ7zsjEvL/kA+H4ACchVX+7v3PPfjAPN+GX2BOtDv4XIYv4Tfz9wY8YPW3wVHzfBNuS/YWWATH4TpchQ/hMd8Ihzq4Ao+LHsURuAv77EEWj0SPajbgj7oAW02bm9AFX8Bcb5DLU1httTnwPfwFS634GdFjyvFHrHgmqYczbhC8gY1ukHAxP+EHWGDFx0R38ZYV87gOP4oelUzD1PkE85z4M9jixH7DLd8UXcwpKz5oYndNuxPWmOfTpu+qaWcSphP/NxdUZmKcz1dY6A1yqRDdehseA36RF38Lu83zRfgDlpt2JuGGPBGdGwtij2hR9H78tDghuoDXEq2UlXBCtJI+hpdMPBnMied/4ZL40yQR3CkWFS6ScsHFvhEpmIRb8KzbERDuiy6KJ4qvKy7yHTxqD0pEO/wOI048KFwTLYhekWH+cfe5yGETS8g5uAFr3Y4AwXy748QOwmXRlErIYbgGm6xYRP6tUjaI5lW6LkrqHGS1bHaDoEN0/nHhu3BaYt8jvRL/y7LJHOx3g6Jz9a6SMfADzLtXRm41k3ZHsvMqSMZ50bmyVvCaRq+I3rxKrHF/OCTRcuvKqxrPd9C4AOfhZ9Eb1RQ8aQ8ICQkJCQlJgz0VWn3Gp5rr3gAAAABJRU5ErkJggg==>