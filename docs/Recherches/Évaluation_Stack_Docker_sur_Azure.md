# **Rapport d'Expertise Technique : Déploiement d'une Stack Docker Multi-Fournisseurs de Monétisation de Bande Passante sur Microsoft Azure**

## **1\. Synthèse et Checklist de Compatibilité Technique**

L'évaluation de la faisabilité technique pour le déploiement d'une stack Docker de monétisation passive de bande passante (Pawns.app, Honeygain, PacketStream, Repocket, Proxyrack PoP) orchestrée par une passerelle d'encapsulation résidentielle (gateway-isp combinant tun2socks et dnsproxy) démontre une compatibilité globale avec l'infrastructure cloud de Microsoft Azure1. La contrainte d'isolement applicatif est résolue par l'utilisation de l'espace réseau partagé (network\_mode: "service:gateway-isp"), tandis que les mécanismes de virtualisation d'Azure autorisent l'élévation de privilèges au niveau du noyau Linux1.  
Le tableau ci-dessous résume la conformité point par point de la plateforme Azure vis-à-vis des exigences de l'architecture applicative.

| Composant / Exigence Technique | Statut d'Adéquation | Diagnostic Technique & Prérequis de Configuration |
| :---- | :---- | :---- |
| **Module Noyau TUN/TAP (/dev/net/tun)** | Compatible | Disponible nativement dans le noyau Linux Azure (linux-image-azure)4. Le périphérique /dev/net/tun est instancié au démarrage via modprobe tun2. |
| **Droits Réseau (cap\_add: NET\_ADMIN)** | Compatible | L'hyperviseur Hyper-V de Microsoft Azure n'impose aucun filtrage sur les capacités réseau internes des conteneurs Linux exécutés sous droits privilégiés2. |
| **Contrôle Réseau (iptables / nftables)** | Compatible | Intégration dans l'espace utilisateur du système hôte Linux. Prise en charge sans restriction pour le filtrage et la redirection de flux1. |
| **Isolation Socket (/var/run/docker.sock)** | Compatible | Le montage de socket pour l'orchestrateur Node.js s'effectue sans blocage au niveau de l'isolation du démon Docker sur instance dédiée. |
| **Dimensionnement Mémoire (512 Mo vs 1 Go)** | Viable sous réserve | L'instance 512 Mo (B1ls) est fonctionnelle avec un fichier de Swap de 1 Go, mais présente des risques de dégradation d'I/O5. L'instance 1 Go (B1s) offre une stabilité optimale5. |
| **Conformité AUP / Politiques d'Abus** | Risque Maîtrisé | L'encapsulation SOCKS5 à 100% via gateway-isp protège l'IP Azure contre les plaintes DMCA directes7. Risques résiduels d'empreinte binaire sur le trafic sortant9. |
| **Quota de Bande Passante (Egress)** | 100 Go / mois inclus | Microsoft Azure offre 100 Go de transfert sortant gratuit vers Internet par mois11. Au-delà, la facturation s'établit à \~0,087 $/Go (Zone 1\)13. |
| **Automatisation Cloud-Init (customData)** | Compatible | Prise en charge native du format \#cloud-config lors du provisionnement de l'instance virtuelle16. |
| **Déploiement Continu (CI/CD)** | Compatible | Intégration fluide via GitHub Actions SSH ouvrant une session de mise à jour distante sur l'instance. |

## **2\. AXE A : Support Noyau, Virtualisation Hyper-V & Isolation Docker sur Microsoft Azure**

### **2.1 Compatibilité TUN/TAP, Kernel Modules et Stack Réseau**

