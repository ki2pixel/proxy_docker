# **Architecture Réseau Avancée et Masquage d'IP pour le Déploiement Conteneurisé de Nœuds de Monétisation de Bande Passante**

La participation à des réseaux de partage de bande passante résiduelle (tels que Honeygain, Pawns.app / IPRoyal, PacketStream, Repocket et Proxyrack PoP) offre une opportunité de monétisation passive1. Cependant, le déploiement direct de ces services sur la connexion internet principale d'un domicile présente un risque majeur de dégradation de la réputation de l'adresse IP publique attribuée par le fournisseur d'accès internet (FAI)1. La réutilisation de cette adresse IP par des tiers non filtrés entraîne fréquemment son inscription sur des listes noires de sécurité (AbuseIPDB, Spamhaus), une multiplication des vérifications par Captcha (Cloudflare, Akamai) et des blocages d'accès aux services sensibles tels que les banques en ligne ou les services de streaming1.  
Pour pallier ce problème sans risquer le bannissement par les plateformes de monétisation — lesquelles rejettent systématiquement les plages d'adresses IP issues de centres de données (Datacenter / DCH) —, il est indispensable de mettre en place une infrastructure réseau déportée, isolée et techniquement transparente1.

## **1\. Mécanismes Anti-Proxy et Analyse des Vecteurs de Détection**

### **Classification des Plages IP et Empreinte ASN**

Les plateformes de partage de bande passante s'appuient sur des bases de données d'intelligence IP en temps réel (telles que IPinfo, IP2Location ou MaxMind)1. Lors de l'initialisation d'un nœud conteneurisé, celui-ci émet une requête HTTP/HTTPS vers un serveur passerelle qui consulte immédiatement le type d'ASN (Autonomous System Number) associé à l'adresse IP source1.  
Les bases de données de réputation catégorisent les adresses IP selon les types suivants :

> * **Residential (RES)** : Adresses attribuées aux lignes fixes grand public (Fibre, ADSL).  
> * **Cellular / Mobile (MOB)** : Adresses attribuées aux réseaux mobiles 3G/4G/5G.  
> * **Data Center (DCH)** : Adresses attribuées aux hébergeurs cloud et fournisseurs de serveurs virtuels (OVH, DigitalOcean, AWS)4.  
> * **Organization (ORG) / Commercial** : Adresses attribuées aux entreprises et institutions5.  
> * **Reserved (RSV)** : Plages réservées non routables5.

Les plateformes autorisent exclusivement les adresses de type RES et MOB1. Les VPN grand public (NordVPN, CyberGhost, ProtonVPN) ou les serveurs virtuels (VPS) échouent systématiquement car leurs plages d'adresses IP sont enregistrées sous des ASN de type DCH ou ORG1. L'utilisation de ces adresses provoque l'erreur « Unusable Network » et l'arrêt du conteneur, suivi du bannissement du compte pour tentative de fraude1.

### **Fingerprinting TCP/IP Passif et Empreinte du Système d'Exploitation**

Au-delà de l'ASN, les systèmes anti-fraude évolués analysent la couche transport (L4) via des outils de fingerprinting passif du système d'exploitation, tel que p0f6. Lors de la poignée de main TCP (TCP Three-Way Handshake), le paquet SYN émis par le nœud contient des attributs uniques à chaque implémentation de pile TCP/IP6 :

