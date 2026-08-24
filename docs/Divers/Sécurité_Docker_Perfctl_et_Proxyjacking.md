# **Analyse de la menace Perfctl et du Proxyjacking sur les hôtes Docker : Vecteurs d'exploitation, intégrité de la supply-chain et durcissement avancé**

Le paysage de la sécurité des conteneurs Linux fait face à une convergence critique entre des malwares d'infrastructure hautement évasifs et des modèles d'exploitation financière indirects1. Détecté initialement dès 2021 et documenté à grande échelle en 2024, le malware connu sous le nom de **Perfctl** illustre l'évolution des menaces ciblant l'écosystème cloud natif1. Parallèlement, le phénomène de **Proxyjacking** — le détournement non autorisé de la bande passante réseau via des applications de monétisation peer-to-peer telles que Honeygain, IPRoyal Pawns ou PacketStream — transforme les serveurs compromis en relais pour des flux illicites tout en générant des coûts d'infrastructure non négligeables3.  
Ce rapport présente une analyse approfondie des vecteurs de compromission utilisés par Perfctl, examine l'intégrité de la chaîne logistique logicielle (*supply chain*) des conteneurs de monétisation, et fournit une matrice de durcissement opérationnelle pour neutraliser ces menaces sur les hôtes Docker Linux.

## **1\. Vecteurs d'attaque et dynamique de compromission de Perfctl**

Perfctl se distingue par une architecture modulaire et un niveau de furtivité conçu pour déjouer les solutions d'analyse médico-légale et de détection d'intrusion traditionnelles1. L'attaquant cible activement les serveurs Linux exposés sur Internet en scannant des dizaines de milliers de mauvaises configurations et de vulnérabilités connues afin de s'implanter au niveau de l'hôte et de l'orchestration de conteneurs2.

### **1.1 Exploitation des API Docker distantes et interfaces d'administration**

Le principal vecteur d'intrusion observé dans les campagnes récentes repose sur l'exploitation des démons Docker dont l'API REST distante (ports 2375 en HTTP non chiffré ou 2376 mal configuré sans authentification mutuelle mTLS) est accessible publiquement1.  
La séquence d'attaque suit une méthodologie rigoureusement articulée :

> * **Reconnaissance et instanciation de conteneurs leurres** : L'attaquant sonde l'hôte via des requêtes *ping* sur l'API Docker, puis initie le déploiement d'un conteneur trompeur nommé kube-edagent, instancié à partir d'une image légitime comme ubuntu:mantic-202404054.  
> * **Configuration d'évasion (*Container Breakout*)** : Le conteneur est créé avec les drapeaux Privileged: true et pid mode: host4. L'utilisation de l'espace de noms PID de l'hôte permet aux processus internes du conteneur d'interagir directement avec la table des processus du système hôte4.  
> * **Échappement par substitution d'espaces de noms** : Via l'API Exec, l'attaquant invoque la commande nsenter en ciblant le PID 1 de l'hôte (nsenter \--mount \--uts \--ipc \--net \--pid \-t 1), s'affranchissant totalement de l'isolation du conteneur pour exécuter des commandes arbitraires avec les privilèges root sur l'hôte sous-jacent4.

Concernant les interfaces de gestion telles que **Portainer**, deux risques majeurs sont exploités :

> * **Exposition non protégée ou comptes compromis** : L'accès à une interface Portainer non verrouillée confère des capacités équivalentes à un accès direct à l'API Docker, permettant l'instanciation de conteneurs privilégiés ou le montage arbitraire du système de fichiers racine de l'hôte9.  
> * **Attaques par typosquatting de registres** : Des groupes d'attaquants déploient sur Docker Hub des comptes aux noms trompeurs (par exemple portaienr ou des images usurpant des outils officiels) intégrant des outils offensifs comme DEEPCE (*Docker Elevation of Privilege and Container Escape*) pour automatiser le vol de sockets Unix (/var/run/docker.sock) et la prise de contrôle de l'infrastructure9.

### **1.2 Exploitation de failles applicatives RCE et élévation de privilèges**

Lorsque l'API Docker n'est pas exposée directement, Perfctl exploite des vulnérabilités d'exécution de code à distance (RCE) sur des services applicatifs hébergés au sein de conteneurs ou sur l'hôte, notamment la faille Apache RocketMQ (CVE-2023-33246), Apache Solr ou Log4Shell (CVE-2021-44228)1.  
Une fois un premier pied posé avec des privilèges restreints, le malware exécute des exploits locaux d'élévation de privilèges, ciblant quasi-systématiquement la vulnérabilité **PwnKit** au sein de Polkit (CVE-2021-4034), garantissant l'obtention immédiate des accès root sur les distributions Linux non corrigées1.