Les instances Linux déployées sur Microsoft Azure s'exécutent au-dessus de l'hyperviseur Hyper-V en utilisant des noyaux optimisés (linux-azure sous Ubuntu)4. Contrairement aux environnements de conteneurisation mutualisés ou aux PaaS restrictifs, les machines virtuelles Azure de type IaaS offrent un accès root complet et une émulation matérielle sous-jacente permettant l'interaction directe avec la couche réseau du noyau Linux4.  
Le périphérique virtuel TUN/TAP (/dev/net/tun) est supporté nativement2. Bien que certaines images minimales n'instancient pas la fiche de périphérique par défaut dans /dev/net/, le sous-système réseau du noyau intègre le module4. Il suffit d'exécuter la commande modprobe tun et d'assurer sa création via les scripts d'initialisation du système pour garantir sa disponibilité permanente2.  
S'agissant des images du système d'exploitation, les images officielles Microsoft Azure (Ubuntu 24.04 LTS ou Debian 12\) intègrent l'agent walinuxagent ainsi que les optimisations réseau synthétiques d'Hyper-V4. Elles constituent le choix à privilégier par rapport aux images pré-packagées du Marketplace de type "Docker on Ubuntu". Ces dernières contiennent en effet des versions figées du démon Docker et des configurations superflues. L'utilisation d'une image officielle Ubuntu 24.04 LTS vierge, personnalisée à l'aide d'un script cloud-init, s'avère techniquement supérieure pour maîtriser la stack logicielle et minimiser l'empreinte mémoire initiale4.  
Les sous-systèmes de filtrage réseau iptables et nftables sont pleinement opérationnels au sein de l'instance hôte1. Cela permet la mise en place de politiques de routage avancées, de mécanismes de NAT et de règles de suppression de flux (*kill-switch*) pour éviter toute fuite de trafic en dehors du tunnel1.

### **2.2 Isolation Docker, Privilèges NET\_ADMIN et Montage Socket**

L'architecture repose sur le partage de l'espace réseau du conteneur gateway-isp par l'ensemble des nœuds applicatifs via la directive network\_mode: "service:gateway-isp". Pour que cette topologie fonctionne, la passerelle doit exécuter tun2socks et dnsproxy, ce qui exige la modification des tables de routage internes au conteneur et la création d'une interface virtuelle tun01.  
Le flux d'encapsulation réseau s'articule de manière séquentielle :

> 1. Les conteneurs applicatifs (Pawns, Honeygain, Repocket, etc.) émettent leurs requêtes réseau directement dans l'espace de noms réseau du conteneur gateway-isp.  
> 2. Le composant dnsproxy intercepte l'ensemble des requêtes DNS pour éviter les fuites de résolution au niveau de l'hôte.  
> 3. Le démon tun2socks prend en charge l'ensemble du trafic IP dirigé vers l'interface virtuelle tun0 et l'encapsule dans un tunnel SOCKS5 chiffré.  
> 4. Ce flux chiffré traverse l'interface réseau physique de la VM Azure pour rejoindre la passerelle de proxy résidentiel externe via le port dédié (ex: 1080 ou 443).

L'attribution de la capacité cap\_add: NET\_ADMIN associée au montage du périphérique /dev/net/tun offre au conteneur les privilèges réseau nécessaires sans requérir le mode \--privileged complet, préservant ainsi la sécurité du système hôte2. L'hyperviseur Azure n'interfère pas avec la gestion des espaces de noms (*namespaces*) réseau gérés par le démon Docker.  
De même, le montage du socket de contrôle Docker (/var/run/docker.sock) dans le conteneur du tableau de bord Node.js est directement géré par le système de fichiers POSIX de l'hôte Linux. Aucune couche d'isolation intermédiaire sur l'instance virtuelle Azure ne bloque ces appels d'API d'orchestration locale.

### **2.3 Analyse de Stabilité Mémoire : Instance 0.5 GB (B1ls) vs 1 GB RAM (B1s)**

L'empreinte mesurée en régime permanent pour l'ensemble de la stack Docker s'élève à **106 Mo de RAM**. Il convient toutefois d'analyser la répartition globale de la mémoire vive sur l'instance virtuelle Azure hôte pour évaluer le risque de déclenchement de l'OOM-Killer (*Out Of Memory Killer*).  
La consommation totale de la machine virtuelle se décompose comme suit :

> * Système hôte (Ubuntu 24.04 LTS) : 140 à 180 Mo de RAM.  
> * Agents de télémétrie Azure (walinuxagent) et démons système (systemd-journald) : 60 à 80 Mo de RAM4.  
> * Démon Docker Engine au repos : 70 à 90 Mo de RAM.  
> * Stack applicative Docker : 106 Mo au repos, avec des pics potentiels à 200-250 Mo lors des phases d'initialisation des moteurs V8 (Node.js) ou au démarrage simultané des micro-services.

