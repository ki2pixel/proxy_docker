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
  configSnapshot, validateConfigUpdates
} from './lib.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rawPort = parseInt(process.env.PORT || '8080', 10);
const PORT = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 8080;
const APP_DIR = process.env.APP_DIR || '/workspace';
const PROJECT_NAME = 'proxy_docker';
const COMPOSE_FILE = path.join(APP_DIR, 'docker-compose.yml');
const ENV_PATH = path.join(APP_DIR, '.env');

// -----------------------------------------------------------------------------
// Configuration & Fail-Closed Validation
// -----------------------------------------------------------------------------
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || '';
const AUTO_ROTATE_SESSION = process.env.AUTO_ROTATE_SESSION !== 'false';
const AUTO_ROTATE_INTERVAL = parseInt(process.env.AUTO_ROTATE_INTERVAL || '50', 10) || 50;
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
    "style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "connect-src 'self'; " +
    "img-src 'self' data:; " +
    "base-uri 'none'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    "object-src 'none'"
  );
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

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
const rotateLimiter = rateLimit({ windowMs: 60_000, max: 3, name: 'rotation IP' });

app.use('/api', apiLimiter);
app.use('/api/login', loginLimiter);
app.use('/api/proxy/rotate', rotateLimiter);

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
    lastRotationAt: 0,
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
  const entry = { timestamp, level, message: safeMsg };
  state.logs.push(entry);
  if (state.logs.length > 200) state.logs.shift();

  console.log(`[${timestamp}] [${level}] ${safeMsg}`);
  const sseData = `data: ${JSON.stringify(entry)}\n\n`;
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
// Provider Metadata (types de nœuds de monétisation, sans instance)
// -----------------------------------------------------------------------------
const PROVIDER_TYPES = [
  { id: 'repocket', name: 'Repocket', base: 'repocket', icon: '⚡', dashboard: 'https://app.repocket.com' },
  { id: 'honeygain', name: 'Honeygain', base: 'honeygain', icon: '🍯', dashboard: 'https://dashboard.honeygain.com' },
  { id: 'pawns', name: 'Pawns.app', base: 'pawns', icon: '♟️', dashboard: 'https://pawns.app' },
  { id: 'packetstream', name: 'PacketStream', base: 'packetstream', icon: '📦', dashboard: 'https://packetstream.io' },
  { id: 'proxyrack', name: 'Proxyrack PoP', base: 'proxyrack', icon: '🌐', dashboard: 'https://peer.proxyrack.com' }
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
// Helper: Exécution docker compose (sans shell)
// -----------------------------------------------------------------------------
async function composeUp(serviceId) {
  await execFileAsync('docker', [
    'compose', '-p', PROJECT_NAME, '-f', COMPOSE_FILE,
    '--profile', serviceId, 'up', '-d', serviceId
  ], { timeout: 120_000 });
}

async function composeRestartGateway(gw) {
  await execFileAsync('docker', [
    'compose', '-p', PROJECT_NAME, '-f', COMPOSE_FILE,
    'restart', gw.container
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
// Helper: Rotation de session (IP) — par passerelle, écriture ciblée du .env
// -----------------------------------------------------------------------------
async function rotateSession(gw, reason = 'manuelle') {
  const gstate = GATEWAY_STATES.get(gw.id);
  if (Date.now() - gstate.lastRotationAt < 15_000) {
    throw new Error('Rotation trop rapprochée (garde anti-double-rotation)');
  }
  gstate.lastRotationAt = Date.now();
  log(`Rotation de session déclenchée (${gw.id}, ${reason})...`, 'INFO');

  const newSession = `live${crypto.randomBytes(4).toString('hex')}`;
  const env = readEnvFile();
  const cfg = readGatewayEnv(gw.num, env);
  if (cfg.user && cfg.user.includes('session-')) {
    const newUser = cfg.user.replace(/session-[a-zA-Z0-9_-]+/g, `session-${newSession}`);
    updateEnvFile({ [`GW${gw.num}_ISP_PROXY_USER`]: newUser });
  }

  await composeRestartGateway(gw);
  await new Promise(r => setTimeout(r, 3000));
  await fetchCurrentGatewayIP(gw);

  return { ip: gstate.currentIP, location: gstate.currentLocation };
}

// -----------------------------------------------------------------------------
// API Endpoints
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
    config: configSnapshot(env),
    proxyScheme: env.ISP_PROXY_USER?.includes('session-') ? 'session' : 'classic'
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
        'compose', '-p', PROJECT_NAME, '-f', COMPOSE_FILE, 'up', '-d'
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

  res.json({
    success: true,
    applied,
    updatedKeys: Object.keys(clean)
  });
});

// 1. Status Overview (multi-passerelles)
app.get('/api/status', requireAuth, async (req, res) => {
  const env = readEnvFile();
  const activeGateways = getActiveGateways(env);

  // Fetch IP de chaque passerelle active (en parallèle, non bloquant)
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

  // Résumé global
  const summary = {
    gatewaysTotal: activeGateways.length,
    gatewaysHealthy: gateways.filter(g => g.status === 'HEALTHY').length,
    nodesRunning: gateways.reduce((acc, g) => acc + g.providers.filter(p => p.running).length, 0),
    nodesTotal: gateways.reduce((acc, g) => acc + g.providers.length, 0)
  };

  res.json({ gateways, summary });
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
    res.json({ success: true, message: `${provider.name} ${action}ed successfully.` });
  } catch (err) {
    log(`Provider action error: ${err.message}`, 'ERROR');
    res.status(500).json({ error: err.message });
  }
});

// 2b. Proxy IP Rotation Trigger (par passerelle, défaut gw1)
app.post('/api/proxy/rotate', requireAuth, requireCsrf, async (req, res) => {
  const gwId = (req.body && req.body.gateway) || 'gw1';
  const gw = getGateway(gwId);
  if (!gw) return res.status(404).json({ error: 'Gateway not found' });
  try {
    const { ip, location } = await rotateSession(gw, 'manuelle (dashboard)');
    res.json({
      success: true,
      message: `IP tournée avec succès (${gw.id}) : ${ip}`,
      ip,
      location,
      gateway: gw.id
    });
  } catch (err) {
    log(`Rotation error (${gw.id}): ${err.message}`, 'ERROR');
    res.status(500).json({ error: err.message });
  }
});

// 2c. Rotation explicite par passerelle
app.post('/api/gateways/:gwId/rotate', requireAuth, requireCsrf, async (req, res) => {
  const gw = getGateway(req.params.gwId);
  if (!gw) return res.status(404).json({ error: 'Gateway not found' });
  try {
    const { ip, location } = await rotateSession(gw, 'manuelle (dashboard)');
    res.json({
      success: true,
      message: `IP tournée avec succès (${gw.id}) : ${ip}`,
      ip,
      location,
      gateway: gw.id
    });
  } catch (err) {
    log(`Rotation error (${gw.id}): ${err.message}`, 'ERROR');
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
    const matched = containers.find(c => (c.Names || []).some(n => n.includes(name)));
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
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  state.logs.forEach(entry => res.write(`data: ${JSON.stringify(entry)}\n\n`));

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

  // Rafraîchissement périodique de toutes les passerelles actives
  setInterval(() => {
    const fresh = readEnvFile();
    Promise.allSettled(getActiveGateways(fresh).map(gw => fetchCurrentGatewayIP(gw)));
  }, 30_000);

  // Rotation préventive centralisée, PAR passerelle active (uniquement pour les
  // proxys à session résidentielle "session-...". Sans session- dans GW{n}_ISP_PROXY_USER,
  // aucune rotation : un proxy classique HOST:PORT:USER:PASS n'a pas besoin de redémarrage
  // périodique.)
  const intervalMs = AUTO_ROTATE_INTERVAL * 60_000;
  if (AUTO_ROTATE_SESSION && AUTO_ROTATE_INTERVAL > 0) {
    setInterval(() => {
      const fresh = readEnvFile();
      for (const gw of getActiveGateways(fresh)) {
        const cfg = readGatewayEnv(gw.num, fresh);
        if (cfg.user && cfg.user.includes('session-')) {
          rotateSession(gw, 'préventive (controller)').catch(err => {
            log(`Rotation préventive échouée (${gw.id}): ${err.message}`, 'ERROR');
          });
        }
      }
    }, intervalMs);
    log(`Rotation préventive de session toutes les ${AUTO_ROTATE_INTERVAL} min (controller, par passerelle)`, 'INFO');
  } else {
    log('Rotation préventive désactivée : AUTO_ROTATE_SESSION=false ou intervalle nul', 'INFO');
  }

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