### **1.3 Mécanismes d'évasion, rootkits et persistance**

La sophistication de Perfctl réside dans sa suite complète de contre-mesures face aux analystes de sécurité et aux outils EDR/FIM :

> * **Téléchargement obfusqué et suppression de binaire** : Le binaire principal ELF httpd (MD5: 656e22c65bf7c04d87b5afbe52b8d800) est délivré par un serveur C2 qui renvoie un code factice (entier 1\) si la requête HTTP n'intègre pas un User-Agent précis7. Dès son exécution, le binaire copie sa charge utile dans /tmp sous un nom anodin (ex. sh, bash), exécute la copie, supprime le fichier d'origine et tourne exclusivement depuis la mémoire7.  
> * **Rootkit noyau et hooking de bibliothèques partagées** : Le malware dépose une bibliothèque partagée malveillante nommée libgcwrap.so (MD5: 835a9a6908409a67e51bce69f80dd58a), injectée via /etc/ld.so.preload7. Ses chaînes internes sont chiffrées avec une clé XOR 0xAC7. Ce rootkit détourne spécifiquement :  
  * pam\_authenticate : pour contourner les vérifications d'authentification et intercepter les identifiants système7.  
  * pcap\_loop : pour altérer les captures de paquets réseau et masquer le trafic du malware face aux outils de surveillance comme tcpdump7.  
> * **Rootkits en espace utilisateur (*User-land*)** : Perfctl déploie des versions trojanisées d'utilitaires standards (top, lsof, ldd, crontab) dans des répertoires prioritaires du PATH (ex. \~/.local/bin/), masquant ses processus de minage, ses fichiers ouverts et ses tâches planifiées aux yeux des administrateurs7.  
> * **Évasion comportementale par détection de sessions interactives** : Le processus surveille en temps réel les fichiers utmp et btmp7. Dès qu'une connexion interactive SSH/TTY est initiée par un administrateur, Perfctl suspend instantanément ses activités consommatrices de CPU (minage XMRig) et entre en sommeil pour ne générer aucune anomalie sur les graphiques de charge système7.  
> * **Persistance multi-couches** : Le malware installe un service auxiliaire /usr/bin/wizlmsh (MD5: ba120e9c7f8896d9148ad37f02b0e3cb), crée des services systemd (multi-user.target), modifie \~/.profile et installe des tâches cron redondantes4. Les communications de commande et contrôle (C2) transitent via des sockets Unix locaux et des relais du réseau TOR (ex. 192.121.108.237), rendant le filtrage IP difficile sans inspection comportementale approfondie4.

| Composant / Artefact | Type d'artefact | Hash MD5 / Localisation standard | Rôle opérationnel et fonction malveillante |
| :---- | :---- | :---- | :---- |
| **httpd** | Binaire ELF (Packed) | 656e22c65bf7c04d87b5afbe52b8d800 / /tmp/httpd | Dropper initial et coordinateur d'exécution en mémoire7 |
| **wizlmsh** | Binaire ELF (12 KB) | ba120e9c7f8896d9148ad37f02b0e3cb / /usr/bin/wizlmsh | Service de maintien de persistance et surveillance d'état7 |
| **libgcwrap.so** | Bibliothèque partagée | 835a9a6908409a67e51bce69f80dd58a / /usr/lib/ | Rootkit LD\_PRELOAD, hooking de PAM et Libpcap7 |
| **perfcc / perfctl** | Binaire ELF | /root/.config/cron/perfcc, /usr/bin/perfcc | Moteur de cryptominage Monero (XMRig) et Proxyjacking7 |
| **libpprocps.so** | Bibliothèque partagée | /usr/lib/, /tmp/ | Masquage de processus et soutien à l'évasion défensive7 |
| **kubeupd** | Script Shell | /tmp/kubeupd | Script de déploiement, configuration d'environnement et fallback4 |

## **2\. Intégrité de la supply-chain des conteneurs de monétisation et menace de Proxyjacking**

