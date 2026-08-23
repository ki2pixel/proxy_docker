import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  redactSecrets, signSession, parseSession,
  escapeEnvValue, parseEnv, applyEnvUpdates,
  clampInt, CONTAINER_NAME_RE, ALLOWED_ACTIONS,
  configSnapshot, validateConfigUpdates,
  HostMetricsCollector
} from './lib.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rawPort = parseInt(process.env.PORT || '8080', 10);
const PORT = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 8080;
const APP_DIR = process.env.APP_DIR || '/workspace';
const PROJECT_NAME = 'proxy_docker';
const COMPOSE_FILE = path.join(APP_DIR, 'docker-compose.yml');
const COMPOSE_OVERRIDE = path.join(APP_DIR, 'docker-compose.override.yml');
const ENV_PATH = path.join(APP_DIR, '.env');

// -----------------------------------------------------------------------------
// Configuration & Fail-Closed Validation
// -----------------------------------------------------------------------------
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || '';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 jours

if (DASHBOARD_TOKEN.length < 16) {
  console.error('[FATAL] DASHBOARD_TOKEN est manquant ou trop court (< 16 caractères).');
  console.error('        Générez-en un avec : openssl rand -hex 32');
  process.exit(1);
}
if (DASHBOARD_SECRET.length < 32) {
  console.error('[FATAL] DASHBOARD_SECRET est manquant ou trop court (< 32 caractères).');
  console.error('        Générez-en un avec : openssl rand -hex 32');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Compression HTTP (brotli/gzip) via le middleware officiel `compression`.
// IMPORTANT : exclut les flux SSE (text/event-stream) — la compression
// bufferiserait les événements et détruirait le temps réel des logs.
// -----------------------------------------------------------------------------
import compression from 'compression';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// Security headers — appliqués AVANT express.static pour couvrir aussi les fichiers statiques
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self'; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "img-src 'self' data:; " +
    "base-uri 'none'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    "object-src 'none'"
  );
  next();
});

// Compression HTTP (brotli/gzip) — exclusion stricte des flux SSE pour ne
// pas bufferiser les événements temps réel. Seuil 1 KB, Brotli prioritaire.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    const contentType = res.getHeader('Content-Type') || '';
    if (contentType.includes('text/event-stream')) return false;
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Assets versionnés par hash de contenu (public/dist, généré par scripts/build-assets.mjs) :
// immuables 1 an, aucun re-fetch via le tunnel.
app.use('/static/dist', express.static(path.join(__dirname, 'public', 'dist'), {
  maxAge: '1y',
  immutable: true,
  etag: false,
  lastModified: false
}));

// Racine : index.html + ressources non versionnées (fallback si pas de build).
// maxAge 0 + ETag → 1 seule revalidation par chargement (1 RTT via tunnel).
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true,
  lastModified: true
}));

// -----------------------------------------------------------------------------
// Rate Limiting (léger, sans dépendance externe)
// -----------------------------------------------------------------------------
function rateLimit({ windowMs, max, name }) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: `Trop de requêtes (${name}). Réessayez plus tard.` });
    }
    next();
  };
}

const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, name: 'API global' });
const loginLimiter = rateLimit({ windowMs: 60_000, max: 5, name: 'connexion' });

app.use('/api', apiLimiter);
app.use('/api/login', loginLimiter);

