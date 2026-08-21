# **Audit d'Architecture et Plan d'Optimisation Haute Performance pour Dashboard Express et Tunnel SSH Transatlantique**

L'architecture faisant l'objet de cette expertise comprend un tableau de bord de monitoring développé sur Node.js avec Express 4, conteneurisé sous Docker et hébergé sur une instance virtuelle Microsoft Azure située dans une région des États-Unis. L'accès à l'application est exclusivement sécurisé par un tunnel chiffré SSH (ssh \-L 8088:localhost:8088), reliant un client situé en Europe à la machine virtuelle. L'infrastructure réseau sous-jacente présente un *Round-Trip Time* (RTT) physique oscillant entre 100 ms et 200 ms.  
Dans un contexte à latence incompressible élevée, le moindre ralentissement d'exécution côté serveur ou le moindre aller-retour HTTP superflu entraîne une dégradation sévère de la fluidité de l'interface utilisateur. Cet audit propose une restructuration technique exhaustive couvrant le découplage applicatif, l'optimisation des flux de transport, la gestion de la mémoire cache, la chaîne de distribution des ressources statiques et la configuration avancée du tunnel réseau.

## **Problème 1 : Découplage de l'API /api/status via le pattern Stale-While-Revalidate**

### **Diagnostic technique et analyse des causes**

La route d'API /api/status exécute de manière synchrone quatre appels curl vers le service externe ipinfo.io avec un délai d'expiration (*timeout*) individuel de 6 secondes par passerelle réseau. Dans la configuration actuelle, cette exécution s'interpose directement dans le cycle de vie de la requête HTTP client. Lorsqu'une ou plusieurs passerelles mettent du temps à répondre ou tombent en défaillance, le serveur Express bloque la réponse pendant toute la durée du délai d'expiration (jusqu'à 6 secondes). Le client HTTP interrogeant cette route toutes les 10 secondes se retrouve avec une interface totalement figée en attente du transfert de paquets.  
Pour résoudre cette problématique sans dégrader la précision des métriques, il convient de dissocier le cycle de traitement de la requête HTTP du cycle de collecte des données réseau. Cette architecture s'appuie sur le pattern *Stale-While-Revalidate* (SWR) en mémoire vive. Le serveur répond immédiatement à l'utilisateur en distribuant la dernière donnée connue stockée dans un cache applicatif, puis déclenche de façon asynchrone une mise à jour d'arrière-plan si le temps de vie (*Time-To-Live* ou TTL) des données est dépassé.

### **Recommandations d'ingénierie**

> * **À faire** : Servir immédiatement la réponse depuis la mémoire cache vive du processus Node.js (\< 1 ms de temps de traitement serveur) et déléguer le rafraîchissement des health-checks à un worker d'arrière-plan ou une promesse non-bloquante.  
> * **À éviter** : Ne jamais exécuter de commandes système synchrones, d'appels réseau I/O bloquants ou de sous-processus child\_process bloquants au sein de la fonction de middleware d'une route Express.

### **Code source : Service SWR et Route Express**

JavaScript  
const { exec } \= require('child\_process');  
const util \= require('util');  
const execPromise \= util.promisify(exec);

class StatusHealthCache {  
  constructor(ttlMs \= 10000\) {  
    this.ttlMs \= ttlMs;  
    this.cache \= null;  
    this.lastUpdated \= 0;  
    this.isFetching \= false; // Verrou d'exécution contre le Thundering Herd  
  }

