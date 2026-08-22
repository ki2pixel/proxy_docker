// =============================================================================
// metrics-host/server.js — exposition des métriques hôte (CPU/RAM)
// -----------------------------------------------------------------------------
// Conteneur sidecar sans dépendance : lit /proc de l'HÔTE monté en read-only
// (compose : /proc:/host/proc:ro) et expose un mini-serveur HTTP sur le réseau
// interne. Le dashboard agrège ces métriques (cache SWR) dans /api/metrics.
// Aucun bind de port sur l'hôte — accessible uniquement via le réseau compose.
// =============================================================================
import http from 'http';
import fs from 'fs';

const PORT = 9100;
const HOST_PROC = '/host/proc';
const SAMPLE_MS = 1500; // intervalle entre deux lectures /proc/stat (delta CPU)

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

function parseStat(content) {
  const line = String(content).split('\n').find(l => l.startsWith('cpu '));
  if (!line) return null;
  const nums = line.split(/\s+/).slice(1).map(Number);
  if (nums.length < 4 || nums.some(n => !Number.isFinite(n))) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = nums;
  return { user, nice, system, idle, iowait, irq, softirq, steal, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

function parseMemInfo(content) {
  const totalMatch = /^MemTotal:\s+(\d+) kB/m.exec(String(content));
  const availMatch = /^MemAvailable:\s+(\d+) kB/m.exec(String(content));
  if (!totalMatch || !availMatch) return null;
  const totalBytes = Number(totalMatch[1]) * 1024;
  const availableBytes = Number(availMatch[1]) * 1024;
  return {
    totalBytes,
    availableBytes,
    usedBytes: Math.max(totalBytes - availableBytes, 0),
    usedPercent: totalBytes > 0 ? Math.round(((totalBytes - availableBytes) / totalBytes) * 100) : 0
  };
}

let prevStat = null;
let hostname = 'hôte';

function sample() {
  const stat = parseStat(readFile(`${HOST_PROC}/stat`));
  let cpuPercent = 0;
  if (stat && prevStat && stat.total > prevStat.total) {
    const idleDelta = (stat.idle + stat.iowait) - (prevStat.idle + prevStat.iowait);
    const totalDelta = stat.total - prevStat.total;
    if (totalDelta > 0) {
      cpuPercent = Math.min(Math.max(((totalDelta - idleDelta) / totalDelta) * 100, 0), 100);
    }
  }
  prevStat = stat;
  return {
    hostname,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memory: parseMemInfo(readFile(`${HOST_PROC}/meminfo`)),
    uptimeSec: (() => {
      const u = readFile(`${HOST_PROC}/uptime`).trim().split(/\s+/)[0];
      const n = Number(u);
      return Number.isFinite(n) ? Math.round(n) : null;
    })()
  };
}

// Refresh périodique du delta CPU pour servir des valeurs à jour à chaque requête
let latest = null;
setInterval(() => { latest = sample(); }, SAMPLE_MS);
latest = sample();

http.createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/metrics') {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(latest));
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[metrics-host] écoute sur le port ${PORT} (proc hôte : ${HOST_PROC})`);
});