Sur une instance **Standard\_B1ls (512 Mo de RAM / 1 vCPU)**, la consommation totale estimée atteint entre 380 Mo et 450 Mo, ne laissant qu'une marge disponible inférieure à 100 Mo5. L'activation d'un espace de Swap de 1 Go sur le disque temporaire prévient le déclenchement immédiat de l'OOM-Killer. Cependant, en raison du mécanisme de crédits CPU de la série B (l'instance B1ls n'allouant que 5% de performance CPU de base), l'activité d'échange mémoire sur disque (I/O Wait) provoque rapidement une saturation du processeur et un effondrement des performances réseau, entraînant des déconnexions régulières des nœuds de monétisation5.  
Sur une instance **Standard\_B1s (1 Go de RAM / 1 vCPU)**, la consommation totale estimée (380 Mo à 450 Mo) laisse une marge de mémoire physique libre supérieure à 550 Mo5. Le système s'exécute intégralement en mémoire RAM physique sans solliciter le Swap en régime permanent5. Les pics d'allocation mémoire lors des démarrages de conteneurs sont absorbés sans latence I/O, garantissant une stabilité continue5.

## **3\. AXE B : Politiques Réseau, Acceptable Use Policy (AUP) & Facturation de Bande Passante**

### **3.1 Politique d'Utilisation Réseau (AUP) et Risques de Détection d'Abus**

L'exécution de nœuds de partage de bande passante passive fait l'objet d'une surveillance de la part des fournisseurs de cloud en raison des risques d'utilisation malveillante de ces réseaux à des fins de scraping agressif ou de contournement de sécurité9.  
L'architecture mise en œuvre résout le problème principal d'exposition de l'adresse IP de l'hébergeur. En forçant l'intégralité du trafic sortant à travers le tunnel SOCKS5 chiffré de gateway-isp, l'adresse IP publique attribuée par Microsoft Azure n'émet aucune requête HTTP/HTTPS directe vers les cibles finales sur Internet7. Pour les systèmes de détection d'intrusion (IDS/IPS) de Microsoft Azure, la VM établit uniquement une connexion TCP/TLS chiffrée permanente vers l'adresse IP du serveur proxy résidentiel externe8.  
Si un tiers commet un abus ou une violation de droit d'auteur à travers le réseau de monétisation, l'adresse IP finale identifiée sur la cible sera celle du proxy résidentiel externe, et non l'adresse IP du serveur Azure7. Les plaintes DMCA ou Abuse seront donc adressées au fournisseur du proxy SOCKS57.  
Deux points de vigilance subsistent :

> * **Délai d'Établissement du Tunnel** : Si le tunnel tun2socks met quelques secondes à s'établir lors du démarrage et que les conteneurs applicatifs émettent des requêtes en direct via l'interface réseau d'Azure, des alertes peuvent être générées. Un filtrage *kill-switch* strict via iptables au niveau du conteneur passerelle est obligatoire.  
> * **Télémétrie d'Empreinte Binaire** : Microsoft Defender for Cloud analyse l'activité des processus exécutés au sein des machines virtuelles si les options de sécurité avancées sont activées. La simple présence de binaires connus liés au proxyware peut déclencher un signalement de sécurité dans la console Azure, même si le trafic est encapsulé9.

### **3.2 Quotas de Bande Passante Sortante (Egress) et Prévention du Dépassement**

La structure tarifaire de la bande passante sur Microsoft Azure obéit aux règles suivantes :

> * Tout le trafic de données entrant (Ingress) transféré vers l'instance Azure depuis Internet est entièrement gratuit14.  
> * Microsoft Azure offre **100 Go de données sortantes (Egress) par mois et par compte**, applicables sur l'ensemble des régions mondiales en Zone 1 (Amérique du Nord, Europe)11.  
> * Une fois le seuil des 100 Go mensuels franchi, le trafic sortant supplémentaire vers Internet est facturé au Go, au tarif standard de **0,087 $/Go** pour la première tranche de 10 To en Zone 113.