Le déploiement de conteneurs de partage de bande passante (Honeygain, Pawns/IPRoyal, Repocket, PacketStream, Antgain, Traffmonetizer, Peer2Profit) s'est popularisé sous le couvert d'activités de monétisation passive3. Néanmoins, l'analyse des risques met en évidence des vulnérabilités majeures au niveau de la chaîne d'approvisionnement logicielle et des risques collatéraux sévères pour les infrastructures hôtes3.

### **2.1 Anatomie du Proxyjacking et modèle d'exploitation**

Le *Proxyjacking* est l'analogue réseau du *Cryptojacking* : au lieu d'exploiter la puissance de calcul (CPU/GPU) pour miner des cryptomonnaies, l'attaquant détourne la connexion Internet et l'adresse IP de la victime pour les vendre à des réseaux de proxyware résidentiels3.

> * **Furtivité opérationnelle asymétrique** : Contrairement aux mineurs comme XMRig qui saturent les processeurs à 100 % et déclenchent des alertes métriques immédiates, le proxyware consomme une quantité négligeable de CPU et de mémoire RAM3. Quelques dizaines de mégaoctets de trafic réseau par jour suffisent à générer des revenus pour l'attaquant sans éveiller les soupçons des systèmes de supervision conventionnels3.  
> * **Campagnes multi-menaces** : Des groupes cybercriminels déploient conjointement des charges de minage et de proxyjacking (comme observé dans les campagnes *LoveMiner* et *LABRAT*) pour maximiser leurs profits sur chaque machine compromise5. Dans le cadre de la campagne LABRAT documentée par Sysdig, les attaquants ont utilisé des bibliothèques .NET Core obfusquées pour déployer le proxyware russe *ProxyLite* sur des infrastructures Linux compromises15.

### **2.2 Risques avérés sur la Supply-Chain Docker Hub**

L'utilisation d'images Docker prêtes à l'emploi pour ces services comporte des risques démontrés :

> * **Prolifération d'images non officielles et empoisonnées** : La majorité des services de monétisation ne maintiennent pas systématiquement des images officielles certifiées avec signature cryptographique (Docker Content Trust ou Cosign). Les utilisateurs s'orientent fréquemment vers des dépôts communautaires tiers hébergés sur Docker Hub3. Les équipes de recherche identifient régulièrement des images packagées contenant des portes dérobées, des scripts de scan réseau internes ou des mineurs secondaires dissimulés dans les couches de base3.  
> * **Exécution de binaires propriétaires opaques** : Les agents fournis par ces plateformes sont des binaires propriétaires, fermés (*closed-source*) et fréquemment obfusqués pour empêcher le reverse engineering de leurs protocoles de communication15. Cette opacité empêche tout audit statique traditionnel sur les fonctionnalités réelles intégrées dans l'agent.  
> * **Risque de rebond latéral (*Lateral Movement*)** : Si un conteneur de proxyware est compromis via une vulnérabilité de son code sous-jacent, l'attaquant peut l'utiliser comme tête de pont pour cartographier le réseau interne du conteneur et scanner les sous-réseaux locaux3.

### **2.3 Impacts légaux, opérationnels et financiers**

L'hébergement de ces nœuds de monétisation expose l'infrastructure à des conséquences critiques :

> * **Dégradation de réputation d'IP et bannissement** : Les acheteurs de bande passante sur ces réseaux utilisent fréquemment les adresses IP résidentielles ou serveurs pour contourner des protections anti-bot, effectuer du scraping agressif, lancer des attaques par force brute ou relayer des activités cybercriminelles1. L'adresse IP de l'hôte se retrouve inscrite sur les listes noires de réputation (RBL, Spamhaus), bloquant les services légitimes hébergés sur le même réseau3.  
> * **Facturation asymétrique dans le Cloud (*Egress Costs*)** : Alors que l'utilisateur perçoit des revenus minimes (souvent inférieurs à 0,20 $ par gigaoctet partagé), les fournisseurs de cloud public facturent la bande passante sortante (*Data Transfer Out*) entre 0,05 ![][image1] par Go3. Le modèle est structurellement déficitaire et expose à des factures massives en cas de trafic soutenu3.  
> * **Exposition légale et réglementaire** : Le trafic transitant par le conteneur sortant directement avec l'IP publique du serveur, les équipes d'ingénierie peuvent faire l'objet de réquisitions judiciaires pour des infractions commises par des tiers via leur passerelle3.