// -----------------------------------------------------------------------------
// Authentification (cookie HMAC signé) + CSRF (double-submit)
// -----------------------------------------------------------------------------
function issueSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${token}.${expiresAt}`;
  const sig = signSession(payload, DASHBOARD_SECRET);
  const cookieValue = `${payload}.${sig}`;

  res.cookie('session', cookieValue, {
    httpOnly: true,
    sameSite: 'strict',
    secure: false, // derrière un reverse proxy TLS (Caddy), voir "trust proxy"
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
  res.cookie('csrf', token, {
    httpOnly: false,
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
  return token;
}

function requireAuth(req, res, next) {
  const token = parseSession(req.cookies?.session, DASHBOARD_SECRET);
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  req.sessionToken = token;
  next();
}

function requireCsrf(req, res, next) {
  const header = req.get('x-csrf-token') || '';
  const cookie = req.cookies?.csrf || '';
  if (!header || !cookie || !crypto.timingSafeEqual(Buffer.from(header), Buffer.from(cookie))) {
    return res.status(403).json({ error: 'Jeton CSRF invalide' });
  }
  next();
}

// -----------------------------------------------------------------------------
// Global In-Memory State & Cache (multi-passerelles)
// -----------------------------------------------------------------------------
function newGatewayState(num) {
  return {
    num,
    status: 'UNKNOWN',
    currentIP: null,
    currentLocation: null,
    ispInfo: null,
    latencyMs: null,
    activeProxy: { host: '', port: '', protocol: 'socks5' },
    consecutiveFailures: 0,
    ipFetchInFlight: false
  };
}

// Passerelles supportées : GW1_..GW4_ (numéros définis dans lib.js)
const GATEWAY_STATES = new Map([1, 2, 3, 4].map(n => [`gw${n}`, newGatewayState(n)]));

// State global (logs + divers)
const state = {
  logs: []
};

const sseClients = new Set();
const MAX_SSE_CLIENTS = 20;
let sseEventCounter = 0; // id global des événements SSE (Last-Event-ID)

// -----------------------------------------------------------------------------
// Lecture des clés .env d'une passerelle (avec fallback legacy pour gw1)
// -----------------------------------------------------------------------------
function readGatewayEnv(num, env = null) {
  const e = env || readEnvFile();
  const p = `GW${num}_`;
  const pick = (key, legacy = '') => e[`${p}${key}`] ?? e[legacy] ?? '';
  return {
    protocol: pick('ISP_PROXY_PROTOCOL', 'ISP_PROXY_PROTOCOL') || 'socks5',
    host: pick('ISP_PROXY_HOST', 'ISP_PROXY_HOST'),
    port: pick('ISP_PROXY_PORT', 'ISP_PROXY_PORT'),
    user: pick('ISP_PROXY_USER', 'ISP_PROXY_USER'),
    pass: pick('ISP_PROXY_PASS', 'ISP_PROXY_PASS')
  };
}

function log(msg, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const safeMsg = redactSecrets(msg);
  sseEventCounter += 1;
  const entry = { id: sseEventCounter, timestamp, level, message: safeMsg };
  state.logs.push(entry);
  if (state.logs.length > 200) state.logs.shift();

  console.log(`[${timestamp}] [${level}] ${safeMsg}`);
  const sseData = `id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(sseData);
    } catch {
      try { client.end(); } catch { /* socket déjà fermée */ }
      sseClients.delete(client);
    }
  }
}

// -----------------------------------------------------------------------------
// Docker Socket API Client
// -----------------------------------------------------------------------------
class DockerClient {
  constructor(socketPath = '/var/run/docker.sock') {
    this.socketPath = socketPath;
  }

  isAvailable() {
    return fs.existsSync(this.socketPath);
  }