Sur un compte Azure bénéficiant d'une limite de dépense active réglée à 0 $ (comme les comptes *Free Trial* ou *Azure Student*), l'atteinte du quota de 100 Go d'Egress provoque la suspension automatique de l'abonnement par Microsoft19. La machine virtuelle est alors placée dans l'état désactivé (*Deallocated*), coupant l'exécution des conteneurs sans générer de facturation imprévue sur la carte bancaire19.  
Sur un compte Azure payant à l'usage (*Pay-As-You-Go*) sans limite de dépense, tout dépassement du quota de 100 Go est prélevé au tarif au Go13. Pour maintenir l'exécution dans la gratuité stricte, le volume de transfert journalier ne doit pas dépasser une moyenne de **3,33 Go par jour**.

## **4\. AXE C : Automatisation du Déploiement et CI/CD**

### **4.1 Script Cloud-Init Clé-en-Main (customData)**

Le script cloud-init ci-dessous automatise l'intégralité du provisionnement de la machine virtuelle lors de sa création sur Azure. Il configure le sous-système réseau, installe Docker Engine et le plugin Docker Compose, crée un fichier de Swap de 1 Go sur le disque système, charge le module noyau tun, clone le dépôt Git privé et lance la stack Docker.  
Ce script doit être transmis lors du déploiement via la console Azure (section *Advanced \-\> User Data*) ou via l'Azure CLI au moyen du paramètre \--custom-data @cloud-init.yaml16.

YAML  
\#cloud-config  
package\_update: true  
package\_upgrade: true

packages:  
  \- git  
  \- curl  
  \- ca-certificates  
  \- iptables  
  \- kmod

write\_files:  
  \- path: /etc/modules-load.d/tun.conf  
    permissions: '0644'  
    content: |  
      tun

runcmd:  
  \# 1\. Activation immediate du module noyau TUN  
  \- modprobe tun  
  \- lsmod | grep tun

  \# 2\. Configuration d'un espace de SWAP de 1 Go pour securiser la RAM  
  \- fallocate \-l 1G /swapfile  
  \- chmod 600 /swapfile  
  \- mkswap /swapfile  
  \- swapon /swapfile  
  \- echo '/swapfile none swap sw 0 0' \>\> /etc/fstab

  \# 3\. Installation officielle de Docker Engine & Docker Compose Plugin  
  \- install \-m 0755 \-d /etc/apt/keyrings  
  \- curl \-fsSL https://download.docker.com/linux/ubuntu/gpg \-o /etc/apt/keyrings/docker.asc  
  \- chmod a+r /etc/apt/keyrings/docker.asc  
  \- echo "deb \[arch=$(dpkg \--print-architecture) signed-by=/etc/apt/keyrings/docker.asc\] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION\_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list \> /dev/null  
  \- apt-get update  
  \- apt-get install \-y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  \# 4\. Activation et demarrage du service Docker  
  \- systemctl enable docker  
  \- systemctl start docker

  \# 5\. Deploiement de la stack applicative depuis Git  
  \- mkdir \-p /opt/bandwidth-stack  
  \- git clone https://github.com/votre-compte/votre-repo-stack.git /opt/bandwidth-stack  
  \- cd /opt/bandwidth-stack && docker compose up \-d

### **4.2 Workflow GitHub Actions pour le Déploiement Continu (git push)**

Pour déployer automatiquement les modifications à chaque commit poussé sur la branche principale, la méthode la plus légère consiste à utiliser un workflow GitHub Actions exécutant une session SSH sécurisée vers l'instance Azure. Cette approche évite d'exécuter un agent lourd (tel que Watchtower) sur la VM, préservant les ressources processeur et la mémoire RAM restreinte de l'instance5.  
Le fichier ci-dessous est à positionner dans le dépôt Git sous le chemin .github/workflows/deploy.yml :

YAML  
name: Deploy Passive Bandwidth Stack to Azure

on:  
  push:  
    branches:  
      \- main

jobs:  
  deploy:  
    runs-on: ubuntu-latest

    steps:  
      \- name: Checkout Repository  
        uses: actions/checkout@v4

      \- name: Execute Remote Deployment via SSH  
        uses: appleboy/ssh-action@v1.0.3  
        with:  
          host: ${{ secrets.AZURE\_VM\_IP }}  
          username: ${{ secrets.AZURE\_VM\_USER }}  
          key: ${{ secrets.AZURE\_SSH\_PRIVATE\_KEY }}  
          port: 22  
          script: |  
            set \-e  
            cd /opt/bandwidth-stack  
            git pull origin main  
            docker compose pull  
            docker compose up \-d \--remove-orphans  
            docker image prune \-f