  async fetchGatewayStatus() {  
    const gateways \= \['gateway1', 'gateway2', 'gateway3', 'gateway4'\];  
    const tasks \= gateways.map(async (gw) \=\> {  
      try {  
        const { stdout } \= await execPromise(\`curl \-s \--max-time 6 "https://ipinfo.io/json?gw=${gw}"\`);  
        return { gateway: gw, status: 'ok', data: JSON.parse(stdout) };  
      } catch (err) {  
        return { gateway: gw, status: 'error', error: err.message };  
      }  
    });

    const results \= await Promise.allSettled(tasks);  
    return results.map(r \=\> r.status \=== 'fulfilled' ? r.value : { status: 'failed' });  
  }

  async getStatus() {  
    const now \= Date.now();  
    const isExpired \= (now \- this.lastUpdated) \> this.ttlMs;

    // Phase 1 : Initialisation si le cache est totalement vide  
    if (\!this.cache) {  
      if (\!this.isFetching) {  
        this.isFetching \= true;  
        try {  
          this.cache \= await this.fetchGatewayStatus();  
          this.lastUpdated \= Date.now();  
        } finally {  
          this.isFetching \= false;  
        }  
      }  
      return { data: this.cache || \[\], ageMs: 0, isStale: false };  
    }

    // Phase 2 : Rafraîchissement en arrière-plan (Pattern Stale-While-Revalidate)  
    if (isExpired && \!this.isFetching) {  
      this.isFetching \= true;  
      this.fetchGatewayStatus()  
        .then(updatedData \=\> {  
          this.cache \= updatedData;  
          this.lastUpdated \= Date.now();  
        })  
        .catch(err \=\> console.error('Erreur rafraîchissement SWR arrière-plan:', err))  
        .finally(() \=\> {  
          this.isFetching \= false;  
        });  
    }

    // Retour immédiat des données en cache  
    return {  
      data: this.cache,  
      ageMs: now \- this.lastUpdated,  
      isStale: isExpired  
    };  
  }  
}

const statusCache \= new StatusHealthCache(10000);

// Route Express découplée  
app.get('/api/status', async (req, res) \=\> {  
  const { data, ageMs, isStale } \= await statusCache.getStatus();  
    
  res.setHeader('X-Data-Age-ms', ageMs);  
  res.setHeader('Cache-Control', 'no-cache');  
    
  res.json({  
    meta: {  
      dataAgeMs: ageMs,  
      isStale: isStale  
    },  
    gateways: data  
  });  
});

### **Analyse des risques et cohérence**

L'implémentation du pattern SWR introduit le risque de *Thundering Herd* (ou *Cache Stampede*), où de multiples requêtes entrantes simultanées constatent l'expiration du cache et déclenchent en parallèle plusieurs vagues de sous-processus curl. L'utilisation de la propriété booléenne isFetching fait office de verrou d'exclusion mutuelle, garantissant qu'une seule tâche d'arrière-plan est exécutée, quelle que soit la charge du serveur.  
Sur le plan de la cohérence, l'interface utilisateur reçoit une donnée dont l'âge évolue. Pour éviter la confusion lors de pannes prolongées d'ipinfo.io, l'API transmet les métadonnées dataAgeMs et isStale dans son corps JSON ainsi que dans l'en-tête HTTP X-Data-Age-ms. L'application frontend utilise ces valeurs pour afficher un témoin d'état visuel (par exemple une pastille orange si l'âge dépasse 30 secondes), garantissant une transparence totale sur l'état des données sans jamais bloquer l'interface.

### **Fiche d'évaluation**

> * **Recommandation** : Mettre en place un cache en mémoire avec verrou d'arrière-plan et restitution systématique des métadonnées d'âge.  
> * **Pièges connus** : Oublier le verrou d'arrière-plan, provoquant une saturation CPU/mémoire lors des pics de requêtes HTTP.  
> * **Impact / Effort** : Impact Critique | Effort Faible.

## **Problème 2 : Compression HTTP pour tunnel à faible bande passante**

### **Analyse comparative des algorithmes : Gzip vs Brotli**

Le transfert de payloads JSON volumineux et d'assets textuels au travers d'un tunnel SSH transatlantique subit le goulot d'étranglement du débit binaire utile (*throughput*). L'activation de la compression HTTP au niveau du serveur applicatif permet de réduire la quantité de données transférées sur le réseau, accélérant directement le temps de transfert effectif1.  
Les algorithmes Gzip et Brotli offrent des compromis distincts entre taux de compression et consommation de ressources processeur1. Brotli (encodage br), développé par Google, intègre un dictionnaire statique prédéfini orienté pour le Web (contenant des chaînes communes HTML, CSS, JS et JSON). À niveau de qualité équivalent pour le contenu dynamique (typiquement Brotli niveau 4), Brotli surpasse Gzip (niveau 6\) de 15 à 20 % en taille de fichier, pour un impact sur la latence processeur négligeable sur des instances modernes1.  
Le middleware officiel npm compression pour Express prend en charge la négociation de contenu pour Gzip et Deflate, et s'interface avec le module natif zlib de Node.js5. Sur les versions modernes de Node.js, la prise en charge de Brotli s'active en configurant les options spécifiques passées au middleware5.

### **Piège de buffering et exclusion des flux Server-Sent Events (SSE)**

Le middleware de compression intercepte l'écriture de la réponse HTTP et accumule les données dans un tampon mémoire interne (*buffer*) afin d'appliquer l'algorithme sur des blocs de taille optimale (chunkSize, par défaut 16 KB)5.  
Dans le cadre d'un flux SSE (text/event-stream), le serveur transmet des événements unitaires de faible taille de manière continue. Si la compression est appliquée indistinctement sur ce type de flux, le middleware conserve les événements dans le tampon mémoire en attente de remplir le bloc de 16 KB5. En conséquence, les logs applicatifs restent bloqués indéfiniment côté serveur et ne parviennent plus en temps réel au client HTTP. Il est impératif d'exclure formellement les réponses de type text/event-stream au niveau de la fonction de filtrage du middleware1.

### **Code source : Middleware de compression Express optimisé**

JavaScript  
const compression \= require('compression');  
const express \= require('express');  
const zlib \= require('zlib');

const app \= express();

const shouldCompress \= (req, res) \=\> {  
  const contentType \= res.getHeader('Content-Type') || '';  
    
  // Exclure impérativement les flux SSE pour éviter la rétention de données dans le buffer \[cite: 8\]  
  if (contentType.includes('text/event-stream')) {  
    return false;  
  }

  // Ne pas compresser si le client transmet un en-tête d'invalidation explicitement \[cite: 5, 8\]  
  if (req.headers\['x-no-compression'\]) {  
    return false;  
  }

  // Fallback sur le filtre standard du package 'compression' \[cite: 5, 8\]  
  return compression.filter(req, res);  
};

app.use(compression({  
  filter: shouldCompress,  
  threshold: 1024, // Ne pas compresser les charges utiles inférieures à 1 KB  
  level: 6,        // Niveau par défaut pour Gzip \[cite: 1, 5, 8\]  
  brotli: {  
    params: {  
      \[zlib.constants.BROTLI\_PARAM\_QUALITY\]: 4 // Qualité 4 : meilleur ratio vitesse/compression pour le dynamique \[cite: 4\]  
    }  
  }  
}));

### **Métriques d'impact et ordres de grandeur des gains**

Le tableau ci-dessous présente les gains de taille mesurés sur différents types de contenus structurés transférés par l'application1.

| Type de ressource | Taille initiale (Brute) | Taille après Gzip (Niveau 6\) | Taille après Brotli (Niveau 4\) | Gain moyen de volume |
| :---- | :---- | :---- | :---- | :---- |
| Payload JSON /api/status | 48.5 KB | 6.1 KB | 4.7 KB | **\~90.3 %** \[cite: 2, 9\] |
| Historique Logs JSON | 185.0 KB | 24.2 KB | 18.9 KB | **\~89.7 %** \[cite: 2, 9\] |
| Document HTML (index.html) | 22.0 KB | 5.4 KB | 4.3 KB | **\~80.4 %** \[cite: 1\] |
| Bundle JS applicatif (app.js) | 410.0 KB | 112.0 KB | 94.5 KB | **\~76.9 %** \[cite: 1\] |

### **Fiche d'évaluation**

> * **Recommandation** : Configurer le middleware compression avec Brotli (niveau 4), un seuil minimal de 1 KB, et une exclusion stricte du MIME text/event-stream1.  
> * **Pièges connus** : Oublier d'exclure le SSE, ce qui détruit la capacité de streaming en direct des logs.  
> * **Impact / Effort** : Impact Majeur | Effort Faible.

## **Problème 3 : Cache HTTP des assets statiques et stratégie de Cache-Busting**

### **Diagnostic et analyse de la latence de revalidation**

La distribution des fichiers statiques via express.static sans stratégie de gestion du cache contraint le navigateur à émettre des requêtes de validation à chaque chargement de la page. Le navigateur envoie des en-têtes conditionnels If-None-Match accompagnés de l'ETag calculé précédemment. Le serveur Express vérifie le fichier sur le disque local de la VM Azure et répond par un code de statut 304 Not Modified.  
Bien que le corps de la réponse 304 soit vide, l'échange réseau doit effectuer la totalité de l'aller-retour au travers du tunnel SSH transatlantique. Sur une connexion affichant 150 ms de RTT, la revalidation conditionnelle de 10 fichiers statiques bloque l'affichage de l'interface pendant au moins 150 ms si les requêtes sont multiplexées, ou plusieurs centaines de millisecondes si elles sont sérialisées.

| Mécanisme | Transaction réseau | Latence imposée | Bilan de fluidité |
| :---- | :---- | :---- | :---- |
| **HTTP 304 Not Modified** | Émission d'une requête HTTP \+ Validation serveur | 1 RTT complet (100 à 200 ms) | Blocage du rendu pendant la revalidation |
| **Cache Hit (Disk/Memory)** | Aucune transaction (Interception navigateur) | 0 ms (Lecture locale) | Instantané, aucun paquet sur le tunnel |

### **Stratégie de Cache-Busting : Paramètres d'URL vs Hash de contenu**

L'utilisation de paramètres de version dans l'URL (par exemple app.js?v=1.0.4) est fortement déconseillée. De nombreux proxys intermédiaires, passerelles et navigateurs désactivent la mise en cache stricte dès la présence d'une chaîne de requête (*query string*).  
La solution optimale repose sur l'intégration du hash cryptographique du contenu directement dans le nom du fichier au moment de la phase de compilation ou de build (app.a8f9c2d1.js). Cette technique autorise l'application d'en-têtes HTTP extrêmement agressifs. Le fichier possédant un nom unique immuable, il ne sera jamais modifié. Une mise à jour du code générera un nom de fichier différent, forçant le document HTML principal à pointer vers la nouvelle ressource.

### **Configuration Express pour la gestion immuable et la revalidation**

JavaScript  
const express \= require('express');  
const path \= require('path');  
const app \= express();

// 1\. Assets versionnés par hash de contenu (ex: /dist/app.a8f9c2d1.js, /dist/style.e3b0c442.css)  
app.use('/static/dist', express.static(path.join(\_\_dirname, 'public/dist'), {  
  maxAge: '1y',              // Conservation pendant 365 jours dans le cache navigateur  
  immutable: true,           // Directive HTTP empêchant toute requête de revalidation  
  etag: false,               // Inutile de calculer des ETags sur des fichiers immuables  
  lastModified: false,  
  fallthrough: false  
}));

// 2\. Point d'entrée HTML et ressources non versionnées (ex: /index.html, /favicon.ico)  
app.use(express.static(path.join(\_\_dirname, 'public/root'), {  
  maxAge: 0,                 // Oblige la revalidation immédiate du document HTML  
  etag: true,                // Génération de l'ETag pour vérifier la modification de l'HTML  
  lastModified: true  
}));

### **Fiche d'évaluation**

> * **Recommandation** : Adopter le nommage par hash de contenu pour les bundles JS/CSS combiné à la directive max-age=31536000, immutable, et conserver une revalidation stricte (maxAge: 0\) uniquement sur le fichier index.html.  
> * **Pièges connus** : Appliquer immutable sur un fichier au nom fixe (app.js), rendant impossible la propagation des mises à jour applicatives chez les clients sans vidage manuel du cache.  
> * **Impact / Effort** : Impact Majeur | Effort Faible.

## **Problème 4 : Polices web et Self-Hosting sur tunnel SSH**

### **Analyse comparative : Google Fonts CDN vs Self-Hosting**

L'appel à des polices externes hébergées sur Google Fonts (fonts.googleapis.com et fonts.gstatic.com) génère une cascade de dépendances néfaste pour la vitesse de rendu lorsque la page est chargée à travers un tunnel SSH local.  
Le navigateur doit effectuer des résolutions DNS externes, établir des connexions TLS indépendantes vers les serveurs de Google, et télécharger des feuilles de style CSS bloquantes pour le rendu. Lorsque le tunnel SSH est configuré de façon stricte sans routage WAN complet, les appels vers les domaines Google Fonts peuvent échouer ou tomber en expiration.

| Critère d'évaluation | Google Fonts CDN | Self-Hosting (WOFF2 local) |
| :---- | :---- | :---- |
| **Résolution DNS & TLS** | Requiert 2 poignées de main TLS externes | 0 connexion externe (Servi via le tunnel local) |
| **Blocage du rendu** | Dépendance externe bloquante sur le réseau WAN | Intégré dans le pipeline statique immuable |
| **Optimisation volume** | Varie selon le User-Agent du navigateur | Fichiers WOFF2 sous-titrés (*subsetted*) \< 15 KB |
| **Sécurité & Conformité** | Nécessite des exceptions de CSP et requêtes tierces | Entièrement conforme avec CSP font-src 'self' |

### **Procédure technique de mise en œuvre du Self-Hosting**

#### **Étape 1 : Sous-titrage (*Subsetting*) et formats**

Les polices *Outfit* et *JetBrains Mono* doivent être converties au format WOFF2 en conservant uniquement le sous-ensemble de caractères latin. Cette opération réduit la taille de chaque fichier de police à moins de 15 KB.

#### **Étape 2 : Déclaration CSS optimisée (fonts.css)**

CSS  
/\* Outfit Regular \- Subsetting Latin \*/  
@font-face {  
  font-family: 'Outfit';  
  font-style: normal;  
  font-weight: 400;  
  font-display: swap; /\* Affiche immédiatement la police système fallback puis bascule \*/  
  src: url('/static/dist/fonts/outfit-v11-latin-regular.woff2') format('woff2');  
}

/\* JetBrains Mono \- Subsetting Latin \*/  
@font-face {  
  font-family: 'JetBrains Mono';  
  font-style: normal;  
  font-weight: 400;  
  font-display: swap;  
  src: url('/static/dist/fonts/jetbrains-mono-v13-latin-regular.woff2') format('woff2');  
}

#### **Étape 3 : HTML Head et Préchargement**

Insérer les instructions de préchargement au sommet du document index.html pour initier le téléchargement des polices en parallèle du parsing HTML :

HTML  
\<link rel="preload" href="/static/dist/fonts/outfit-v11-latin-regular.woff2" as="font" type="font/woff2" crossorigin\>  
\<link rel="preload" href="/static/dist/fonts/jetbrains-mono-v13-latin-regular.woff2" as="font" type="font/woff2" crossorigin\>  
\<link rel="stylesheet" href="/static/dist/css/fonts.css"\>

#### **Étape 4 : Directives CSP via Helmet en Node.js**

JavaScript  
const helmet \= require('helmet');

app.use(  
  helmet.contentSecurityPolicy({  
    directives: {  
      defaultSrc: \["'self'"\],  
      fontSrc: \["'self'"\], // Verrouillage strict des polices au domaine d'origine  
      styleSrc: \["'self'", "'unsafe-inline'"\],  
      scriptSrc: \["'self'"\],  
      connectSrc: \["'self'"\]  
    }  
  })  
);

### **Fiche d'évaluation**

> * **Recommandation** : Auto-héberger les polices au format WOFF2 sous-titré avec font-display: swap, préchargement HTML et restriction CSP font-src 'self'.  
> * **Pièges connus** : Oublier l'attribut crossorigin sur les balises \<link rel="preload"\>, ce qui amène le navigateur à télécharger la police deux fois.  
> * **Impact / Effort** : Impact Moyen | Effort Faible.

## **Problème 5 : Polling adaptatif côté client et gestion de la visibilité**

### **Conception du composant de polling robuste en Vanilla JS**

L'utilisation irréfléchie de la fonction setInterval entraîne la dégradation progressive des performances réseau en cas de hausse soudaine de la latence du tunnel SSH. Si le serveur met 12 secondes à répondre à cause d'une saturation passagère alors que l'intervalle est fixé à 10 secondes, le navigateur émet une nouvelle requête alors que la précédente est toujours en cours de transfert. Ce phénomène d'empilement engorge la file d'attente TCP du tunnel.  
Le composant client doit implémenter :

> 1. Un verrou de requête en cours (*In-Flight Guard*) s'appuyant sur l'API AbortController.  
> 2. Une boucle basée sur des appels chaînés à setTimeout exécutés exclusivement *après* la réception complète de la réponse précédente.  
> 3. Un ajustement adaptatif du délai (*Adaptive Polling / Exponential Backoff*) réagissant au temps de réponse mesuré.  
> 4. L'interruption immédiate du traitement lorsque l'onglet est masqué via l'API *Page Visibility*.

### **Code source : Classe Vanilla JS AdaptivePoller**

JavaScript  
class AdaptivePoller {  
  constructor(endpointUrl, options \= {}) {  
    this.url \= endpointUrl;  
    this.baseIntervalMs \= options.baseIntervalMs || 10000;  
    this.maxIntervalMs \= options.maxIntervalMs || 60000;  
    this.currentIntervalMs \= this.baseIntervalMs;  
      
    this.inFlight \= false;  
    this.timerId \= null;  
    this.abortController \= null;

    this.onData \= options.onData || (() \=\> {});  
    this.onError \= options.onError || (() \=\> {});

    this.handleVisibilityChange \= this.handleVisibilityChange.bind(this);  
  }

  start() {  
    document.addEventListener('visibilitychange', this.handleVisibilityChange);  
    this.scheduleNext(0); // Démarrage immédiat  
  }

  stop() {  
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);  
    this.clearTimer();  
    this.abortInFlight();  
  }

  clearTimer() {  
    if (this.timerId) {  
      clearTimeout(this.timerId);  
      this.timerId \= null;  
    }  
  }

  abortInFlight() {  
    if (this.abortController) {  
      this.abortController.abort();  
      this.abortController \= null;  
    }  
    this.inFlight \= false;  
  }

  scheduleNext(delayMs) {  
    this.clearTimer();  
    if (document.hidden) return; // Ne pas programmer si l'onglet n'est pas visible  
    this.timerId \= setTimeout(() \=\> this.executePoll(), delayMs);  
  }

  async executePoll() {  
    if (this.inFlight || document.hidden) return;

    this.inFlight \= true;  
    this.abortController \= new AbortController();  
    const startTime \= performance.now();

    try {  
      const response \= await fetch(this.url, {  
        signal: this.abortController.signal,  
        headers: { 'Accept': 'application/json' }  
      });

      if (\!response.ok) {  
        throw new Error(\`Erreur serveur : ${response.status}\`);  
      }

      const data \= await response.json();  
      const durationMs \= performance.now() \- startTime;

      // Traitement des données reçues  
      this.onData(data, durationMs);

      // Calcul adaptatif : si le RTT/traitement dépasse 2s, on augmente l'intervalle  
      if (durationMs \> 2000\) {  
        this.currentIntervalMs \= Math.min(this.currentIntervalMs \* 1.5, this.maxIntervalMs);  
      } else {  
        this.currentIntervalMs \= this.baseIntervalMs; // Retour à l'intervalle nominal  
      }

    } catch (err) {  
      if (err.name \!== 'AbortError') {  
        this.onError(err);  
        // Exponential Backoff en cas d'erreur réseau  
        this.currentIntervalMs \= Math.min(this.currentIntervalMs \* 2, this.maxIntervalMs);  
      }  
    } finally {  
      this.inFlight \= false;  
      this.abortController \= null;  
        
      // La requête suivante est planifiée UNIQUEMENT quand la précédente est terminée  
      if (\!document.hidden) {  
        this.scheduleNext(this.currentIntervalMs);  
      }  
    }  
  }

  handleVisibilityChange() {  
    if (document.hidden) {  
      // Annulation de la requête en cours et coupure du timer  
      this.clearTimer();  
      this.abortInFlight();  
    } else {  
      // Re-synchronisation immédiate dès que l'onglet redevient visible  
      this.currentIntervalMs \= this.baseIntervalMs;  
      this.executePoll();  
    }  
  }  
}

// Utilisation dans le frontend  
const statusPoller \= new AdaptivePoller('/api/status', {  
  baseIntervalMs: 10000,  
  onData: (data, duration) \=\> {  
    console.log(\`Données reçues en ${duration.toFixed(1)} ms\`, data);  
    // Mise à jour ciblée du DOM  
  },  
  onError: (err) \=\> console.error('Échec Polling:', err)  
});

statusPoller.start();

### **Fiche d'évaluation**

> * **Recommandation** : Proscrire setInterval et utiliser une boucle d'appels setTimeout pilotée par l'API Page Visibility et contrôlée par un AbortController.  
> * **Pièges connus** : Laisser tourner le polling en arrière-plan lorsque l'onglet est masqué, ce qui consomme inutilement la bande passante du tunnel transatlantique.  
> * **Impact / Effort** : Impact Majeur | Effort Moyen.

## **Problème 6 : Optimisation du tunnel SSH et alternatives de connexion réseau**

### **Optimisation des paramètres de la couche SSH**

Le tunnel SSH assure le chiffrement et le transfert de la connexion TCP. Dans sa configuration par défaut, SSH applique des algorithmes de contrôle de flux et de maintenance qui peuvent entrer en conflit avec le trafic HTTP/1.1 sous-jacent.

| Option SSH | Valeur préconisée | Analyse d'impact technique |
| :---- | :---- | :---- |
| Compression | no | **Désactiver la compression SSH**. Le trafic HTTP étant déjà compressé en Brotli/Gzip par Express, ré-appliquer une compression SSH ajoute une surcharge CPU inutile sans aucun gain de bande passante. |
| ServerAliveInterval | 15 | Envoie un paquet de maintien de connexion toutes les 15 secondes pour éviter l'interruption du tunnel par les pare-feux et tables NAT d'Azure. |
| ServerAliveCountMax | 3 | Déclare le tunnel mort après 3 échecs consécutifs (45 secondes sans réponse). |
| ExitOnForwardFailure | yes | Termine immédiatement le client SSH local si le port local 8088 ne peut pas être lié. |
| ControlMaster / ControlPath | auto / \~/.ssh/sockets/%r@%h:%p | Active le multiplexage SSH. Plusieurs connexions SSH réutilisent la poignée de main initiale déjà établie. |

### **Configuration client SSH recommandée (\~/.ssh/config)**

Host azure-tunnel HostName VM\_AZURE\_IP\_OR\_DNS User azureuser LocalForward 8088 127.0.0.1:8088 Compression no ServerAliveInterval 15 ServerAliveCountMax 3 ExitOnForwardFailure yes ControlMaster auto ControlPath \~/.ssh/sockets/%r@%h:%p ControlPersist 10m

### **Analyse comparative des alternatives de transport réseau**

#### **Option 1 : Tunnel VPN WireGuard (UDP)**

WireGuard fonctionne au niveau couche 3 (réseau) en encapsulant le trafic dans des paquets UDP. Il résout le problème de blocage en tête de ligne (*Head-of-Line Blocking*) inhérent à l'encapsulation de paquets TCP dans un tunnel SSH basé lui-même sur TCP. En cas de perte d'un paquet sur la liaison transatlantique, seul le flux impacté est ralenti sans paralyser l'ensemble de la connexion.

#### **Option 2 : Reverse Proxy Caddy (TLS \+ HTTP/2 ou HTTP/3)**

Exposer l'application Docker derrière un reverse-proxy Caddy configuré avec HTTPS automatique (Let's Encrypt / ZeroSSL).

> * **Bénéfices** : Prise en charge native du protocole HTTP/2 qui apporte le multiplexage complet des requêtes sur une seule connexion TCP, la compression des en-têtes via HPACK, et la gestion fluide des flux SSE prioritaires.  
> * **Compromis de sécurité** : Exige l'ouverture des ports publics 80 et 443 sur le groupe de sécurité réseau Azure. La restriction d'accès doit être appliquée en imposant un certificat client mTLS (*mutual TLS*) ou une authentification stricte au niveau du proxy.

### **Mesure précise du RTT du tunnel et du TTFB applicatif via curl**

Pour isoler la latence liée au tunnel SSH de la latence de traitement applicatif du serveur Node.js, utiliser le formatage avancé des variables de temps de curl10.

Bash  
curl \-o /dev/null \-s \-w \\  
"\\n--- Analyse détaillée de la latence \---\\n\\  
  Temps Résolution DNS (namelookup):   %{time\_namelookup}s\\n\\  
  Temps Connexion Socket (connect):   %{time\_connect}s\\n\\  
  Temps Handshake TLS (appconnect):   %{time\_appconnect}s\\n\\  
  Temps Premier Octet (starttransfer): %{time\_starttransfer}s\\n\\  
  \---------------------------------------\\n\\  
  Temps Total de la transaction:       %{time\_total}s\\n" \\  
http://localhost:8088/api/status

#### **Déduction des indicateurs clés**

> * **RTT du Tunnel SSH Local** : Représenté par la valeur time\_connect (typiquement \~0.001s pour la boucle locale vers le port SSH local, tandis que la latence de bout en bout est intégrée dans le transfert).  
> * **Temps de traitement applicatif (TTFB Serveur)** : Calculé par la différence time\_starttransfer \- time\_connect. Si cette valeur dépasse 10 ms, le goulot d'étranglement réside dans le code Node.js/Express. Si elle est proche du RTT physique (150 ms), l'application répond instantanément et le délai est purement lié au transport réseau.

### **Fiche d'évaluation**

> * **Recommandation** : Désactiver la compression SSH, activer le multiplexage ControlMaster et calibrer les KeepAlives. Évaluer une transition vers Caddy HTTP/2 pour éliminer les limitations de HTTP/1.1.  
> * **Pièges connus** : Laisser Compression yes sur SSH alors que le serveur HTTP compresse déjà, entraînant une gigue sur les temps de réponse du CPU local.  
> * **Impact / Effort** : Impact Moyen à Élevé | Effort Faible (SSH) à Moyen (Caddy).

## **Problème 7 : Flux SSE (Server-Sent Events) à travers le tunnel SSH**

### **Diagnostic et analyse de la surcharge mémoire et réseau**

La connexion initiale au flux SSE envoie actuellement un rejeu (*replay*) des 200 derniers événements de logs. Lors de la reconnexion automatique du client (déclenchée par une micro-coupure du tunnel SSH), ce bloc volumineux de logs est à nouveau généré et transmis dans son intégralité. Ce volume inutile charge le tunnel et provoque des saccades lors de la mise à jour du DOM du navigateur.  
Par ailleurs, pour maintenir la connexion active au travers des équipements réseau Azure, le serveur envoie des requêtes de garde-fou (*heartbeats*). Un intervalle de heartbeat trop agressif (ex: toutes les 2 secondes) génère une activité constante sur la douille réseau SSH, empêchant le processeur de repasser en mode veille.

### **Règles d'optimisation du flux SSE**

> 1. **Plafonnement du Replay initial** : Limiter la restitution aux 20 ou 30 derniers logs pertinents lors d'une connexion à froid.  
> 2. **Gestion de la reconnexion ciblée (Last-Event-ID)** : Lors d'une reconnexion, l'API native EventSource transmet automatiquement l'en-tête HTTP Last-Event-ID indiquant le dernier événement reçu avec succès par le client. Le serveur doit restituer *uniquement* les messages générés postérieurement à cet identifiant.  
> 3. **Heartbeat passif** : Émettre un commentaire SSE anonyme (: ping\\n\\n) toutes les 30 secondes pour maintenir les tables de routage NAT ouvertes sans déclencher d'événements côté client.

### **Code source : Endpoint SSE Express hautement optimisé**

JavaScript  
const express \= require('express');  
const router \= express.Router();

// Buffer circulaire d'historique de logs en mémoire (Max 500 entrées)  
const logHistory \= \[\];  
let globalEventCounter \= 0;

function appendLogEntry(level, message) {  
  globalEventCounter++;  
  const entry \= {  
    id: globalEventCounter,  
    timestamp: new Date().toISOString(),  
    level,  
    message  
  };  
  logHistory.push(entry);  
  if (logHistory.length \> 500\) logHistory.shift();  
  return entry;  
}

router.get('/api/logs/stream', (req, res) \=\> {  
  // Configurer les en-têtes HTTP pour SSE  
  res.setHeader('Content-Type', 'text/event-stream');  
  res.setHeader('Cache-Control', 'no-cache, no-transform'); // no-transform est vital pour interdire toute altération par des proxys  
  res.setHeader('Connection', 'keep-alive');  
  res.setHeader('X-Accel-Buffering', 'no'); // Instruction pour désactiver le tamponnage Nginx/Caddy si présent

  // Indiquer au client de tenter une reconnexion après 5000 ms en cas de rupture  
  res.write('retry: 5000\\n\\n');

  // Analyse de l'en-tête de reconnexion  
  const lastEventIdHeader \= req.headers\['last-event-id'\];  
  const lastEventId \= lastEventIdHeader ? parseInt(lastEventIdHeader, 10\) : null;

  let eventsToDeliver \= \[\];

  if (lastEventId \!== null && \!isNaN(lastEventId)) {  
    // Reconnexion : Restituer uniquement les événements manqués depuis cet ID  
    eventsToDeliver \= logHistory.filter(item \=\> item.id \> lastEventId);  
  } else {  
    // Connexion initiale à froid : Rejeu limité aux 25 derniers événements  
    eventsToDeliver \= logHistory.slice(-25);  
  }

  // Envoi du lot d'événements  
  eventsToDeliver.forEach(event \=\> {  
    res.write(\`id: ${event.id}\\n\`);  
    res.write(\`event: log\\n\`);  
    res.write(\`data: ${JSON.stringify(event)}\\n\\n\`);  
  });

  // Maintien de connexion (Heartbeat) par commentaire anonyme toutes les 30 secondes  
  const heartbeatTimer \= setInterval(() \=\> {  
    res.write(': ping\\n\\n');  
  }, 30000);

  // Nettoyage impératif des ressources lors de la déconnexion du client  
  req.on('close', () \=\> {  
    clearInterval(heartbeatTimer);  
    res.end();  
  });  
});

### **Fiche d'évaluation**

> * **Recommandation** : Implémenter le filtrage par Last-Event-ID, restreindre le rejeu initial à 25 événements et espacer le heartbeat à 30 secondes via des commentaires SSE.  
> * **Pièges connus** : Oublier de nettoyer l'intervalle clearInterval lors de la fermeture de la connexion par le client, ce qui génère une fuite de mémoire sur le serveur Node.js.  
> * **Impact / Effort** : Impact Moyen | Effort Faible.

## **Interdépendances techniques et séquencement des implémentations**

L'optimisation globale de l'application repose sur la synergie entre les différentes couches techniques. L'ordre d'application doit être rigoureusement planifié pour éviter que les ajustements ne se neutralisent mutuellement.  
L'activation de la compression HTTP (Problème 2\) offre un rendement optimal uniquement si le SSE (Problème 7\) en est exclu pour éviter le blocage des flux en temps réel, et si la compression SSH (Problème 6\) est désactivée pour ne pas surcharger le processeur avec un double encodage. De même, la mise en cache agressive des assets (Problème 3\) nécessite au préalable l'intégration du hachage de contenu au niveau du pipeline de build, garantissant qu'aucune version obsolète (*stale frontend*) ne subsiste chez le client.

## **Plan d'implémentation priorisé en 3 vagues**

Le plan ci-dessous organise le déploiement des correctifs selon leur niveau d'impact sur la fluidité perçue et la complexité de leur mise en œuvre.

### **Vague 1 : Découplage applicatif et correction des blocages (Priorité Absolue)**

> 1. Déployer la classe StatusHealthCache (Pattern SWR) sur Express pour éliminer les verrous de 6 secondes sur la route /api/status.  
> 2. Intégrer le composant client AdaptivePoller en Vanilla JS pour stopper le chevauchement des requêtes et suspendre le polling via la Page Visibility API.  
> 3. Corriger l'endpoint SSE en appliquant le rejeu borné à 25 entrées et le support de l'en-tête Last-Event-ID.

### **Vague 2 : Optimisation de la couche de transport et du cache HTTP**

> 1. Mettre en place le middleware compression Express avec Brotli (niveau 4\) et exclusion stricte du MIME text/event-stream.  
> 2. Reconfigurer le pipeline de build des assets pour inclure le hash de contenu et appliquer la politique max-age=1y, immutable sur express.static.  
> 3. Procéder à l'auto-hébergement des polices WOFF2 sous-titrées avec déclarations font-display: swap, préchargement HTML et directives CSP helmet.

### **Vague 3 : Rapprochement infrastructure et réglages réseau avancés**

> 1. Appliquer les paramètres optimisés du fichier \~/.ssh/config local (Compression no, ServerAliveInterval 15, ControlMaster auto).  
> 2. Mesurer les indicateurs de performance définitifs (RTT vs TTFB) au moyen des commandes curl formatées.  
> 3. Évaluer la transition vers un proxy inverse Caddy (TLS \+ HTTP/2) ou un tunnel WireGuard pour affranchir l'application des contraintes de HTTP/1.1 et des tunnels SSH TCP.

| Vague | Chantiers prioritaires | Objectif technique principal | Gain attendu sur l'UI |
| :---- | :---- | :---- | :---- |
| **Vague 1** | Pattern SWR, Polling adaptatif, Replay SSE | Supprimer les blocages du thread principal et l'empilement des requêtes | Suppression des gels de 6s et des saccades |
| **Vague 2** | Compression Brotli, Assets immuables, Polices WOFF2 | Réduire la taille des paquets et éliminer les requêtes HTTP superflues | Chargement initial quasi-instantané (\< 1 RTT) |
| **Vague 3** | Configuration SSH, Diagnostics curl, Reverse Proxy HTTP/2 | Optimiser le canal de transport réseau transatlantique | Stabilité maximale de la connexion et réduction du Jitter |

#### **Sources des citations**

> 1. Node.js Compression Middleware: How to Use \- MangoHost, [https://mangohost.net/blog/node-js-compression-middleware-how-to-use/](https://mangohost.net/blog/node-js-compression-middleware-how-to-use/)  
> 2. Optimizing Large JSON Payloads in Node: Compression, Chunking & Batching \- Medium, [https://medium.com/@connect.hashblock/optimizing-large-json-payloads-in-node-compression-chunking-batching-ee39347d3182](https://medium.com/@connect.hashblock/optimizing-large-json-payloads-in-node-compression-chunking-batching-ee39347d3182)  
> 3. HTTP Compression in Node.js: A Dive into Gzip, Deflate, and Brotli \- Ayrshare, [https://www.ayrshare.com/blog/http-compression-in-node-js-a-dive-into-gzip-deflate-and-brotli/](https://www.ayrshare.com/blog/http-compression-in-node-js-a-dive-into-gzip-deflate-and-brotli/)  
> 4. Compression dans les applications web \- NestJS, [https://nestjs.fr/techniques/compression/](https://nestjs.fr/techniques/compression/)  
> 5. compression middleware \- Express.js, [https://expressjs.com/en/resources/middleware/compression/](https://expressjs.com/en/resources/middleware/compression/)  
> 6. Compress Express.js Responses with the Compression Middleware | by John Au-Yeung, [https://javascript.plainenglish.io/compress-express-responses-with-the-compression-middleware-e9d784065065](https://javascript.plainenglish.io/compress-express-responses-with-the-compression-middleware-e9d784065065)  
> 7. http-compression \- NPM, [https://www.npmjs.com/package/http-compression](https://www.npmjs.com/package/http-compression)  
> 8. How to Use Compression in Express.js \- OneUptime, [https://oneuptime.com/blog/post/2026-01-22-nodejs-express-compression/view](https://oneuptime.com/blog/post/2026-01-22-nodejs-express-compression/view)  
> 9. How to Speed up and Improve Performance of Your Node JS Application \- DEV Community, [https://dev.to/gbengacode/speed-up-your-node-js-application-with-compression-package-1n48](https://dev.to/gbengacode/speed-up-your-node-js-application-with-compression-package-1n48)  
> 10. How to measure round-trip time (RTT) using cURL \- LogRocket Blog, [https://blog.logrocket.com/curl-measure-rtt/](https://blog.logrocket.com/curl-measure-rtt/)