  request(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
      if (!this.isAvailable()) {
        return reject(new Error('Docker socket not available'));
      }

      const options = {
        socketPath: this.socketPath,
        path: apiPath,
        method: method,
        headers: {
          'Host': 'docker',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {})
        }
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(raw ? JSON.parse(raw) : null);
            } catch {
              resolve(raw);
            }
          } else {
            reject(new Error(`Docker error (${res.statusCode}): ${raw || res.statusMessage}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error(`Docker request timeout on ${apiPath}`));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async listContainers() {
    try {
      const res = await this.request('GET', '/containers/json?all=1');
      return Array.isArray(res) ? res : [];
    } catch {
      return [];
    }
  }

  // Snapshot des stats d'un conteneur (CPU/RAM/réseau) — une requête,
  // sans flux : /containers/{id}/stats?stream=false
  async containerStats(id) {
    const raw = await this.request('GET', `/containers/${id}/stats?stream=false`);
    if (!raw || typeof raw !== 'object') return null;
    const { cpu_stats: cpu = {}, precpu_stats: precpu = {}, memory_stats: mem = {}, networks = {}, name = '' } = raw;
    const cpuDelta = (cpu.cpu_usage?.total_usage || 0) - (precpu.cpu_usage?.total_usage || 0);
    const sysDelta = (cpu.system_cpu_usage || 0) - (precpu.system_cpu_usage || 0);
    const onlineCpus = cpu.online_cpus || (cpu.cpu_usage?.percpu_usage || []).length || 1;
    const cpuPercent = sysDelta > 0 && cpuDelta >= 0
      ? Math.min(Math.max((cpuDelta / sysDelta) * onlineCpus * 100, 0), 100)
      : 0;
    const memUsage = mem.usage || 0;
    const memLimit = mem.limit || 0;
    let rxBytes = 0;
    let txBytes = 0;
    for (const iface of Object.values(networks || {})) {
      rxBytes += iface.rx_bytes || 0;
      txBytes += iface.tx_bytes || 0;
    }
    return {
      name: String(name || '').replace(/^\//, ''),
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memory: {
        usage: memUsage,
        limit: memLimit,
        percent: memLimit > 0 ? Math.round((memUsage / memLimit) * 100) : 0
      },
      network: { rxBytes, txBytes }
    };
  }

  async restartContainer(nameOrId) {
    return await this.request('POST', `/containers/${nameOrId}/restart?t=5`);
  }

  async startContainer(nameOrId) {
    return await this.request('POST', `/containers/${nameOrId}/start`);
  }

  async stopContainer(nameOrId) {
    return await this.request('POST', `/containers/${nameOrId}/stop?t=5`);
  }

  async execInContainer(nameOrId, cmd) {
    const execRes = await this.request('POST', `/containers/${nameOrId}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: cmd
    });
    if (!execRes || !execRes.Id) throw new Error('Failed to create exec instance');
    return new Promise((resolve, reject) => {
      const options = {
        socketPath: this.socketPath,
        path: `/exec/${execRes.Id}/start`,
        method: 'POST',
        headers: {
          'Host': 'docker',
          'Content-Type': 'application/json'
        }
      };
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let clean = '';
          let offset = 0;
          while (offset < raw.length) {
            if (offset + 8 > raw.length) {
              clean += raw.subarray(offset).toString('utf-8');
              break;
            }
            const size = raw.readUInt32BE(offset + 4);
            if (offset + 8 + size > raw.length) {
              clean += raw.subarray(offset + 8).toString('utf-8');
              break;
            }
            const content = raw.subarray(offset + 8, offset + 8 + size).toString('utf-8');
            clean += content;
            offset += 8 + size;
          }
          resolve(clean || raw.toString('utf-8'));
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error(`Docker exec timeout for ${nameOrId}`));
      });
      req.write(JSON.stringify({ Detach: false, Tty: false }));
      req.end();
    });
  }

  async getContainerLogs(nameOrId, tail = 60) {
    return new Promise((resolve, reject) => {
      if (!this.isAvailable()) return reject(new Error('Socket not available'));
      const options = {
        socketPath: this.socketPath,
        path: `/containers/${nameOrId}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=1`,
        method: 'GET',
        headers: { 'Host': 'docker' }
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let clean = '';
          let offset = 0;
          while (offset < raw.length) {
            if (offset + 8 > raw.length) {
              clean += raw.subarray(offset).toString('utf-8');
              break;
            }
            const size = raw.readUInt32BE(offset + 4);
            if (offset + 8 + size > raw.length) {
              clean += raw.subarray(offset + 8).toString('utf-8');
              break;
            }
            const content = raw.subarray(offset + 8, offset + 8 + size).toString('utf-8');
            clean += content;
            offset += 8 + size;
          }
          resolve(clean || raw.toString('utf-8'));
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error(`Docker logs timeout for ${nameOrId}`));
      });
      req.end();
    });
  }
}

const docker = new DockerClient();

// -----------------------------------------------------------------------------
// Métriques temps réel — snapshot agrégé (host + conteneurs)
// -----------------------------------------------------------------------------
// Le snapshot hôte est lu directement depuis /proc de l'hôte (monté sur
// /host/proc:ro ou /proc en dev) avec PSI (/proc/pressure/*) et Swap/zRAM.
// Les stats par conteneur viennent de l'API Docker.
// Le cache SWR ci-dessous ne bloque jamais la réponse HTTP.
const hostMetricsCollector = new HostMetricsCollector();
// Conteneurs à exclure des stats (dashboard, caddy — bruit inutile)
const METRICS_EXCLUDE = new Set(['isp-dashboard', 'isp-caddy']);