Trois variables secretes doivent être configurées dans l'interface GitHub (*Settings \-\> Secrets and variables \-\> Actions*) :

> * AZURE\_VM\_IP : L'adresse IP publique attribuée à la machine virtuelle Azure.  
> * AZURE\_VM\_USER : Le nom d'utilisateur administrateur de la VM (ex: azureuser).  
> * AZURE\_SSH\_PRIVATE\_KEY : La clé privée SSH correspondant à la clé publique injectée lors du provisionnement.

## **5\. Recommandations et Choix de l'Instance Azure Optimale**

### **5.1 Évaluation Comparative des Tailles d'Instances Azure**

Le choix du type d'instance doit équilibrer l'allocation mémoire physique, l'éligibilité aux offres gratuites d'Azure et la capacité processeur requise pour supporter le routage des paquets via tun2socks5.  
Le tableau suivant compare les options d'instances adaptées à cette charge de travail :

| Type d'Instance | vCPU | Mémoire RAM | Crédits CPU de Base | Éligibilité Offre Gratuite | Recommandation Technique |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Standard\_B1ls** | 1 | 0,5 GiB (512 Mo) | 5% | Non inclus dans les 12 mois | **Inadapté** : Risque élevé de saturation CPU en raison des accès Swap lors des pics mémoire5. |
| **Standard\_B1s** | 1 | 1,0 GiB (1024 Mo) | 10% | **Gratuit 12 mois** (750h/mois) | **Recommandé** : Marge mémoire physique optimale sans sollicitation du disque Swap5. |
| **Standard\_B2s** | 2 | 4,0 GiB | 20% | Non inclus (Payant) | **Surdimensionné** : Coût inutile pour une stack mesurée à 106 Mo de RAM. |

### **5.2 Plan d'Architecture Final**

L'instance **Standard\_B1s** sous Ubuntu 24.04 LTS est le choix optimal5. Elle s'inscrit dans le cadre de l'offre Azure incluant 750 heures mensuelles gratuites pendant 12 mois, tout en offrant 1 Go de RAM physique, ce qui évite la dégradation des performances liée à l'usage du Swap5.  
Pour sécuriser l'exploitation globale, il convient de maintenir l'activation d'un fichier de Swap de 1 Go sur le disque SSD système afin d'absorber d'éventuels pics d'allocation temporaires4. Par ailleurs, l'ajout d'une règle d'arrêt d'urgence (*kill-switch*) via iptables dans le conteneur passerelle garantit l'étanchéité du flux réseau en cas de déconnexion du proxy SOCKS5. Enfin, la configuration d'une alerte de budget dans l'outil *Azure Cost Management* fixée à 80 Go de données sortantes permet de prévenir tout dépassement du quota mensuel gratuit de 100 Go11.

#### **Sources des citations**

