import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '8080', 10);
const APP_DIR = process.env.APP_DIR || '/workspace';
const PROJECT_NAME = 'proxy_docker';
const ENV_PATH = path.join(APP_DIR, '.env');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------------
// Global In-Memory State & Cache
// -----------------------------------------------------------------------------
const state = {
  currentIP: null,
  currentLocation: null,
  ispInfo: null,
  latencyMs: null,
  gatewayStatus: 'HEALTHY',
  activeProxy: {
    host: process.env.ISP_PROXY_HOST || '194.70.234.170',
    port: process.env.ISP_PROXY_PORT || '1085',
    protocol: process.env.ISP_PROXY_PROTOCOL || 'socks5'
  },
  logs: []
};

// SSE log clients
const sseClients = new Set();

function log(msg, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message: msg };
  state.logs.push(entry);
  if (state.logs.length > 200) state.logs.shift();

  console.log(`[${timestamp}] [${level}] ${msg}`);
  const sseData = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(sseData);
    } catch {
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
            const content = raw.subarray(offset + 8, offset + 8 + size).toString('utf-8');
            clean += content;
            offset += 8 + size;
          }
          resolve(clean || raw.toString('utf-8'));
        });
      });
      req.on('error', reject);
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
// Helper: Update .env File
// -----------------------------------------------------------------------------
function updateEnvFile(updates) {
  try {
    if (!fs.existsSync(ENV_PATH)) return false;
    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    const lines = content.split('\n');
    const newLines = [];
    const keysUpdated = new Set();

    for (const line of lines) {
      let matched = false;
      for (const [key, val] of Object.entries(updates)) {
        if (line.startsWith(`${key}=`)) {
          newLines.push(`${key}="${val}"`);
          keysUpdated.add(key);
          matched = true;
          break;
        }
      }
      if (!matched) newLines.push(line);
    }

    for (const [key, val] of Object.entries(updates)) {
      if (!keysUpdated.has(key)) {
        newLines.push(`${key}="${val}"`);
      }
    }

    fs.writeFileSync(ENV_PATH, newLines.join('\n'));
    log(`Updated .env with: ${JSON.stringify(updates)}`, 'INFO');
    return true;
  } catch (err) {
    log(`Failed to update .env: ${err.message}`, 'ERROR');
    return false;
  }
}

// -----------------------------------------------------------------------------
// Helper: Fetch Current IP through gateway-isp (via SOCKS bridge or docker exec)
// -----------------------------------------------------------------------------
async function fetchCurrentGatewayIP() {
  try {
    const start = Date.now();
    let stdout = '';
    try {
      const res = await execAsync('curl -s -k --max-time 4 --socks5 gateway-isp:23320 https://ipinfo.io/json || curl -s --max-time 4 --socks5 gateway-isp:23320 http://ip-api.com/json');
      stdout = res.stdout;
    } catch {
      try {
        const res = await execAsync('docker exec gateway-isp curl -s -k --max-time 4 https://ipinfo.io/json || docker exec gateway-isp curl -s --max-time 4 http://ip-api.com/json');
        stdout = res.stdout;
      } catch {}
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
        org: data.org || data.isp || 'Cox Communications Inc.',
        asn: (data.as || data.org || '').split(' ')[0] || 'AS22773'
      };
      state.latencyMs = latency;
      state.gatewayStatus = 'HEALTHY';
    }
  } catch (err) {
    log(`Health check note: ${err.message}`, 'DEBUG');
  }
}

// -----------------------------------------------------------------------------
// API Endpoints
// -----------------------------------------------------------------------------

// 1. Status Overview
app.get('/api/status', async (req, res) => {
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
app.post('/api/providers/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const provider = PROVIDERS.find(p => p.id === id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });

  const composeFile = fs.existsSync(path.join(APP_DIR, 'docker-compose.yml'))
    ? path.join(APP_DIR, 'docker-compose.yml')
    : path.join(APP_DIR, 'docker-compose.isp.yml');

  try {
    const containers = await docker.listContainers();
    const matched = containers.find(c => (c.Names || []).some(n => n.includes(provider.container)));

    if (action === 'restart') {
      if (matched && matched.State === 'running') {
        await docker.restartContainer(matched.Id);
      } else {
        await execAsync(`docker compose -p "${PROJECT_NAME}" -f "${composeFile}" --profile "${id}" up -d "${id}"`);
      }
    } else if (action === 'start') {
      if (matched && matched.State !== 'running') {
        try {
          await docker.startContainer(matched.Id);
        } catch {
          await execAsync(`docker compose -p "${PROJECT_NAME}" -f "${composeFile}" --profile "${id}" up -d "${id}"`);
        }
      } else {
        await execAsync(`docker compose -p "${PROJECT_NAME}" -f "${composeFile}" --profile "${id}" up -d "${id}"`);
      }
    } else if (action === 'stop') {
      if (matched) {
        await docker.stopContainer(matched.Id);
      }
    }

    res.json({ success: true, message: `${provider.name} ${action}ed successfully.` });
  } catch (err) {
    log(`Provider action error: ${err.message}`, 'ERROR');
    res.status(500).json({ error: err.message });
  }
});

// 3. Container Logs
app.get('/api/logs/container/:name', async (req, res) => {
  const { name } = req.params;
  const tail = parseInt(req.query.tail || '80', 10);
  try {
    const containers = await docker.listContainers();
    const matched = containers.find(c => (c.Names || []).some(n => n.includes(name)));
    if (!matched) return res.json({ logs: 'Container not currently running.' });

    const rawLogs = await docker.getContainerLogs(matched.Id, tail);
    res.json({ logs: rawLogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. SSE Real-time Logs
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  sseClients.add(res);
  state.logs.forEach(entry => res.write(`data: ${JSON.stringify(entry)}\n\n`));

  req.on('close', () => sseClients.delete(res));
});

// -----------------------------------------------------------------------------
// Initialization & Server Start
// -----------------------------------------------------------------------------
async function init() {
  log('Starting ISP Gateway Controller & Web Dashboard...', 'INFO');
  await fetchCurrentGatewayIP();

  app.listen(PORT, '0.0.0.0', () => {
    log(`ISP Web Dashboard ready on http://0.0.0.0:${PORT} (mapped to http://localhost:${process.env.DASHBOARD_PORT || 8088})`, 'INFO');
  });

  setInterval(fetchCurrentGatewayIP, 30000);
}

init();