// Construit le payload de /api/metrics : hôte + stats par conteneur connu
// (gateway + providers), mappé par nom avec l'état du cache status.
async function buildMetricsSnapshot() {
  const host = hostMetricsCollector.collect();
  const containers = await docker.listContainers();
  const running = (containers || []).filter(c => c.State === 'running');

  // Préparer les noms de conteneurs connus (gateways + providers de toutes les
  // passerelles, qu'elles soient actives ou non dans le .env)
  const knownNames = new Set();
  for (const gw of GATEWAYS) {
    knownNames.add(gw.container);
    for (const p of gw.providers) knownNames.add(p.container);
  }

  const include = running.filter(c => {
    const names = c.Names || [];
    return names.some(n => knownNames.has(n.replace(/^\//, ''))) && !names.some(n => METRICS_EXCLUDE.has(n.replace(/^\//, '')));
  });

  const containersMetrics = await Promise.allSettled(
    include.map(c => docker.containerStats(c.Id))
  );

  const byName = {};
  containersMetrics.forEach((result, i) => {
    if (result.status !== 'fulfilled' || !result.value) return;
    const m = result.value;
    const name = (include[i].Names || []).map(n => n.replace(/^\//, ''))[0] || m.name;
    byName[name] = {
      cpuPercent: m.cpuPercent,
      memory: m.memory,
      network: m.network
    };
  });

  return {
    host,
    containers: byName,
    timestamp: Date.now()
  };
}

class MetricsCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.cache = null;
    this.lastUpdated = 0;
    this.isFetching = false;
  }

  async get() {
    const now = Date.now();
    if (!this.cache) {
      if (!this.isFetching) {
        this.isFetching = true;
        try {
          this.cache = await buildMetricsSnapshot();
          this.lastUpdated = Date.now();
        } finally {
          this.isFetching = false;
        }
      }
      return this._payload();
    }
    // Stale-while-revalidate : réponse immédiate + refresh en arrière-plan
    if (now - this.lastUpdated > this.ttlMs && !this.isFetching) {
      this.isFetching = true;
      buildMetricsSnapshot()
        .then(data => {
          this.cache = data;
          this.lastUpdated = Date.now();
        })
        .catch(err => {
          console.error(`[metricsCache] Refresh arrière-plan échoué : ${err.message}`);
        })
        .finally(() => {
          this.isFetching = false;
        });
    }
    return this._payload();
  }

  _payload() {
    const ageMs = Date.now() - this.lastUpdated;
    return {
      data: this.cache,
      ageMs,
      isStale: ageMs > this.ttlMs
    };
  }
}

const METRICS_TTL_MS = 5000;
const metricsCache = new MetricsCache(METRICS_TTL_MS);

// -----------------------------------------------------------------------------
// Provider Metadata (types de nœuds de monétisation, sans instance)
// -----------------------------------------------------------------------------
const PROVIDER_TYPES = [
  { id: 'repocket', name: 'Repocket', base: 'repocket', icon: '⚡', dashboard: 'https://app.repocket.com' },
  { id: 'honeygain', name: 'Honeygain', base: 'honeygain', icon: '🍯', dashboard: 'https://dashboard.honeygain.com' },
  { id: 'pawns', name: 'Pawns.app', base: 'pawns', icon: '♟️', dashboard: 'https://pawns.app' },
  { id: 'packetstream', name: 'PacketStream', base: 'packetstream', icon: '📦', dashboard: 'https://packetstream.io' },
  { id: 'traffmonetizer', name: 'TraffMonetizer', base: 'traffmonetizer', icon: '💰', dashboard: 'https://app.traffmonetizer.com' }
];

// -----------------------------------------------------------------------------
// Passerelles : métadonnées dérivées des numéros supportés
// -----------------------------------------------------------------------------
const GATEWAY_NUMS = [1, 2, 3, 4];
const GATEWAYS = GATEWAY_NUMS.map(n => ({
  id: `gw${n}`,
  num: n,
  container: `gateway-isp-${n}`,
  envPrefix: `GW${n}_`,
  providers: PROVIDER_TYPES.map(pt => ({
    ...pt,
    container: `${pt.base}-${n}`,
    profile: `gw${n}-${pt.id}`
  }))
}));

function getGateway(gwId) {
  return GATEWAYS.find(g => g.id === gwId) || null;
}

// Passerelles "actives" : celles dont le conteneur gateway existe (running ou non)
// et dont une config proxy est présente dans le .env
function getActiveGateways(env = null) {
  const e = env || readEnvFile();
  return GATEWAYS.filter(g => {
    const cfg = readGatewayEnv(g.num, e);
    return Boolean(cfg.host) || g.num === 1; // gw1 toujours listé (fallback legacy)
  });
}

// -----------------------------------------------------------------------------
// Helper: Lecture / Écriture du fichier .env
// -----------------------------------------------------------------------------
function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  return parseEnv(fs.readFileSync(ENV_PATH, 'utf-8'));
}

function updateEnvFile(updates) {
  try {
    if (!fs.existsSync(ENV_PATH)) return false;
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    const newContent = applyEnvUpdates(content, updates);
    fs.writeFileSync(ENV_PATH, newContent);
    log(`Updated .env keys: ${Object.keys(updates).join(', ')}`, 'INFO');
    return true;
  } catch (err) {
    log(`Failed to update .env: ${err.message}`, 'ERROR');
    return false;
  }
}

// -----------------------------------------------------------------------------
// Invalidation du cache status après une mutation (action provider)
// -----------------------------------------------------------------------------
function invalidateStatusCache() {
  // Marque le cache comme expiré : le prochain GET /api/status déclenchera un
  // refresh en arrière-plan immédiat (les curls sont protégés par ipFetchInFlight)
  statusCache.lastUpdated = 0;
}

// -----------------------------------------------------------------------------
// Helper: Exécution docker compose (sans shell)
// -----------------------------------------------------------------------------
// L'override docker-compose.override.yml (petites VM : limites réduites) est
// ajouté s'il existe — il est ignoré par compose quand -f est passé explicitement.
function composeArgs() {
  const args = ['compose', '-p', PROJECT_NAME, '-f', COMPOSE_FILE];
  if (fs.existsSync(COMPOSE_OVERRIDE)) args.push('-f', COMPOSE_OVERRIDE);
  return args;
}

async function composeUp(serviceId) {
  await execFileAsync('docker', [
    ...composeArgs(), '--profile', serviceId, 'up', '-d', serviceId
  ], { timeout: 120_000 });
}

async function composeRestartGateway(gw) {
  await execFileAsync('docker', [
    ...composeArgs(), 'restart', gw.container
  ], { timeout: 120_000 });
}

// -----------------------------------------------------------------------------
// Helper: Fetch Current IP through gateway-isp-{n} (via docker exec ou socket API)
// -----------------------------------------------------------------------------
async function fetchCurrentGatewayIP(gw) {
  const gstate = GATEWAY_STATES.get(gw.id);
  if (!gstate) return;
  if (gstate.ipFetchInFlight) return;
  gstate.ipFetchInFlight = true;
  try {
    const start = Date.now();
    let stdout = '';

    // Relire le .env pour garder la cohérence du proxy affiché
    const env = readEnvFile();
    const cfg = readGatewayEnv(gw.num, env);
    gstate.activeProxy = {
      host: cfg.host,
      port: cfg.port,
      protocol: cfg.protocol
    };

    // 1. Exécution curl dans gateway-isp-{n} via Docker CLI
    try {
      const res = await execFileAsync('docker', [
        'exec', gw.container, 'curl', '-s', '-k', '--max-time', '6',
        'https://ipinfo.io/json'
      ], { timeout: 10_000 });
      stdout = res.stdout;
    } catch {
      // 2. Fallback via Docker Socket API (exec)
      try {
        stdout = await docker.execInContainer(gw.container, [
          'curl', '-s', '-k', '--max-time', '6', 'https://ipinfo.io/json'
        ]);
      } catch (err2) {
        log(`Health check note (${gw.id}): ${err2.message}`, 'DEBUG');
      }
    }

    const latency = Date.now() - start;
    if (stdout && stdout.includes('{')) {
      const jsonStr = stdout.substring(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
      const data = JSON.parse(jsonStr);
      gstate.currentIP = data.ip || data.query;
      gstate.currentLocation = {
        city: data.city || 'Inconnu',
        region: data.region || data.regionName || '',
        country: data.country || data.countryCode || 'US',
        loc: data.loc || ''
      };
      gstate.ispInfo = {
        org: data.org || data.isp || '',
        asn: (data.as || data.org || '').split(' ')[0] || ''
      };
      gstate.latencyMs = latency;
      gstate.status = 'HEALTHY';
      gstate.consecutiveFailures = 0;
    } else {
      gstate.consecutiveFailures += 1;
      if (gstate.consecutiveFailures >= 3) {
        gstate.status = 'UNHEALTHY';
      }
    }
  } catch (err) {
    log(`Health check error (${gw.id}): ${err.message}`, 'ERROR');
    gstate.consecutiveFailures += 1;
    if (gstate.consecutiveFailures >= 3) {
      gstate.status = 'UNHEALTHY';
    }
  } finally {
    gstate.ipFetchInFlight = false;
  }
}

// -----------------------------------------------------------------------------
// Status Health Cache (pattern Stale-While-Revalidate)
// -----------------------------------------------------------------------------
// La route /api/status ne bloque JAMAIS la réponse sur les health-checks
// réseau (curl ipinfo.io, jusqu'à ~6 s par passerelle) : elle sert l'état en
// cache instantanément et déclenche un refresh d'arrière-plan si le TTL est
// dépassé. `isFetching` joue le rôle de verrou anti-thundering-herd.
const STATUS_TTL_MS = 10_000;

async function buildStatusSnapshot() {
  const env = readEnvFile();
  const activeGateways = getActiveGateways(env);

  await Promise.allSettled(activeGateways.map(gw => fetchCurrentGatewayIP(gw)));

  const containers = await docker.listContainers();
  const nameSet = new Set((containers || []).flatMap(c => c.Names || []));

  const gateways = activeGateways.map(gw => {
    const gstate = GATEWAY_STATES.get(gw.id);
    const providers = gw.providers.map(p => {
      const matched = nameSet.has(`/${p.container}`);
      const container = (containers || []).find(c => (c.Names || []).includes(`/${p.container}`));
      return {
        ...p,
        status: matched ? (container ? container.State : 'stopped') : 'stopped',
        statusDetail: matched ? (container ? container.Status : 'Exited / Stopped') : 'Exited / Stopped',
        running: matched && container ? container.State === 'running' : false,
        containerId: matched && container ? container.Id : null
      };
    });
    return {
      id: gw.id,
      num: gw.num,
      container: gw.container,
      ip: gstate.currentIP,
      location: gstate.currentLocation,
      isp: gstate.ispInfo,
      latencyMs: gstate.latencyMs,
      status: gstate.status,
      activeProxy: gstate.activeProxy,
      providers
    };
  });

  return {
    gateways,
    summary: {
      gatewaysTotal: activeGateways.length,
      gatewaysHealthy: gateways.filter(g => g.status === 'HEALTHY').length,
      nodesRunning: gateways.reduce((acc, g) => acc + g.providers.filter(p => p.running).length, 0),
      nodesTotal: gateways.reduce((acc, g) => acc + g.providers.length, 0)
    }
  };
}

class StatusHealthCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.cache = null;
    this.lastUpdated = 0;
    this.isFetching = false;
  }

  async get() {
    const now = Date.now();

    // Phase 1 : initialisation du cache (premier appel)
    if (!this.cache) {
      if (!this.isFetching) {
        this.isFetching = true;
        try {
          this.cache = await buildStatusSnapshot();
          this.lastUpdated = Date.now();
        } finally {
          this.isFetching = false;
        }
      } else if (!this.firstWait) {
        // Requête concurrente pendant l'init : attend la fin du fetch
        this.firstWait = (async () => {
          while (this.isFetching) await new Promise(r => setTimeout(r, 50));
          return this.cache;
        })();
        await this.firstWait;
        this.firstWait = null;
      }
      return this._payload();
    }

    // Phase 2 : stale-while-revalidate (refresh en arrière-plan)
    if (now - this.lastUpdated > this.ttlMs && !this.isFetching) {
      this.isFetching = true;
      buildStatusSnapshot()
        .then(data => {
          this.cache = data;
          this.lastUpdated = Date.now();
        })
        .catch(err => {
          console.error(`[statusCache] Refresh arrière-plan échoué : ${err.message}`);
        })
        .finally(() => {
          this.isFetching = false;
        });
    }

    return this._payload();
  }

  _payload() {
    const ageMs = Date.now() - this.lastUpdated;
    return {
      data: this.cache,
      ageMs,
      isStale: ageMs > this.ttlMs
    };
  }
}

const statusCache = new StatusHealthCache(STATUS_TTL_MS);

// -----------------------------------------------------------------------------
// Helper: Fetch Current IP through gateway-isp-{n} (via docker exec ou socket API)
// -----------------------------------------------------------------------------

// 0. Healthcheck (sans auth — pour Docker)
app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// 0b. Authentification
app.post('/api/login', (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || token.length === 0) {
    return res.status(400).json({ error: 'Token manquant' });
  }
  const a = Buffer.from(token);
  const b = Buffer.from(DASHBOARD_TOKEN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    log('Tentative de connexion avec token invalide', 'WARN');
    return res.status(401).json({ error: 'Token invalide' });
  }
  issueSession(res);
  log('Connexion au dashboard réussie', 'INFO');
  res.json({ success: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  res.clearCookie('session');
  res.clearCookie('csrf');
  res.json({ success: true });
});

// 0c. Configuration (.env) — lecture
app.get('/api/config', requireAuth, (req, res) => {
  const env = readEnvFile();
  res.json({
    success: true,
    config: configSnapshot(env)
  });
});

// 0d. Configuration (.env) — mise à jour + application optionnelle
app.put('/api/config', requireAuth, requireCsrf, async (req, res) => {
  const { updates, apply = false } = req.body || {};
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Champ "updates" requis' });
  }

  const { errors, clean } = validateConfigUpdates(updates);
  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join('; ') });
  }

  if (Object.keys(clean).length > 0) {
    const ok = updateEnvFile(clean);
    if (!ok) return res.status(500).json({ error: 'Échec de l\'écriture du .env' });
  }

  let applied = false;
  if (apply) {
    try {
      log('Application de la configuration : docker compose up -d ...', 'INFO');
      await execFileAsync('docker', [
        ...composeArgs(), 'up', '-d'
      ], { timeout: 120_000 });
      applied = true;
      log('Configuration appliquée avec succès', 'INFO');
    } catch (err) {
      log(`Échec de l'application : ${err.message}`, 'ERROR');
      return res.status(500).json({ error: `Configuration enregistrée mais application échouée : ${err.message}` });
    }
  }

  // Recharger les proxys actifs depuis le .env (cohérence du dashboard)
  const fresh = readEnvFile();
  for (const gw of GATEWAYS) {
    const cfg = readGatewayEnv(gw.num, fresh);
    const gstate = GATEWAY_STATES.get(gw.id);
    if (cfg.host) {
      gstate.activeProxy = { host: cfg.host, port: cfg.port, protocol: cfg.protocol };
    }
  }
  invalidateStatusCache();

  res.json({
    success: true,
    applied,
    updatedKeys: Object.keys(clean)
  });
});