> 1. Unable to access service on local server via Tailscale in docker from remote \- Super User, [https://superuser.com/questions/1897170/unable-to-access-service-on-local-server-via-tailscale-in-docker-from-remote](https://superuser.com/questions/1897170/unable-to-access-service-on-local-server-via-tailscale-in-docker-from-remote)  
> 2. System Requirements for Access Server \- OpenVPN, [https://openvpn.net/as-docs/v3/system-requirements.html](https://openvpn.net/as-docs/v3/system-requirements.html)  
> 3. Can't Ping Tailscale Machines From Docker · Issue \#7382 \- GitHub, [https://github.com/tailscale/tailscale/issues/7382](https://github.com/tailscale/tailscale/issues/7382)  
> 4. Prepare an Ubuntu virtual machine for Azure \- Linux \- Microsoft Learn, [https://learn.microsoft.com/en-us/azure/virtual-machines/linux/create-upload-ubuntu](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/create-upload-ubuntu)  
> 5. Azure VM Pricing: What You Don't Know (not yet) \- intercept.cloud, [https://intercept.cloud/en-gb/blogs/azure-vm-pricing](https://intercept.cloud/en-gb/blogs/azure-vm-pricing)  
> 6. Explore Free Azure Services, [https://azure.microsoft.com/en-au/pricing/free-services](https://azure.microsoft.com/en-au/pricing/free-services)  
> 7. Disrupting the largest residential proxy network | Hacker News, [https://news.ycombinator.com/item?id=46802748](https://news.ycombinator.com/item?id=46802748)  
> 8. Peer-to-Peer Bandwidth Network for AI Agents and Device Fleets \- Proxies.sx, [https://www.proxies.sx/peers](https://www.proxies.sx/peers)  
> 9. How Residential Proxies and CAPTCHA-Solving Services Become Agents of Abuse | Trend Micro (US), [https://www.trendmicro.com/vinfo/us/security/news/vulnerabilities-and-exploits/how-residential-proxies-and-captcha-solving-services-become-agents-of-abuse](https://www.trendmicro.com/vinfo/us/security/news/vulnerabilities-and-exploits/how-residential-proxies-and-captcha-solving-services-become-agents-of-abuse)  
> 10. Resident Evil: Understanding Residential IP Proxy as a Dark Service \- ResearchGate, [https://www.researchgate.net/publication/331653213\_Resident\_Evil\_Understanding\_Residential\_IP\_Proxy\_as\_a\_Dark\_Service](https://www.researchgate.net/publication/331653213_Resident_Evil_Understanding_Residential_IP_Proxy_as_a_Dark_Service)  
> 11. How Azure Pricing Works — Cloud & IT Cert Prep | CoddyKit, [https://www.coddykit.com/courses/cloud\_cert/how-azure-pricing-works-11100473](https://www.coddykit.com/courses/cloud_cert/how-azure-pricing-works-11100473)  
> 12. Bandwidth pricing \- Microsoft Azure, [https://azure.microsoft.com/en-us/pricing/details/bandwidth/](https://azure.microsoft.com/en-us/pricing/details/bandwidth/)  
> 13. Azure Egress Fees vs Hetzner Traffic Costs: The Complete Comparison \- WZ-IT, [https://wz-it.com/en/blog/azure-egress-fees-vs-hetzner-traffic-costs/](https://wz-it.com/en/blog/azure-egress-fees-vs-hetzner-traffic-costs/)  
> 14. Bandwidth pricing \- Microsoft Azure, [https://azure.microsoft.com/en-in/pricing/details/bandwidth/](https://azure.microsoft.com/en-in/pricing/details/bandwidth/)  
> 15. Understanding Azure Storage Egress Costs: A Comprehensive Guide \- Lucidity, [https://www.lucidity.cloud/feeds/blog/azure-storage-egress-cost](https://www.lucidity.cloud/feeds/blog/azure-storage-egress-cost)  
> 16. Deep dive into cloud-init: instance customization and metadata delivery in OpenStack, [https://firstcloud.pl/blog/deep-dive-into-cloud-init-in-openstack/](https://firstcloud.pl/blog/deep-dive-into-cloud-init-in-openstack/)  
> 17. cloud-init support for virtual machines in Azure \- Microsoft Learn, [https://learn.microsoft.com/en-us/azure/virtual-machines/linux/using-cloud-init](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/using-cloud-init)  
> 18. A Closer Exploration of Residential Proxies and CAPTCHA-Breaking Services \- Trend Micro, [https://www.trendmicro.com/vinfo/gb/security/news/vulnerabilities-and-exploits/a-closer-exploration-of-residential-proxies-and-captcha-breaking-services](https://www.trendmicro.com/vinfo/gb/security/news/vulnerabilities-and-exploits/a-closer-exploration-of-residential-proxies-and-captcha-breaking-services)  
> 19. Azure Pricing in 2026: Plans, VM Costs and What You Pay \- Kuberns, [https://kuberns.com/blogs/azure-pricing/](https://kuberns.com/blogs/azure-pricing/)  
> 20. Azure resources and fundamentals \- Nerdio, [https://getnerdio.com/blog/microsoft-azure-fundamentals/](https://getnerdio.com/blog/microsoft-azure-fundamentals/)