| Service de Proxyware | Modèle d'authentification | Disponibilité d'images / Conteneurs | Niveau de risque Supply-Chain | Impacts principaux observés |
| :---- | :---- | :---- | :---- | :---- |
| **Honeygain** | Authentification par compte / Token | Images Docker communautaires dominantes | Élevé (multiplicité de builds tiers non vérifiés) | Utilisation de l'IP pour le scraping massif, risque de liste noire RBL3 |
| **IPRoyal Pawns (Pawns.app)** | Email / Mot de passe requis au lancement5 | Binaires Linux / Conteneurs Docker non officiels | Élevé (ciblé activement dans des campagnes de proxyjacking)5 | Trafic sortant incontrôlé, exploitation observée via Log4j3 |
| **PacketStream** | Identifiant de compte (CID) | Images Docker wrappers communautaires | Moyen à Élevé (binaires propriétaires opaques) | Relais de requêtes HTTP/S non filtrées, consommation de bande passante5 |
| **Traffmonetizer** | Token de compte unique | Images distribuées sur Docker Hub | Élevé (souvent packagé avec d'autres charges malveillantes)5 | Intégration fréquente dans des droppers multi-proxyjacking5 |
| **Peer2Profit / ProxyLite** | Email / Token API | Multi-plateforme (Linux, x86, ARM, wrappers)3 | Critique (absence totale de filtrage sur l'origine des IP)3 | Détourné massivement par les campagnes de malwares (LABRAT)5 |

## **3\. Checklist actionnable de durcissement (Hardening) pour hôtes Docker**

Pour héberger des conteneurs isolés ou se prémunir contre des intrusions avancées du type Perfctl, l'application d'un durcissement en profondeur sur les couches Système, Démon Docker, Réseau et Runtime est impérative.

### **3.1 Sécurisation du moteur Docker et élimination des vecteurs d'évasion**

> * **Fermeture de l'API Docker non authentifiée** : L'écoute de l'API Docker sur 0.0.0.0:2375 doit être strictement proscrite. Si un contrôle à distance est requis, implémenter impérativement une authentification mutuelle par certificats TLS (mTLS) sur le port 2376, ou encapsuler l'accès à travers un tunnel SSH restreint.  
> * **Protection stricte du socket Unix Docker** : Ne jamais monter le fichier /var/run/docker.sock à l'intérieur d'un conteneur applicatif ou d'un conteneur tiers9. Restreindre les permissions du socket sur l'hôte aux seuls membres du groupe d'administration docker (chmod 660).  
> * **Activation des espaces de noms utilisateurs (*User Namespaces Remapping*)** : Configurer /etc/docker/daemon.json avec "userns-remap": "default" afin que le compte root (UID 0\) à l'intérieur d'un conteneur corresponde à un UID non privilégié (ex. UID 100000\) sur l'hôte, neutralisant les tentatives d'évasion directe.  
> * **Durcissement de Portainer** : En cas d'utilisation de Portainer, exiger l'authentification multifacteur (MFA), changer les identifiants par défaut dès l'initialisation, et ne jamais exposer son interface web directement sur l'Internet public sans reverse-proxy sécurisé avec filtrage IP.

### **3.2 Confinement strict des conteneurs à l'exécution**

Tout conteneur de proxyware ou service non vérifié doit être exécuté dans un bac à sable restreint :

> * **Suppression absolue des privilèges** : Proscrire systématiquement l'usage des paramètres \--privileged, \--net=host et \--pid=host4.  
> * **Système de fichiers en lecture seule** : Instancier les conteneurs avec le paramètre \--read-only. Tout répertoire temporaire nécessaire doit être fourni via des volumes en mémoire temporaires dédiés : \--tmpfs /tmp:rw,noexec,nosuid,size=64m.  
> * **Privation des capacités Linux (*Linux Capabilities*)** : Retirer l'ensemble des capacités par défaut et n'accorder que le strict nécessaire, en combinant l'interdiction d'élévation de privilèges (--security-opt=no-new-privileges:true) et l'exécution sous un UID/GID non-root dédié :  
>   Bash  
>   docker run \-d \\  
>     \--name proxy\_node \\  
>     \--read-only \\  
>     \--cap-drop=ALL \\  
>     \--cap-add=NET\_BIND\_SERVICE \\  
>     \--security-opt=no-new-privileges:true \\  
>     \--user 10001:10001 \\  
>     \--memory="512m" \\  
>     \--cpus="0.5" \\  
>     \--tmpfs /tmp:rw,noexec,nosuid,size=32m \\  
>     \--network proxy\_isolated\_net \\  
>     image\_name:tag

### **3.3 Isolation et filtrage réseau au niveau pare-feu (iptables)**

Les conteneurs de proxyware doivent être isolés du réseau local interne et des services de métadonnées du cloud :

> * **Interdiction d'accès à l'Instance Metadata Service (IMDS)** : Sur les environnements cloud (AWS, GCP, Azure, OpenStack), bloquer impérativement l'accès à l'adresse IP 169.254.169.254 pour empêcher le vol de tokens IAM et de clés d'accès machine16.  
> * **Blocage des sous-réseaux privés (RFC 1918\)** : Empêcher le conteneur de router des paquets vers l'infrastructure interne ou les autres machines du LAN18.  
> * **Règles iptables dans la chaîne DOCKER-USER** :  
>   Bash  
>   \# Blocage de l'accès aux métadonnées Cloud (169.254.169.254)  
>   iptables \-I DOCKER-USER \-i docker0 \-d 169.254.169.254/32 \-j DROP

>   \# Blocage des accès vers les sous-réseaux privés RFC1918  
>   iptables \-I DOCKER-USER \-i docker0 \-d 10.0.0.0/8 \-j DROP  
>   iptables \-I DOCKER-USER \-i docker0 \-d 172.16.0.0/12 \-j DROP  
>   iptables \-I DOCKER-USER \-i docker0 \-d 192.168.0.0/16 \-j DROP

>   \# Blocage de l'accès direct aux ports d'administration de l'hôte  
>   iptables \-I DOCKER-USER \-i docker0 \-d 172.17.0.1 \-j DROP

> * **Isolation Inter-Conteneurs** : Configurer les réseaux virtuels Docker avec l'option \--opt com.docker.network.bridge.enable\_icc=false pour empêcher deux conteneurs d'un même bridge de communiquer entre eux20.

### **3.4 Durcissement du système d'exploitation hôte Linux**

> * **Montage sécurisé des partitions temporaires** : Modifier /etc/fstab sur l'hôte pour monter /tmp et /dev/shm avec les options noexec,nosuid,nodev afin de bloquer l'exécution de binaires malveillants décompressés dans ces répertoires7.  
> * **Application stricte des correctifs de vulnérabilités critiques** : Déployer sans délai les patchs de sécurité du noyau et des bibliothèques système, en priorité contre la faille Polkit (CVE-2021-4034 / PwnKit)1.  
> * **Surveillance d'intégrité des fichiers (FIM) et audit du chargeur dynamique** : Contrôler en continu l'intégrité du fichier /etc/ld.so.preload et des dossiers de binaires partagés (/lib, /usr/lib) pour détecter tout ajout non autorisé de bibliothèques du type libgcwrap.so7. Auditer l'intégrité des binaires administratifs (/bin/ldd, /usr/bin/top, /usr/bin/lsof, /usr/bin/crontab) via des signatures de packages (debsums \-c sous Debian/Ubuntu ou rpm \-V sous RHEL/Rocky)7.

### **3.5 Détection comportementale en temps réel (Falco / eBPF)**

Le déploiement de sondes de sécurité à l'exécution basées sur eBPF (comme Falco ou Tracee) permet d'intercepter les comportements d'attaque de Perfctl et du Proxyjacking dès leur phase d'initialisation21 :

> * **Détection de l'utilisation d'outils d'évasion de conteneurs (nsenter)**4 :  
>   YAML  
>   \- rule: Container Escape via nsenter  
>     desc: Detects execution of nsenter inside a container attempting namespace switching  
>     condition: container.id \!= host and proc.name \= "nsenter"  
>     output: "Namespace escape attempt detected (user=%user.name command=%proc.cmdline container=%container.name)"  
>     priority: CRITICAL  
>     tags: \[container, escape, mitre\_privilege\_escalation\]

> * **Détection d'exécution binaire depuis des répertoires temporaires**7 :  
>   YAML  
>   \- rule: Execution from Suspicious Directory  
>     desc: Detects binary execution from /tmp or /dev/shm  
>     condition: spawned\_process and (proc.exepath startswith "/tmp/" or proc.exepath startswith "/dev/shm/")  
>     output: "Binary executed from suspicious directory (proc=%proc.name path=%proc.exepath cmd=%proc.cmdline container=%container.name)"  
>     priority: HIGH  
>     tags: \[execution, malware, perfctl\]

> * **Détection d'altération de l'environnement de préchargement dynamique**7 :  
>   YAML  
>   \- rule: Modification of ld.so.preload  
>     desc: Detects tampering with ld.so.preload indicating rootkit deployment  
>     condition: (open\_write or modify) and fd.name \= "/etc/ld.so.preload"  
>     output: "Rootkit deployment detected: ld.so.preload modified (user=%user.name file=%fd.name command=%proc.cmdline)"  
>     priority: EMERGENCY  
>     tags: \[persistence, rootkit, defense\_evasion\]

| Domaine de Sécurité | Mesure de Durcissement | Mécanisme de Mise en Œuvre | Niveau de Priorité |
| :---- | :---- | :---- | :---- |
| **API Docker** | Fermeture port 2375 / mTLS sur 2376 | Fichier /etc/docker/daemon.json ("hosts": \["unix:///var/run/docker.sock"\]) | **Critique** \[cite: 4\] |
| **Isolation Système** | Remapping des namespaces utilisateurs | Directive "userns-remap": "default" dans daemon.json | **Haute** |
| **Confinement Conteneur** | Déni de privilèges & rootfs read-only | Options CLI : \--read-only \--cap-drop=ALL \--security-opt=no-new-privileges | **Critique** \[cite: 4\] |
| **Sécurité Réseau** | Blocage IMDS Cloud (169.254.169.254) | Règle iptables \-I DOCKER-USER \-i docker0 \-d 169.254.169.254/32 \-j DROP | **Critique** \[cite: 16, 18\] |
| **Sécurité Réseau** | Isolation des sous-réseaux locaux RFC1918 | Règles iptables DOCKER-USER vers 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 | **Haute** \[cite: 18, 19\] |
| **OS Hôte** | Protection des montages temporaires | Configuration /etc/fstab avec options noexec,nosuid,nodev sur /tmp | **Haute** \[cite: 7\] |
| **OS Hôte** | Correction des vulnérabilités locales | Mise à jour des paquets Polkit (CVE-2021-4034) et Kernel | **Critique** \[cite: 1, 7\] |
| **Surveillance Runtime** | Détection d'anomalies comportementales | Règles Falco (surveillance de nsenter, /tmp/httpd, ld.so.preload) | **Haute** \[cite: 4, 7, 22\] |

## **4\. Recommandations stratégiques et conclusions**

L'émergence conjointe de menaces d'infrastructure avancées comme **Perfctl** et de mécanismes de monétisation furtifs comme le **Proxyjacking** illustre la nécessité d'adopter une posture de sécurité sans confiance (*Zero Trust*) sur les hôtes de conteneurs Linux1.  
Perfctl démontre que les attaquants modernes combinent des rootkits en espace noyau/utilisateur, détournent des appels système critiques (pam\_authenticate, pcap\_loop), exploitent les mécanismes d'isolation de conteneurs (nsenter, PID sharing) et utilisent des tactiques d'évasion contextuelle pour résister à l'analyse médico-légale4. Parallèlement, l'introduction de conteneurs de monétisation (proxyware) au sein d'une infrastructure crée une brèche majeure dans la supply-chain, exposant l'adresse IP de l'hôte à des activités cybercriminelles tierces et générant des surcoûts d'infrastructure imprévus3.  
Pour maintenir un niveau d'assurance de sécurité élevé :

> * Aucune image de conteneur tierce ou non vérifiée ne doit être exécutée sans confinement strict (read-only, cap-drop=ALL, no-new-privileges).  
> * L'API Docker ne doit jamais être exposée publiquement sans isolation cryptographique et réseau complète4.  
> * Le filtrage réseau au niveau de l'hôte (chaîne DOCKER-USER) doit bloquer tout accès aux services de métadonnées de cloud (169.254.169.254) et aux segments réseau internes sensibles16.  
> * Une détection comportementale en temps réel via eBPF (Falco) doit être privilégiée face aux mécanismes de FIM statiques traditionnels, afin d'intercepter les dérivations d'exécution dès la phase d'instanciation des processus21.

#### **Sources des citations**

> 1. Focus sur Perfctl : Le malware ciblant les systèmes Linux \- ITrust, [https://www.itrust.fr/focus-sur-perfctl-le-malware-ciblant-les-systemes-linux](https://www.itrust.fr/focus-sur-perfctl-le-malware-ciblant-les-systemes-linux)  
> 2. Near-'perfctl' Fileless Malware Targets Millions of Linux Servers \- Dark Reading, [https://www.darkreading.com/threat-intelligence/perfctl-fileless-malware-targets-millions-linux-servers](https://www.darkreading.com/threat-intelligence/perfctl-fileless-malware-targets-millions-linux-servers)  
> 3. Proxyjacking has Entered the Chat \- Sysdig, [https://www.sysdig.com/blog/proxyjacking-attackers-log4j-exploited](https://www.sysdig.com/blog/proxyjacking-attackers-log4j-exploited)  
> 4. Attackers Target Exposed Docker Remote API Servers With perfctl Malware \- Trend Micro, [https://www.trendmicro.com/fr\_fr/research/24/j/attackers-target-exposed-docker-remote-api-servers-with-perfctl-.html](https://www.trendmicro.com/fr_fr/research/24/j/attackers-target-exposed-docker-remote-api-servers-with-perfctl-.html)  
> 5. Analysis of MS-SQL Server Proxyjacking Cases \- ASEC \- AhnLab, [https://asec.ahnlab.com/en/56350/](https://asec.ahnlab.com/en/56350/)  
> 6. perfctl Malware Targeting Linux \- Cloud Threat Landscape, [https://threats.wiz.io/all-incidents/perfctl-malware-targeting-linux](https://threats.wiz.io/all-incidents/perfctl-malware-targeting-linux)  
> 7. perfctl: A Stealthy Malware Targeting Millions of Linux Servers \- Aqua Security, [https://www.aquasec.com/blog/perfctl-a-stealthy-malware-targeting-millions-of-linux-servers/](https://www.aquasec.com/blog/perfctl-a-stealthy-malware-targeting-millions-of-linux-servers/)  
> 8. Perfctl Malware Targets Linux Servers for Cryptocurrency Mining and Proxyjacking, [https://daily.dev/posts/perfctl-malware-targets-linux-servers-for-cryptocurrency-mining-and-proxyjacking-n5fjl7sm6](https://daily.dev/posts/perfctl-malware-targets-linux-servers-for-cryptocurrency-mining-and-proxyjacking-n5fjl7sm6)  
> 9. Market-First Container Image Built to Attack Kubernetes Cluste \- Aqua Security, [https://www.aquasec.com/blog/kubernetes-vulnerability-security-threat/](https://www.aquasec.com/blog/kubernetes-vulnerability-security-threat/)  
> 10. Perfctl malware campaign exploiting RocketMQ vulnerability hits Linux Servers worldwide, [https://www.broadcom.com/support/security-center/protection-bulletin/perfctl-malware-campaign-exploiting-rocketmq-vulnerability-hits-linux-servers-worldwide](https://www.broadcom.com/support/security-center/protection-bulletin/perfctl-malware-campaign-exploiting-rocketmq-vulnerability-hits-linux-servers-worldwide)  
> 11. Advisory: Perfctl Crypto Mining Threat on Linux Servers, [https://linuxsecurity.com/news/hackscracks/perfctl-malware-unveiled](https://linuxsecurity.com/news/hackscracks/perfctl-malware-unveiled)  
> 12. Threat Alert: Supply Chain Attacks Using Container Images \- Aqua Security, [https://www.aquasec.com/blog/supply-chain-threats-using-container-images/](https://www.aquasec.com/blog/supply-chain-threats-using-container-images/)  
> 13. Cryptomining Supply-Chain Abuse on Docker Hub: Hiding Malware in Plain Sight \- Flare, [https://flare.io/learn/resources/blog/cryptomining-supply-chain-abuse-docker-hub-malware](https://flare.io/learn/resources/blog/cryptomining-supply-chain-abuse-docker-hub-malware)  
> 14. Hackers using Log4j bug to profit from victim IP addresses through 'proxyjacking' scheme, [https://therecord.media/hackers-use-log4j-in-proxyjacking-scheme](https://therecord.media/hackers-use-log4j-in-proxyjacking-scheme)  
> 15. LABRAT: Stealthy Cryptojacking and Proxyjacking Campaign Targeting GitLab | Sysdig, [https://www.sysdig.com/blog/labrat-cryptojacking-proxyjacking-campaign](https://www.sysdig.com/blog/labrat-cryptojacking-proxyjacking-campaign)  
> 16. Docker Network Hardening \- Use the Docker network hardening, [https://docs-cortex.paloaltonetworks.com/r/CwPz6Jh\~xfA7VCN6xBuVNg/URE1mohvKdGbl2ZApW4oDg?section=UUID-f005fd37-d26e-81ee-4df9-2bfc4595aa4e\_iddc23fa7a-0b3e-4b9c-9a3f-be3c77ae1d5e](https://docs-cortex.paloaltonetworks.com/r/CwPz6Jh~xfA7VCN6xBuVNg/URE1mohvKdGbl2ZApW4oDg?section=UUID-f005fd37-d26e-81ee-4df9-2bfc4595aa4e_iddc23fa7a-0b3e-4b9c-9a3f-be3c77ae1d5e)  
> 17. GitLab Runner Docker Escape \- Metadata access (\#6729) · Issue · gitlab-com/gl-infra/production-engineering, [https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work\_items/6729](https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/work_items/6729)  
> 18. Docker Network Hardening | 6.14 | Cortex Documentation Portal, [https://docs-cortex.paloaltonetworks.com/r/Cortex-XSOAR/6.14/Cortex-XSOAR-Administrator-Guide/Docker-Network-Hardening](https://docs-cortex.paloaltonetworks.com/r/Cortex-XSOAR/6.14/Cortex-XSOAR-Administrator-Guide/Docker-Network-Hardening)  
> 19. Restricting access to AWS EC2 metadata for specific docker containers \- Server Fault, [https://serverfault.com/questions/969051/restricting-access-to-aws-ec2-metadata-for-specific-docker-containers](https://serverfault.com/questions/969051/restricting-access-to-aws-ec2-metadata-for-specific-docker-containers)  
> 20. Frequently asked questions \- Calico Documentation, [https://docs.tigera.io/calico/latest/reference/faq](https://docs.tigera.io/calico/latest/reference/faq)  
> 21. PROCATCH: Detecting Execution-based Anomalies in Single-Instance Microservices \- Andrea Continella, [https://conand.me/publications/elkhairi-procatch-2025.pdf](https://conand.me/publications/elkhairi-procatch-2025.pdf)  
> 22. Retail tech company triples threat remediation speed with zero, [https://www.sysdig.com/customers/retail-tech-company](https://www.sysdig.com/customers/retail-tech-company)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADkAAAAaCAYAAAANIPQdAAAC3ElEQVR4Xu2WWahOURiGP1MZMqZIkQskRIrMOWYlXLgwRCdTQkhSipyjKMSlJEpRSIYIhTtCMtXJdIG4kSQylZn3Pd/af9/+/r3Z/39Cjv3U0zn7Xevfe6291l5rieTk5NRXpsNr8CK8AifGi0umI2zqw8BkWAPfhb8LYYNYjd/AFPge9gjX/eFbOLJQIxtsaCe4Ar6AA+LFtYyFN2EH2ArugN/hRluproyCI1x2F+5y2SF4yWW/4rHovW6INjypk5wl9uU1gg/hN9jZ5GXDG76UeId6izZomclIdcj5xktljSR3ks//Ch/B1ibfLVp/kcnKZpjozWaYbHbIKk1GVoZ8gsuzkNbJhvBVKOtm8u0h4zPrzDrRadHeZKtFHzDTZGRpyOe5PAtpnST83se57JxofZ8XwanAVeoEPAzPw/mh7Ci8Dz+JLij8/0Ioq5Li0SWLQ85FpFR+1klPF/gZ3hEd6VRaiDaay3/bkDWHzws19PoD3GYyUi1/t5MH4BvY1xd49oqOUtdwzU6vhXuiCmC86IMnmYykTdclIV/g8ixEnRzoCxxzRLeuCpcXwe+Lw/1MdNnnVOXbqRSdwhFbQr2WJiPsHBs01+XRwlPOoSDq5CBfYOgnupeO9gVJDBG94Xpf4Lguukd5eor+fpXLN4WcJ5dSiTo52BcE2sF7En+BFaKnrkSiRiatgnxbPIVwT+L+xIYTNnx/VEl0A+deZTkJL5trHtE4O7J0OuokB8DD2XUGTnP5BjjVZQW4InGU7AbfGC4Xnb68aXfRh/JNNYEHYZ9CbT3WvTbZUNFvfHihho4073HWZGlwVrEuT1eeraLf4e0gV9UH8CPsZeoVwePQcXgKHoHH4KxYDZGd8JboN5u0IHB15ZnyqugIjokX13473MifutzCF/AEfhHtJFdznm6qQnmzkCfJ/TvtQP/HOe2D+kYbuM+H9Y3NknHJ/1fhCs1FIycn5z/nB1S+qW29MHcIAAAAAElFTkSuQmCC>