// 1. Status Overview (multi-passerelles) — réponse immédiate depuis le cache
// SWR, refresh en arrière-plan si le TTL est dépassé (aucun blocage réseau).
app.get('/api/status', requireAuth, async (req, res) => {
  const { data, ageMs, isStale } = await statusCache.get();
  res.setHeader('X-Data-Age-ms', String(ageMs));
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    meta: { dataAgeMs: ageMs, isStale },
    ...data
  });
});

// 1b. Métriques temps réel (host + conteneurs) — cache SWR, TTL 5 s
app.get('/api/metrics', requireAuth, async (req, res) => {
  const { data, ageMs, isStale } = await metricsCache.get();
  res.setHeader('X-Data-Age-ms', String(ageMs));
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    meta: { dataAgeMs: ageMs, isStale },
    ...(data || { host: null, containers: {} })
  });
});

// 2. Provider Action (Start/Stop/Restart) — scope par passerelle
app.post('/api/gateways/:gwId/providers/:id/:action', requireAuth, requireCsrf, async (req, res) => {
  const { gwId, id, action } = req.params;
  const gw = getGateway(gwId);
  if (!gw) return res.status(404).json({ error: 'Gateway not found' });
  const provider = gw.providers.find(p => p.id === id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (!ALLOWED_ACTIONS.has(action)) return res.status(400).json({ error: 'Action invalide' });

  try {
    const containers = await docker.listContainers();
    const matched = (containers || []).find(c => (c.Names || []).includes(`/${provider.container}`));

    if (action === 'restart') {
      if (matched && matched.State === 'running') {
        await docker.restartContainer(matched.Id);
      } else {
        await composeUp(provider.container);
      }
    } else if (action === 'start') {
      if (matched && matched.State !== 'running') {
        try {
          await docker.startContainer(matched.Id);
        } catch {
          await composeUp(provider.container);
        }
      } else {
        await composeUp(provider.container);
      }
    } else if (action === 'stop') {
      if (matched) {
        await docker.stopContainer(matched.Id);
      }
    }

    log(`Provider action: ${provider.name} (${gw.id}) -> ${action}`, 'INFO');
    invalidateStatusCache();
    res.json({ success: true, message: `${provider.name} ${action}ed successfully.` });
  } catch (err) {
    log(`Provider action error: ${err.message}`, 'ERROR');
    res.status(500).json({ error: err.message });
  }
});

// 3. Container Logs
app.get('/api/logs/container/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  if (!CONTAINER_NAME_RE.test(name)) return res.status(400).json({ error: 'Nom de conteneur invalide' });
  let tail = parseInt(req.query.tail || '80', 10);
  if (!Number.isFinite(tail)) tail = 80;
  tail = Math.min(Math.max(tail, 1), 2000);
  try {
    const containers = await docker.listContainers();
    // Matching strict sur le nom de conteneur (préfixe / de Docker)
    const matched = containers.find(c => (c.Names || []).includes(`/${name}`));
    if (!matched) return res.json({ logs: 'Container not currently running.' });

    const rawLogs = await docker.getContainerLogs(matched.Id, tail);
    res.json({ logs: redactSecrets(rawLogs) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. SSE Real-time Logs
app.get('/api/logs/stream', requireAuth, (req, res) => {
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ error: 'Trop de clients SSE connectés' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseClients.add(res);

  // Reconnexion : restituer uniquement les événements manqués depuis le
  // dernier id reçu (en-tête Last-Event-ID envoyé automatiquement par
  // EventSource). Connexion à froid : replay borné aux 25 derniers logs.
  const lastEventId = parseInt(req.headers['last-event-id'] || '', 10);
  let eventsToDeliver = [];
  if (Number.isFinite(lastEventId)) {
    eventsToDeliver = state.logs.filter(e => e.id > lastEventId);
  } else {
    eventsToDeliver = state.logs.slice(-25);
  }
  for (const entry of eventsToDeliver) {
    res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
  }

  // Indique au client de retenter dans 5 s en cas de coupure
  res.write('retry: 5000\n\n');

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      try { res.end(); } catch { /* déjà fermée */ }
      sseClients.delete(res);
    }
  }, 30_000);

  const onClose = () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  };
  req.on('close', onClose);
  req.on('error', onClose);
  res.on('error', onClose);
});

// -----------------------------------------------------------------------------
// Initialization & Server Start
// -----------------------------------------------------------------------------
async function init() {
  log('Starting ISP Gateway Controller & Web Dashboard...', 'INFO');

  const env = readEnvFile();
  const activeGateways = getActiveGateways(env);

  // Initialiser les états (proxys affichés) + premier fetch par passerelle
  for (const gw of activeGateways) {
    const cfg = readGatewayEnv(gw.num, env);
    const gstate = GATEWAY_STATES.get(gw.id);
    gstate.activeProxy = { host: cfg.host, port: cfg.port, protocol: cfg.protocol };
  }
  await Promise.allSettled(activeGateways.map(gw => fetchCurrentGatewayIP(gw)));

  app.listen(PORT, '0.0.0.0', () => {
    log(`ISP Web Dashboard ready on port ${PORT}`, 'INFO');
  });

  // Note : le rafraîchissement périodique des passerelles est assuré par le
  // cache SWR de /api/status (TTL 10 s, refresh en arrière-plan à la demande).

  // Signal handling
  const shutdown = (signal) => {
    log(`Signal ${signal} reçu, arrêt propre...`, 'INFO');
    for (const client of sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  console.error(`[unhandledRejection] ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[uncaughtException] ${err.stack}`);
});

init().catch((err) => {
  console.error(`[FATAL] Échec de l'initialisation : ${err.message}`);
  process.exit(1);
});
