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
// Global In-Memory State & Cache
// -----------------------------------------------------------------------------
const state = {
  currentIP: null,
  currentLocation: null,
  ispInfo: null,
  latencyMs: null,
  gatewayStatus: 'UNKNOWN',
  activeProxy: {
    host: process.env.ISP_PROXY_HOST || '',
    port: process.env.ISP_PROXY_PORT || '',
    protocol: process.env.ISP_PROXY_PROTOCOL || 'socks5'
  },
  logs: [],
  consecutiveFailures: 0,
  lastRotationAt: 0,
  ipFetchInFlight: false
};

const sseClients = new Set();
const MAX_SSE_CLIENTS = 20;

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
// Provider Metadata
// -----------------------------------------------------------------------------
const PROVIDERS = [
  { id: 'repocket', name: 'Repocket', container: 'repocket', icon: '⚡', dashboard: 'https://app.repocket.com' },
  { id: 'honeygain', name: 'Honeygain', container: 'honeygain', icon: '🍯', dashboard: 'https://dashboard.honeygain.com' },
  { id: 'pawns', name: 'Pawns.app', container: 'pawns', icon: '♟️', dashboard: 'https://pawns.app' },
  { id: 'packetstream', name: 'PacketStream', container: 'packetstream', icon: '📦', dashboard: 'https://packetstream.io' },
  { id: 'proxyrack', name: 'Proxyrack PoP', container: 'proxyrack-pop', icon: '🌐', dashboard: 'https://peer.proxyrack.com' }
];

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

async function composeRestartGateway() {
  await execFileAsync('docker', [
    'compose', '-p', PROJECT_NAME, '-f', COMPOSE_FILE,
    'restart', 'gateway-isp'
  ], { timeout: 120_000 });
}

// -----------------------------------------------------------------------------
// Helper: Fetch Current IP through gateway-isp (via SOCKS bridge ou docker exec)
// -----------------------------------------------------------------------------
async function fetchCurrentGatewayIP() {
  if (state.ipFetchInFlight) return;
  state.ipFetchInFlight = true;
  try {
    const start = Date.now();
    let stdout = '';
    try {
      const res = await execFileAsync('curl', [
        '-s', '--max-time', '4', '--socks5', 'gateway-isp:23320',
        'https://ipinfo.io/json'
      ], { timeout: 8000 });
      stdout = res.stdout;
    } catch {
      try {
        const res = await execFileAsync('docker', [
          'exec', 'gateway-isp', 'curl', '-s', '-k', '--max-time', '4',
          'https://ipinfo.io/json'
        ], { timeout: 8000 });
        stdout = res.stdout;
      } catch (err) {
        log(`Health check note: ${err.message}`, 'DEBUG');
      }
    }

    const latency = Date.now() - start;
    if (stdout && stdout.includes('{')) {
      const data = JSON.parse(stdout);
      state.currentIP = data.ip || data.query;
      state.currentLocation = {
        city: data.city || 'Inconnu',
        region: data.region || data.regionName || '',
        country: data.country || data.countryCode || 'US',
        loc: data.loc || ''
      };
      state.ispInfo = {
        org: data.org || data.isp || '',
        asn: (data.as || data.org || '').split(' ')[0] || ''
      };
      state.latencyMs = latency;
      state.gatewayStatus = 'HEALTHY';
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= 3) {
        state.gatewayStatus = 'UNHEALTHY';
      }
    }
  } catch (err) {
    log(`Health check error: ${err.message}`, 'ERROR');
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= 3) {
      state.gatewayStatus = 'UNHEALTHY';
    }
  } finally {
    state.ipFetchInFlight = false;
  }
}

// -----------------------------------------------------------------------------
// Helper: Rotation de session (IP) — seule écriture centralisée du .env
// -----------------------------------------------------------------------------
async function rotateSession(reason = 'manuelle') {
  if (Date.now() - state.lastRotationAt < 15_000) {
    throw new Error('Rotation trop rapprochée (garde anti-double-rotation)');
  }
  state.lastRotationAt = Date.now();
  log(`Rotation de session déclenchée (${reason})...`, 'INFO');

  const newSession = `live${crypto.randomBytes(4).toString('hex')}`;
  const env = readEnvFile();
  if (env.ISP_PROXY_USER && env.ISP_PROXY_USER.includes('session-')) {
    const newUser = env.ISP_PROXY_USER.replace(/session-[a-zA-Z0-9_-]+/g, `session-${newSession}`);
    updateEnvFile({ ISP_PROXY_USER: newUser });
  }

  await composeRestartGateway();
  await new Promise(r => setTimeout(r, 3000));
  await fetchCurrentGatewayIP();

  // Relire le .env pour mettre à jour l'affichage du proxy actif
  const fresh = readEnvFile();
  state.activeProxy = {
    host: fresh.ISP_PROXY_HOST || process.env.ISP_PROXY_HOST || '',
    port: fresh.ISP_PROXY_PORT || process.env.ISP_PROXY_PORT || '',
    protocol: fresh.ISP_PROXY_PROTOCOL || process.env.ISP_PROXY_PROTOCOL || 'socks5'
  };

  return { ip: state.currentIP, location: state.currentLocation };
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

  // Recharger le proxy actif depuis le .env (cohérence du dashboard)
  const fresh = readEnvFile();
  if (fresh.ISP_PROXY_HOST) {
    state.activeProxy = {
      host: fresh.ISP_PROXY_HOST,
      port: fresh.ISP_PROXY_PORT || '',
      protocol: fresh.ISP_PROXY_PROTOCOL || 'socks5'
    };
  }

  res.json({
    success: true,
    applied,
    updatedKeys: Object.keys(clean)
  });
});