> * **Initial Time-To-Live (TTL)** : La valeur par défaut du TTL varie selon le système d'exploitation (64 sous Linux/Android, 128 sous Windows, 255 sous les équipements réseau Cisco)6.  
> * **Taille de la fenêtre TCP (TCP Window Size)** : Les systèmes Linux utilisent couramment des valeurs fixes ou scalées spécifiques (par exemple 5840 ou 64240), tandis que Windows utilise fréquemment 81926.  
> * **Ordre des options TCP** : La séquence exacte des options dans l'en-tête TCP (Maximum Segment Size (MSS), SACK Permitted, Time Stamps, No-Operation (NOP), Window Scale) constitue une empreinte digitale extrêmement précise6.  
> * **Flag DF (Don't Fragment)** : Activation ou désactivation du bit d'interdiction de fragmentation6.

Si un conteneur affirme être un client standard mais présente une signature TCP incohérente modifiée par un proxy intermédiaire ou un tunnel mal configuré, le réseau identifie la présence d'un intermédiaire et bloque le trafic10.

### **Altération du MTU, MSS Clamping et Signatures d'Encapsulation**

L'encapsulation du trafic dans un tunnel réseau (WireGuard, OpenVPN, GRE) ajoute des en-têtes supplémentaires au paquet IP d'origine11. Sur une connexion Ethernet standard avec un MTU (Maximum Transmission Unit) de 1500 octets, l'ajout d'un en-tête WireGuard (80 octets) réduit le MTU effectif à 1420 octets11.  
La taille maximale de segment TCP (MSS, *Maximum Segment Size*) se calcule selon la formule suivante :  
![][image1]  
Sur une connexion Ethernet standard IPv4 sans encapsulation (![][image2]), le calcul donne ![][image3]. Sous un tunnel WireGuard (![][image4]), la valeur chute à ![][image5]. Les passerelles des plateformes de monétisation inspectent la valeur MSS des paquets SYN entrants : une valeur inférieure aux standards broadbands résidentiels indique immédiatement un trafic tunnelisé ou encapsulé11. Il est donc crucial d'appliquer une règle de *MSS Clamping* au niveau du pare-feu Kernel (iptables) pour forcer une négociation cohérente sans sous-dimensionnement anormal13.

### **Analyse Temporalité RTT et Fuites DNS/WebRTC**

Les plateformes recoupent l'emplacement géographique déclaré de l'adresse IP avec le délai de propagation du signal (RTT \- *Round Trip Time*)6. L'utilisation d'un tunnel traversant plusieurs nœuds intermédiaires introduit une latence additionnelle. Si une adresse IP est localisée à Paris mais présente un RTT de poignée de main TCP de 200 ms vers les serveurs cibles, le système détecte un routage anormal6.  
En outre, des fuites de requêtes DNS émises directement via le résolveur de l'hôte physique (au lieu du tunnel) ou des requêtes WebRTC/STUN permettent à la plateforme d'associer le conteneur à l'adresse IP personnelle du domicile, provoquant le blocage simultané de la connexion et du nœud1.

## **2\. Architectures de Déportation et Passerelles Réseau Locales**

### **Architecture A : Passerelle Mobile 4G/5G Dédiée avec CGNAT**

Cette architecture consiste à raccorder un modem 4G/5G (dongle USB en mode CDC-NCM/RNDIS ou routeur 4G externe) directement au serveur Linux hébergeant Docker2. Le trafic des conteneurs de monétisation est routé exclusivement à travers l'interface réseau mobile secondaire (ex: wwan0 ou eth1), tandis que le reste du serveur conserve son accès à internet via l'interface Ethernet principale (ex: eth0)16.  
Le routage sélectif s'effectue via des règles de politique de routage Linux (ip rule et iproute2) ou par la création d'un réseau Docker dédié basé sur les drivers macvlan ou ipvlan15.  
Le réseau mobile présente des avantages déterminants pour la réputation IP :

> * **Architecture CGNAT (Carrier-Grade NAT)** : Les opérateurs mobiles attribuent des adresses IP privées aux équipements et partagent une même adresse IP publique dynamique entre des milliers d'utilisateurs.  
> * **Immunité au Blacklisting** : Les algorithmes d'anti-abus et les banques d'IP ne peuvent pas blacklister durablement des plages d'IP mobiles CGNAT sans impacter massivement de véritables utilisateurs de smartphones.  
> * **Renouvellement Dynamique** : Une simple reconnexion de la session LTE (ou un redémarrage de l'interface) permet d'obtenir une nouvelle adresse IP publique issue du pool de l'opérateur mobile.

### **Architecture B : Nœud de Sortie Résidentiel Distant via Tunnel WireGuard**

Lorsque l'achat d'un forfait mobile dédié n'est pas souhaité, il est possible d'installer un micro-équipement (Raspberry Pi, mini-PC ou routeur OpenWrt) sur une connexion résidentielle tierce1. Cette connexion peut se trouver dans une résidence secondaire, dans un local professionnel indépendant ou chez un tiers acceptant de partager sa connexion1.  
Un tunnel WireGuard point-à-point chiffré est établi entre le serveur Docker principal et ce nœud distant19. L'intégralité du trafic sortant des conteneurs est acheminée à travers le tunnel, puis éjectée sur internet avec l'adresse IP résidentielle du site distant19. Pour la plateforme de monétisation, le trafic semble provenir de manière légitime de cette ligne fixe tierce, isolant totalement l'adresse IP du domicile principal1.

### **Architecture C : Services de VPN et Tunnels Résidentiels Dédiés**

Certains fournisseurs spécialisés proposent des accès VPN ou Proxies reposant sur de véritables blocs d'adresses IP d'opérateurs résidentiels (*Static Residential / ISP IPs*) louées auprès d'acteurs de télécommunication majeurs.  
Contrairement aux VPN grand public, ces services fournissent un fichier de configuration WireGuard ou OpenVPN dont l'adresse de sortie est enregistrée sous un ASN grand public fixe4. Cette approche offre une grande simplicité de déploiement via des conteneurs passerelles comme Gluetun, bien que le coût mensuel par IP soit plus élevé qu'un forfait mobile local19.

## **3\. Description Filaire et Phrasée des Flux Réseau**

### **Trajectoire du Trafic via Passerelle Mobile 4G/5G**

Dans le cadre de l'utilisation d'une passerelle mobile locale, la trajectoire réseau s'effectue selon la séquence logique suivante :

> 1. **Émission par le Conteneur** : Le conteneur de monétisation émet un paquet réseau vers une destination externe depuis son interface réseau virtuelle (veth).  
> 2. **Passage par le Pont Docker** : Le paquet atteint le pont réseau Docker dédié (br-monetization) auquel est attribué une plage IP privée dédiée (par exemple 172.25.0.0/16).  
> 3. **Évaluation des Règles de Politique (Policy Routing)** : Le noyau Linux de l'hôte intercepte le paquet et consulte la table de règles de routage (ip rule). La règle indique que tout paquet en provenance du sous-réseau 172.25.0.0/16 doit utiliser la table de routage alternative mobile\_4g (ID 200\) au lieu de la table principale (main).  
> 4. **Acheminement vers l'Interface Mobile** : La table mobile\_4g pointe vers la passerelle de l'interface modem USB (par exemple wwan0).  
> 5. **Translation d'Adresse (NAT/Masquerade) et Clamping MSS** : Les règles iptables réécrivent l'adresse IP source avec l'adresse privée attribuée par l'opérateur mobile sur l'interface wwan0, et réajustent la taille du segment TCP (MSS) pour éviter la fragmentation.  
> 6. **Sortie vers l'Opérateur et Internet** : Le paquet traverse le réseau CGNAT de l'opérateur mobile, prend l'adresse IP publique partagée de l'antenne-relais et atteint la plateforme cible de monétisation.  
> 7. **Isolation de la Ligne Fixe** : La ligne fixe domestique (eth0) n'est à aucun moment sollicitée pour le transport des paquets de données de ces conteneurs.

### **Trajectoire du Trafic via Nœud de Sortie Résidentiel Distant**

Dans le schéma utilisant un tunnel WireGuard point-à-point avec le conteneur passerelle Gluetun, le flux suit le parcours détaillé ci-dessous :

> 1. **Partage du Space-Network** : Les conteneurs de monétisation partagent l'espace de nommage réseau du conteneur gluetun grâce au paramètre network\_mode: "service:gluetun". Tout le trafic émis sort par l'interface virtuelle wg0 créee dans le conteneur Gluetun.  
> 2. **Encapsulation Chiffrée** : Gluetun encapsule les paquets TCP/IP dans des datagrammes UDP WireGuard à destination du serveur distant.  
> 3. **Transit par l'Interface Physique Hôte** : Les datagrammes UDP chiffrés sortent du serveur local via l'interface Ethernet classique (eth0) et traversent la box FAI du domicile. Les observateurs extérieurs ou le FAI ne voient qu'un flux UDP chiffré point-à-point à destination d'une IP résidentielle tierce.  
> 4. **Décapage et Sortie sur le Site Distant** : Le nœud de sortie (ex: Raspberry Pi) reçoit le flux UDP, le décapsule via WireGuard, applique une règle de masquage IP (MASQUERADE) et expédie le paquet sur internet à travers la box FAI du site distant.  
> 5. **Représentation vis-à-vis des Plateformes** : La plateforme de monétisation voit arriver une requête en provenance directe de l'adresse IP publique de la résidence tierce, garantissant un score de réputation "Residential ISP" irréprochable.

## **4\. Configurations Techniques et Implémentations Linux/Docker**

### **Script de Routage Avancé Linux (iproute2 et iptables)**

Pour router le trafic d'un réseau Docker dédié à travers une interface mobile 4G (wwan0 ou eth1), exécutez le script Shell suivant sur l'hôte Linux. Ce script crée une table de routage secondaire, configure les règles de sélection, applique le masquage d'adresse (MASQUERADE) ainsi que le *MSS Clamping*13.

Bash  
\#\!/usr/bin/env bash  
set \-euo pipefail

\# Definition des variables  
DOCKER\_SUB\_NET="172.25.0.0/16"  
MOBILE\_IF="wwan0"  
MOBILE\_GW=$(ip route show dev "$MOBILE\_IF" | grep default | awk '{print $3}' || true)

\# Si la passerelle n'est pas explicitement retournee, recuperer l'IP de l'interface  
if \[ \-z "$MOBILE\_GW" \]; then  
    MOBILE\_GW=$(ip addr show dev "$MOBILE\_IF" | grep 'inet ' | awk '{print $2}' | cut \-d/ \-f1)  
fi

TABLE\_ID="200"  
TABLE\_NAME="mobile\_4g"

echo "\[+\] Configuration de la table de routage $TABLE\_NAME ($TABLE\_ID)"  
if \! grep \-q "^$TABLE\_ID " /etc/iproute2/rt\_tables; then  
    echo "$TABLE\_ID $TABLE\_NAME" \>\> /etc/iproute2/rt\_tables  
fi

\# Nettoyage des anciennes regles  
ip route flush table $TABLE\_NAME || true  
ip rule del from $DOCKER\_SUB\_NET lookup $TABLE\_NAME 2\>/dev/null || true

\# Configuration de la table de routage  
ip route add default via $MOBILE\_GW dev $MOBILE\_IF table $TABLE\_NAME  
ip rule add from $DOCKER\_SUB\_NET lookup $TABLE\_NAME

\# Activation du forwarding Kernel  
sysctl \-w net.ipv4.ip\_forward=1 \> /dev/null

\# Configuration NAT / IPTables  
iptables \-t nat \-A POSTROUTING \-s $DOCKER\_SUB\_NET \-o $MOBILE\_IF \-j MASQUERADE  
iptables \-A FORWARD \-i br-monetization \-o $MOBILE\_IF \-j ACCEPT  
iptables \-A FORWARD \-i $MOBILE\_IF \-o br-monetization \-m state \--state RELATED,ESTABLISHED \-j ACCEPT

\# Clamping MSS pour eviter la detection d'encapsulation et le blocage MTU  
iptables \-t mangle \-A FORWARD \-p tcp \--tcp-flags SYN,RST SYN \-s $DOCKER\_SUB\_NET \-j TCPMSS \--clamp-mss-to-pmtu

echo "\[+\] Routage de la passerelle 4G applique avec succes pour le sous-reseau $DOCKER\_SUB\_NET."

### **Déploiement Stack Docker Compose avec Passerelle Gluetun**

L'utilisation du conteneur gluetun permet d'encapsuler le trafic de plusieurs conteneurs dans un tunnel WireGuard tout en appliquant un *kill-switch* strict21. L'option network\_mode: "service:gluetun" force les conteneurs enfants à partager l'interface réseau de Gluetun22.  
La variable DNS\_ADDRESS=127.0.0.11 est injectée afin de diriger les requêtes DNS vers le serveur interne de Docker pour éviter les fuites et permettre la résolution des noms de conteneurs locaux14.

YAML  
version: "3.8"

services:  
  gluetun:  
    image: qmcgaw/gluetun:v3.38.0  
    container\_name: gluetun  
    cap\_add:  
      \- NET\_ADMIN  
    devices:  
      \- /dev/net/tun:/dev/net/tun  
    environment:  
      \- VPN\_SERVICE\_PROVIDER=custom  
      \- VPN\_TYPE=wireguard  
      \# Informations WireGuard du nœud de sortie distant ou du fournisseur IP Résidentiel  
      \- WIREGUARD\_ENDPOINT\_IP=203.0.113.45  
      \- WIREGUARD\_ENDPOINT\_PORT=51820  
      \- WIREGUARD\_PUBLIC\_KEY=xT93...K30=  
      \- WIREGUARD\_PRIVATE\_KEY=eK92...M11=  
      \- WIREGUARD\_ADDRESSES=10.64.0.2/32  
      \# Redirection DNS vers le resolver interne Docker pour inter-conteneurs  
      \- DNS\_ADDRESS=127.0.0.11  
      \- FIREWALL\_OUTBOUND\_SUBNETS=192.168.1.0/24  
    restart: unless-stopped

  honeygain:  
    image: honeygain/honeygain:latest  
    container\_name: honeygain  
    network\_mode: "service:gluetun"  
    command: \-tou-accept \-email user@example.com \-pass "MotDePasse" \-device "Docker\_Node\_1"  
    depends\_on:  
      gluetun:  
        condition: service\_healthy  
    restart: unless-stopped

  pawns-app:  
    image: iproyal/pawns-cli:latest  
    container\_name: pawns  
    network\_mode: "service:gluetun"  
    command: \-email=user@example.com \-password="MotDePasse" \-device-name="Docker\_Node\_1" \-accept-tos  
    depends\_on:  
      gluetun:  
        condition: service\_healthy  
    restart: unless-stopped

  repocket:  
    image: repocket/repocket:latest  
    container\_name: repocket  
    network\_mode: "service:gluetun"  
    environment:  
      \- RP\_EMAIL=user@example.com  
      \- RP\_API\_KEY=votre\_cle\_api\_repocket  
    depends\_on:  
      gluetun:  
        condition: service\_healthy  
    restart: unless-stopped

### **Optimisations Kernel Linux Anti-Fingerprint (sysctl)**

Pour masquer le fait que le trafic provient d'un serveur Linux conteneurisé, modifiez la configuration réseau du noyau dans le fichier /etc/sysctl.d/99-anti-fingerprint.conf6 :

Ini, TOML  
\# Standardisation du TTL a 64 (conforme aux clients Linux/Android)  
net.ipv4.ip\_default\_ttl \= 64

\# Desactivation des timestamps TCP (evite la fuite de l'uptime du serveur)  
net.ipv4.tcp\_timestamps \= 0

\# Configuration des tailles de fenetre de reception et d'emission TCP  
net.core.rmem\_default \= 262144  
net.core.wmem\_default \= 262144  
net.core.rmem\_max \= 16777216  
net.core.wmem\_max \= 16777216  
net.ipv4.tcp\_rmem \= 4096 87380 16777216  
net.ipv4.tcp\_wmem \= 4096 65536 16777216

\# Activation du Window Scaling et des SACKs  
net.ipv4.tcp\_window\_scaling \= 1  
net.ipv4.tcp\_sack \= 1

Pour appliquer les paramètres sans redémarrer le système, utilisez la commande :

Bash  
sudo sysctl \--system

## **5\. Évaluation Comparative des Solutions**

| Solution Technique | Coût Estimé | Complexité d'Implémentation | Efficacité de Masquage IP Domicile | Risque de Ban / Détection par Plateforme | Impact sur le Réseau Domestique |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Passerelle 4G/5G USB dédiée (CGNAT)** | **Forfait 4G** : 5€ \- 10€ / mois **Modem USB** : 20€ \- 40€ (achat unique)2 | **Moyenne** : Configuration de tables de routage iproute2 ou Docker macvlan15. | **Totale (100%)** : Trafic entièrement déporté sur le réseau mobile2. | **Très Faible** : IP identifiée comme "Cellular/Mobile", immunisée contre le blacklisting1. | **Nul** : Isolation physique et logique complète. |
| **Nœud WireGuard Tiers (Résidence voisine/secondaire)** | **Matériel** : 35€ \- 50€ (Raspberry Pi) **Abonnement** : 0€ / mois | **Élevée** : Déploiement d'un routeur distant, ouverture de port / NAT transversal19. | **Totale (100%)** : Trafic éjecté sur la connexion internet du site distant19. | **Très Faible** : L'IP de sortie appartient à un FAI grand public fixe classique1. | **Nul** : Utilise la bande passante du site distant. |
| **VPN Résidentiel Dédié commercial (Static ISP WireGuard)** | **Abonnement** : 10€ \- 20€ / mois par IP dédiée | **Faible** : Fichier de configuration WireGuard à importer directement dans Gluetun19. | **Totale (100%)** : Trafic acheminé via le tunnel VPN commercial19. | **Faible à Moyen** : Risque si le fournisseur réattribue une IP marquée ou mal segmentée. | **Nul** : Aucun impact sur la connexion locale. |
| **VPN Grand Public Classique (NordVPN, ProtonVPN)** | **Abonnement** : 3€ \- 10€ / mois | **Faible** : Intégration facile dans Gluetun21. | **Totale (100%)** : Masque l'IP personnelle19. | **Critique (100% Ban)** : Les plages d'adresses IP sont enregistrées comme Datacenter (DCH)1. | **Nul**. |
| **Directement sur l'IP du Domicile (Sans protection)** | **Gratuit** : 0€ | **Nulle** : Lancement standard des conteneurs. | **Aucune (0%)** : L'IP publique du domicile est directement exposée1. | **Élevé (Pour l'IP)** : Inscription sur listes noires, Captchas Cloudflare, blocages bancaires1. | **Élevé** : Dégradation globale de la qualité de la connexion du foyer1. |

## **6\. Modélisation Économique, ROI et Directives d'Isolation**

### **Modélisation du Retour sur Investissement**

Les revenus générés par la monétisation de bande passante dépendent de la localisation géographique et de la demande réseau1. En moyenne européenne, un conteneur individuel actif produit entre 1,50 € et 3,50 € par mois. Le cumul de 5 applications de monétisation distantes fonctionnant en parallèle sur un unique sous-système (partageant la même adresse IP) génère un revenu brut mensuel estimé :  
![][image6]  
Face à ces revenus, la structure de coûts d'une passerelle 4G dédiée s'établit ainsi2 :

> * **Investissement Matériel Initial (CAPEX)** : Dongle USB 4G LTE débloqué (ex: Huawei E3372) \= 30,00 €.  
> * **Coût Opérationnel Récurrent (OPEX)** : Forfait mobile sans engagement (ex: forfaits à 5,99 € / mois pour 20 à 100 Go, suffisant pour couvrir la consommation de métadonnées de monétisation)2.

![][image7]  
![][image8]  
![][image9]  
À partir du 5ème mois d'exploitation, l'architecture devient financièrement bénéficiaire tout en garantissant la protection absolue de l'adresse IP du domicile principal.

### **Directives d'Isolation Réseau et Bonnes Pratiques**

> 1. **Isolation Stricte du Trafic Inter-VLAN** : Interdisez tout routage entre le sous-réseau Docker de monétisation (br-monetization) et votre réseau local domestique (LAN)26. Les conteneurs doivent uniquement pouvoir communiquer vers l'interface mobile wwan0 ou à travers le conteneur passerelle gluetun18.  
> 2. **Prévention Absolue des Fuites DNS** : Dans la configuration de vos conteneurs de monétisation, désactivez la résolution via la Box FAI. Forcez l'utilisation de serveurs DNS tiers chiffrés (ex: Quad9 9.9.9.9 ou Cloudflare 1.1.1.1) acheminés directement à l'intérieur du tunnel réseau14.  
> 3. **Surveillance Automated du Trafic** : Configurez un outil de métrologie (tel que VnStat) pour suivre la consommation de données de la carte SIM 4G afin de prévenir tout dépassement de forfait en cas de surcharge de trafic.

## **7\. Synthèse et Recommandations Opérationnelles**

Le déploiement sécurisé de conteneurs de partage de bande passante impose un cloisonnement strict du trafic réseau afin d'éviter la contamination de l'adresse IP résidentielle principale1. En raison du rejet systématique des adresses IP de centres de données par les plateformes anti-fraude, les solutions classiques basées sur des VPN grand public ne sont pas viables1.  
L'architecture la plus robuste, abordable et reproductible sous Linux/Docker repose sur la mise en place d'une passerelle mobile 4G/5G dédiée pilotée par du routage par politique (iproute2)2, ou sur la tunnelisation WireGuard vers un nœud de sortie résidentiel distant19. Ces approches apportent une séparation logique totale, garantissant un fonctionnement continu des conteneurs sans aucun risque pour la réputation numérique de la connexion du domicile.

#### **Sources des citations**

> 1. arXiv:2404.10610v2 \[cs.CR\] 30 Apr 2024, [https://arxiv.org/pdf/2404.10610](https://arxiv.org/pdf/2404.10610)  
> 2. Honeygain \- Rentabiliser sa connexion internet avec Docker \- BLD Web Agency, [https://www.bldwebagency.fr/honeygain-rentabiliser-sa-connexion-internet-docker-raspberrypi/](https://www.bldwebagency.fr/honeygain-rentabiliser-sa-connexion-internet-docker-raspberrypi/)  
> 3. Honeygain, c'est safe ? : r/privacy \- Reddit, [https://www.reddit.com/r/privacy/comments/nrsh98/is\_honeygain\_safe/?tl=fr](https://www.reddit.com/r/privacy/comments/nrsh98/is_honeygain_safe/?tl=fr)  
> 4. Does Honeygain work with VPNs?, [https://support.honeygain.com/hc/en-us/articles/360011206899-Does-Honeygain-work-with-VPNs](https://support.honeygain.com/hc/en-us/articles/360011206899-Does-Honeygain-work-with-VPNs)  
> 5. Unusable Network : r/Honeygain \- Reddit, [https://www.reddit.com/r/Honeygain/comments/16taj9r/unusable\_network/](https://www.reddit.com/r/Honeygain/comments/16taj9r/unusable_network/)  
> 6. P0F Fingerprint Tester \- OS Detection Tool \- Proxies.sx, [https://www.proxies.sx/tools/p0f-tester](https://www.proxies.sx/tools/p0f-tester)  
> 7. p0f/docs/README at master \- GitHub, [https://github.com/p0f/p0f/blob/master/docs/README](https://github.com/p0f/p0f/blob/master/docs/README)  
> 8. Passive OS Fingerprinting \- Netresec, [https://www.netresec.com/?page=Blog\&month=2011-11\&post=Passive-OS-Fingerprinting](https://www.netresec.com/?page=Blog&month=2011-11&post=Passive-OS-Fingerprinting)  
> 9. Bugtraq: p0f \- passive os fingerprinting tool \- Seclists.org, [https://seclists.org/bugtraq/2000/Jun/141](https://seclists.org/bugtraq/2000/Jun/141)  
> 10. TCP OS Spoofing (Anti TCP/OS Fingerprinting) — XProxy Docs, [https://xproxy.io/document/tcp-os-spoofing](https://xproxy.io/document/tcp-os-spoofing)  
> 11. TCP/IP Stack Fingerprinting and Proxy Bypass \- Scrapfly, [https://scrapfly.io/blog/posts/tcp-ip-stack-fingerprinting-proxy-bypass](https://scrapfly.io/blog/posts/tcp-ip-stack-fingerprinting-proxy-bypass)  
> 12. Is there a way to spoof or disable "TCP/IP OS fingerprint (passive/syn)"? : r/privacy \- Reddit, [https://www.reddit.com/r/privacy/comments/9anbby/is\_there\_a\_way\_to\_spoof\_or\_disable\_tcpip\_os/](https://www.reddit.com/r/privacy/comments/9anbby/is_there_a_way_to_spoof_or_disable_tcpip_os/)  
> 13. Is there some config or limitation about network of Docker container \- General, [https://forums.docker.com/t/is-there-some-config-or-limitation-about-network-of-docker-container/131403](https://forums.docker.com/t/is-there-some-config-or-limitation-about-network-of-docker-container/131403)  
> 14. Fixing Gluetuns inter-network DNS failures in Docker | Jacob Jangles, [https://jacobjangles.com/posts/fixing-gluetuns-inter-network-dns-failures-in-docker/](https://jacobjangles.com/posts/fixing-gluetuns-inter-network-dns-failures-in-docker/)  
> 15. Docker Macvlan : isoler ses conteneurs avec une IP dédiée \- RDR-IT, [https://rdr-it.com/docker-macvlan-isoler-ses-conteneurs-avec-une-ip-dediee/](https://rdr-it.com/docker-macvlan-isoler-ses-conteneurs-avec-une-ip-dediee/)  
> 16. Macvlan network driver \- Docker Docs, [https://docs.docker.com/engine/network/drivers/macvlan/](https://docs.docker.com/engine/network/drivers/macvlan/)  
> 17. Juniper Cloud-Native Router 25.2 Deployment Guide, [https://www.juniper.net/documentation/us/en/software/cloud-native-router25.2/cloud-native-router-deployment-guide/cloud-native-router-deployment-guide.pdf](https://www.juniper.net/documentation/us/en/software/cloud-native-router25.2/cloud-native-router-deployment-guide/cloud-native-router-deployment-guide.pdf)  
> 18. Configurer un bloc IP dans un vRack sur une instance Public Cloud, [https://docs.ovhcloud.com/fr/guides/public-cloud/network-services/configure-ip-block-vrack-instance](https://docs.ovhcloud.com/fr/guides/public-cloud/network-services/configure-ip-block-vrack-instance)  
> 19. How to Use TorGuard WireGuard with Gluetun in Docker, [https://torguard.net/support/articles/TorGuard-Software-Features/torguard-wireguard-gluetun-docker-setup.php](https://torguard.net/support/articles/TorGuard-Software-Features/torguard-wireguard-gluetun-docker-setup.php)  
> 20. gluetun-wiki/setup/providers/custom.md at main \- GitHub, [https://github.com/qdm12/gluetun-wiki/blob/main/setup/providers/custom.md](https://github.com/qdm12/gluetun-wiki/blob/main/setup/providers/custom.md)  
> 21. Gluetun is the best way to route your Docker containers through a VPN, here's how I use it, [https://www.xda-developers.com/gluetun-route-docker-through-vpn/](https://www.xda-developers.com/gluetun-route-docker-through-vpn/)  
> 22. Gluetun \- Docker Compose, [https://docker-compose.de/en/gluetun/](https://docker-compose.de/en/gluetun/)  
> 23. Configurer un bloc Additional IP dans le vRack \- OVHcloud Documentation, [https://docs.ovhcloud.com/fr/guides/bare-metal-cloud/dedicated-servers/configuring-an-ip-block-in-a-vrack](https://docs.ovhcloud.com/fr/guides/bare-metal-cloud/dedicated-servers/configuring-an-ip-block-in-a-vrack)  
> 24. connect-a-container-to-gluetun.md \- GitHub, [https://github.com/qdm12/gluetun-wiki/blob/main/setup/connect-a-container-to-gluetun.md](https://github.com/qdm12/gluetun-wiki/blob/main/setup/connect-a-container-to-gluetun.md)  
> 25. Configurer Gluetun avec WireGuard \- YAMS \- Yet Another Media Server, [https://fr.yams.media/advanced/wireguard/](https://fr.yams.media/advanced/wireguard/)  
> 26. Docker MacVLAN and IPVLAN Explained: Advanced Networking Guide \- Medium, [https://medium.com/@dyavanapellisujal7/docker-macvlan-and-ipvlan-explained-advanced-networking-guide-b3ba20bc22e4](https://medium.com/@dyavanapellisujal7/docker-macvlan-and-ipvlan-explained-advanced-networking-guide-b3ba20bc22e4)

[image1]: <data:image/png;base64,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>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAAaCAYAAAB8WJiDAAAE60lEQVR4Xu2YV6hkRRCGy5xds6IPrj6YAyqKiriimBB1MSviogjmhAiCigvmB8ODmMUXEworxjUHzDmhmNeMARUjZq1vqmumTu2c2Zllca7QH/xwu7rvOdOnuquqW6RSqVQqlUrl/8fq2VA4UrWbagXVEqqtVbeptoqDlP1Vz6seVz2t2qXZ3YFnXC827gXVlaqlGiMq85TFxRx2h+qu1OfgsH+S7lYtHMbsofpZtVZpb6L6UTWlO0JkAdVzqmtU85X2DaoHw5iR2Ez1hup7sR81q9k9G/uKjftL9Z7qdtXvqj9UH4g96/MyhsnQfkv1k+pP1WlinKp6Rew5jH1HbGJLl/7NVe+WPn/XPqXvv+Qo1VdizuL3tzn4UbF5fqp6QnWEav44QHlTbDdGblY9Gdr7ic151WBbp9h2DLaRYZX4B18k9TmrqC4Ue9l1xYaj7hELK87pYmOYpLOo6jWxCTg4k4/2UbBlHlNNzcYx8au0O/gh1eRsDKwv9k2OS/bpxb5yad+q+qbba7CL8ctlyT4Sr4vtLl62dupzjpee89xRrL4VuyOMR8TGrJnsN6nWC+09xcZdHmyRhcSiQt4J42KQgwmhk7MxcLDYXKcl+0nFvnNpE6lm9bq7EGHJ2XPFuqpbpBd+d212dyB/4LCHxVbTcmLOuioOEstXv4n90AyOXzC0WZG8j2f3Y1uxyDJRGOTgB1QnqGaKFUdENUKrc4rYXA8MNjim2A8rbdLa273uLl+rPs7GYWFnHi6Wj3nZsc3uzg49SLWY2CSfLfblS1+EqrBtV8bdCywCFsOSye6cozokG1tgB5BihhXV6aTOfw7PIAffp7pIetHmbLFaxHPpmWLf5YDSdsjx2Fkc8LdYLs98qfouG4flTrHwsozYyy5u9JrD+eEkefrPanY38By9V+5IEA0YR+5qg51A3p8oDHIwizemkjXE5ndJaU8v7UEOpmrm73nqYPLcS6FNgqcydnCq5+TzxX4AobONV8VC+LK5I8G5kWcRuvpBZHg5G8cMDqaaHgYKI+bH6QDaQvTRxU4EhbYQTSVPhT4yOCtWZxxVONoAOzqGSMIa5zYWRT9wCiGGZ8yJGWIT4yzYD4qSC7JxzOBgcmyGC44fpHlCAL4Fx0PAscz30F53By+y/MID5/Y7VVBkPZONw0CuiOH0RtUvYuGCkt6LInYkO3PQCib88GPPzR19IAzxUdoq5Ptl9pw9iJ3EFuCw4mPNTQ6+NxulF379jA8Um9g4y4OfZU/ujjCoM7B7KuJczCaKsKEYc0WyDwUTZac65FdfaRsHO4sA+4nBlrlWbMz2uaMP7IRvs7FAXqJgmWjgYIqpzFSxtEZYdrYU+xbnBRsXHVeHNnA79lRo+0XHasG2abGxiEdiI9X70txF08QedkawATcw2DdMdocdT47gI3CpMSe2E7sBIxc7K4kVeHyEtp09LohkVPxcvGT4rdxe7V7abBjG4dB4h8xxkFC7QWlz/ck32KY7wp7lV5X8zXsp7PotrFa2UH0ovWtCCiu/BuSK8EXp3Wbxos/KOPSJ2JnZ4eUcOzjy+BjCEra9w7h+TBGrognX5B4+CmfxiQT5lU1ABevz+0JsvrGQZHFykYOdhc53i7d7DmmMopajJjt3h2Z3B46fpEo/0l0qFvIrlUqlUqlUKpVKpVKpJP4FWnpEyyBDRHYAAAAASUVORK5CYII=>

[image3]: <data:image/png;base64,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>

[image4]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAAaCAYAAAB8WJiDAAAEuElEQVR4Xu2YV4hlRRCGf3POEQMrYsaAGX1wVTCDiq5iQhEUFVREFBT1wYg+qC9iDghmRTAHjGDOGfOuEQMq5hzqm+qe06fm3LlnZHFG6A9+uKe67wldXdXVLVUqlUqlUqn8/5gWDQM4znRjsM1hOtE0y/St6VHT9LJDYmnTNaZnTc+ZLjEt0upRma0saNrSdLvpztDWxfKm70y3BPtppqtN85lWNj1u+tO0fdFnLtMzpsvlE4Lra00PFH0mxMam1+Uz6m/TzHbzGPaS9+PF3jXdZvrN9Lvpffm9Pk19fkzXb5p+MP1hOknOCaaX5Peh79vyD1s0tW9qeie15WfNSG3/JUeYvjDdJX//Pg6+0vSX2g5e3PS52pG4mppvy+wt/+YVCttaybZdYZswzJI84MywLpiZ58ofdlWy4ai75Wklc7K8z2GFbX7TK/IPyOBMBu2DwhYhje0ejZPELxru4E3kqZkJXTp4G/mY3FrYIE/iNdP1zaavmuYRiGL8cmGwT4hX5dFVPixytBrnZUeRZpYZ7eE8LO+zarBfb1qnuN5N3u+iwlYyjzwrzBkbJok+Dn7QtIrGOnhD+bd+VNjg+WSnHYjmmU3zKGTYJ6OxL2ubblKTfndqN4+wq9xhD8ln05JyZ11adpKvV7+qnXYyOH7u4poZyfO4dxdbyTPLVGGYg/cznZF+RwfDzqZ1i+t5Td+bflaTulnW3hrt0fCl6cNo7AuReYh8PWbAj2w3j0QoL7+A/COfTvalUlvJjhoclWX0ApOAybBwsGfONB0YjQPYQb7E9BXV6WIj/+zPeA5mYj9lWihddzk4sr98rMrUy9pNzRJh/f4mGvtyhzytUAjwwPNbre5w0iSLPO2nt5tb5DV6j9gQIBvQj5Q2CLYJrPtThfEcfKrak3GYgwmW9+RLY45eqmbGZLY6mHXuheKaBZ7KOINT85p8tvwFSJ2DeFmewpeIDYHD5fc6PjYkyAwvRuMkg4OppiNseR6ROygzzMFXyAusslqGQSmaSv7jaOwDzipTBFsVtjZARJezkrTGmsGk6AKnkGK4xzCoJsviInKA6ZxonGRw8D3RaFxn2iLYxnPwofLoXSk2yJ3btaugyGIJmDAUBWU65WV/ks/Go9QURUQkkdk1gzP7yJ12VmzogDTEYcCgCvl+jV2zx4PDAiZgXzFY/2YNvjca5QXQZ0GMA/35XQbJ5vLInVbYjjWtnn7fIA+iEgKK+10c7L3gQ4nUDOsrNzvYtEFhZxJgP6awRUg79Nk2NnRAJHwdjQkOF86LxikADrsvGjvgTIBxiBG8nHw5XCPY2evnyZYPOlZsmrVRspUnXr1YX54qyig6SH6zUwobcB6Kfb1gzxDxrBEMAocaw9hafgLGWpxZVl7gXabBkT1ZkMmo+HHGMCgMGavyUIMofEy+lr6W9Ib8XJoCKsN356NKfvNcCrs+E2uUzeQ3JuXyIhRWM1IbR4RsvvNpFg/6JPVDbNTZM2d4ONsOtjy5DykI255Fvy6my6to0jVrD4PHXnwqsYs8CKhg8/eRdvnerkKSwwjGk36M7yzTvmq2j116gj8WsP1kqcxbugvk27BKpVKpVCqVSqVSqVQqgX8Aw4lCwyUSgpgAAAAASUVORK5CYII=>

[image5]: <data:image/png;base64,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>

[image6]: <data:image/png;base64,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>

[image7]: <data:image/png;base64,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>

[image8]: <data:image/png;base64,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>

[image9]: <data:image/png;base64,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>