// 1. Status Overview
app.get('/api/status', requireAuth, async (req, res) => {
  await fetchCurrentGatewayIP();
  const containers = await docker.listContainers();

  const providerStatuses = PROVIDERS.map(p => {
    const matched = containers.find(c => (c.Names || []).some(n => n.includes(p.container)));
    return {
      ...p,
      status: matched ? matched.State : 'stopped',
      statusDetail: matched ? matched.Status : 'Exited / Stopped',
      running: matched ? matched.State === 'running' : false,
      containerId: matched ? matched.Id : null
    };
  });

  res.json({
    ip: state.currentIP,
    location: state.currentLocation,
    isp: state.ispInfo,
    latencyMs: state.latencyMs,
    gatewayStatus: state.gatewayStatus,
    activeProxy: state.activeProxy,
    providers: providerStatuses
  });
});

// 2. Provider Action (Start/Stop/Restart)
app.post('/api/providers/:id/:action', requireAuth, requireCsrf, async (req, res) => {
  const { id, action } = req.params;
  const provider = PROVIDERS.find(p => p.id === id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (!ALLOWED_ACTIONS.has(action)) return res.status(400).json({ error: 'Action invalide' });

  try {
    const containers = await docker.listContainers();
    const matched = containers.find(c => (c.Names || []).some(n => n.includes(provider.container)));

    if (action === 'restart') {
      if (matched && matched.State === 'running') {
        await docker.restartContainer(matched.Id);
      } else {
        await composeUp(id);
      }
    } else if (action === 'start') {
      if (matched && matched.State !== 'running') {
        try {
          await docker.startContainer(matched.Id);
        } catch {
          await composeUp(id);
        }
      } else {
        await composeUp(id);
      }
    } else if (action === 'stop') {
      if (matched) {
        await docker.stopContainer(matched.Id);
      }
    }

    log(`Provider action: ${provider.name} -> ${action}`, 'INFO');
    res.json({ success: true, message: `${provider.name} ${action}ed successfully.` });
  } catch (err) {
    log(`Provider action error: ${err.message}`, 'ERROR');
    res.status(500).json({ error: err.message });
  }
});

// 2b. Proxy IP Rotation Trigger
app.post('/api/proxy/rotate', requireAuth, requireCsrf, async (req, res) => {
  try {
    const { ip, location } = await rotateSession('manuelle (dashboard)');
    res.json({
      success: true,
      message: `IP tournée avec succès : ${ip}`,
      ip,
      location
    });
  } catch (err) {
    log(`Rotation error: ${err.message}`, 'ERROR');
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
  if (env.ISP_PROXY_HOST) {
    state.activeProxy = {
      host: env.ISP_PROXY_HOST,
      port: env.ISP_PROXY_PORT || '',
      protocol: env.ISP_PROXY_PROTOCOL || 'socks5'
    };
  }

  await fetchCurrentGatewayIP();

  app.listen(PORT, '0.0.0.0', () => {
    log(`ISP Web Dashboard ready on port ${PORT}`, 'INFO');
  });

  setInterval(fetchCurrentGatewayIP, 30_000);

  // Rotation préventive centralisée (uniquement pour les proxys à session résidentielle
  // de type "session-...". Sans session- dans ISP_PROXY_USER, aucune rotation : un proxy
  // classique HOST:PORT:USER:PASS n'a pas besoin d'être redémarré périodiquement.)
  const proxyUser = readEnvFile().ISP_PROXY_USER || '';
  if (AUTO_ROTATE_SESSION && AUTO_ROTATE_INTERVAL > 0 && proxyUser.includes('session-')) {
    const intervalMs = AUTO_ROTATE_INTERVAL * 60_000;
    log(`Rotation préventive de session toutes les ${AUTO_ROTATE_INTERVAL} min (controller)`, 'INFO');
    setInterval(() => {
      rotateSession('préventive (controller)').catch(err => {
        log(`Rotation préventive échouée: ${err.message}`, 'ERROR');
      });
    }, intervalMs);
  } else {
    log('Rotation préventive désactivée : proxy sans session résidentielle (schéma classique)', 'INFO');
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
