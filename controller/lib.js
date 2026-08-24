import crypto from 'crypto';
import fs from 'fs';
import os from 'os';

// -----------------------------------------------------------------------------
// Passerelles supportées (multi-gateway) : GW1_..GW4_
// -----------------------------------------------------------------------------
export const GATEWAY_NUMS = [1, 2, 3, 4];

// Clés considérées comme secrètes (redaction dans les logs)
const BASE_SECRET_KEYS = [
  'ISP_PROXY_PASS', 'HONEYGAIN_PASSWORD', 'PAWNS_PASSWORD',
  'PACKETSTREAM_CID', 'REPOCKET_API_KEY', 'ANTGAIN_API_KEY',
  'HONEYGAIN_POT_PASSWORD',
  'DASHBOARD_TOKEN', 'DASHBOARD_SECRET'
];
export const SECRET_KEYS = [
  ...BASE_SECRET_KEYS,
  ...GATEWAY_NUMS.flatMap(n => BASE_SECRET_KEYS.map(k => `GW${n}_${k}`))
];

// -----------------------------------------------------------------------------
// Redaction des secrets dans les messages de log
// -----------------------------------------------------------------------------
export function redactSecrets(msg) {
  if (typeof msg !== 'string') return msg;
  let out = msg;
  for (const key of SECRET_KEYS) {
    const re = new RegExp(`(${key}=)("[^"]*"|\\S+)`, 'g');
    out = out.replace(re, '$1"***"');
    const re2 = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`, 'g');
    out = out.replace(re2, '$1***$2');
  }
  // Masque les valeurs de session résidentielle (ex: flmb59bb112-...-time-60)
  out = out.replace(/session-[a-zA-Z0-9_-]+/g, 'session-***');
  return out;
}

// -----------------------------------------------------------------------------
// Session : cookie signé HMAC-SHA256 (payload.signature)
// -----------------------------------------------------------------------------
export function signSession(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function buildSessionCookie(secret, ttlMs = 7 * 24 * 3600 * 1000) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  const payload = `${token}.${expiresAt}`;
  const sig = signSession(payload, secret);
  return `${payload}.${sig}`;
}

export function parseSession(cookieValue, secret) {
  const parts = (cookieValue || '').split('.');
  if (parts.length !== 3) return null;
  const [token, expiresAtStr, sig] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  const expected = signSession(`${token}.${expiresAtStr}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return token;
}

// -----------------------------------------------------------------------------
// Fichier .env : lecture, échappement, mise à jour
// -----------------------------------------------------------------------------
export function escapeEnvValue(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes('\n') || s.includes('\r')) {
    throw new Error('Valeur .env invalide : retour à la ligne interdit');
  }
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function parseEnv(content) {
  const out = {};
  for (const line of String(content).split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '').trim();
  }
  return out;
}

export function applyEnvUpdates(content, updates) {
  const lines = String(content).split('\n');
  const newLines = [];
  const keysUpdated = new Set();

  for (const line of lines) {
    let matched = false;
    for (const [key, val] of Object.entries(updates)) {
      if (line.startsWith(`${key}=`)) {
        newLines.push(`${key}="${escapeEnvValue(val)}"`);
        keysUpdated.add(key);
        matched = true;
        break;
      }
    }
    if (!matched) newLines.push(line);
  }

  for (const [key, val] of Object.entries(updates)) {
    if (!keysUpdated.has(key)) {
      newLines.push(`${key}="${escapeEnvValue(val)}"`);
    }
  }

  return newLines.join('\n');
}

// -----------------------------------------------------------------------------
// Divers
// -----------------------------------------------------------------------------
export function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

// -----------------------------------------------------------------------------
// Métriques hôte (CPU / RAM) : calculs purs, testables
// -----------------------------------------------------------------------------
// parseStat : parse /proc/stat (cpu aggregate) -> { user, nice, system, idle, iowait, irq, softirq, steal, total }
// Retourne null si le contenu ne contient pas de ligne "cpu " exploitable.
export function parseStat(content) {
  const line = String(content || '').split('\n').find(l => l.startsWith('cpu '));
  if (!line) return null;
  const nums = line.split(/\s+/).slice(1).map(Number);
  if (nums.length < 4 || nums.some(n => !Number.isFinite(n))) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = nums;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { user, nice, system, idle, iowait, irq, softirq, steal, total };
}

// cpuPercent : usage CPU hôte sur un intervalle, à partir de deux snapshots
// parseStat successifs. 0 si les snapshots sont invalides/identiques (évite div/0).
export function cpuPercent(prev, curr) {
  if (!prev || !curr || curr.total <= prev.total) return 0;
  const idleDelta = (curr.idle + curr.iowait) - (prev.idle + prev.iowait);
  const totalDelta = curr.total - prev.total;
  if (totalDelta <= 0) return 0;
  const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(Math.max(pct, 0), 100);
}

// parseMemInfo : parse /proc/meminfo -> { totalBytes, availableBytes, usedBytes, usedPercent, swapTotalBytes, swapFreeBytes, swapUsedBytes, swapUsedPercent }
// Retourne null si meminfo est absent (hôte non-Linux, fallback).
export function parseMemInfo(content) {
  const totalMatch = /^MemTotal:\s+(\d+) kB/m.exec(String(content || ''));
  const availMatch = /^MemAvailable:\s+(\d+) kB/m.exec(String(content || ''));
  if (!totalMatch || !availMatch) return null;
  const totalBytes = Number(totalMatch[1]) * 1024;
  const availableBytes = Number(availMatch[1]) * 1024;
  const usedBytes = Math.max(totalBytes - availableBytes, 0);
  const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

  const swapTotalMatch = /^SwapTotal:\s+(\d+) kB/m.exec(String(content || ''));
  const swapFreeMatch = /^SwapFree:\s+(\d+) kB/m.exec(String(content || ''));
  const swapTotalBytes = swapTotalMatch ? Number(swapTotalMatch[1]) * 1024 : 0;
  const swapFreeBytes = swapFreeMatch ? Number(swapFreeMatch[1]) * 1024 : 0;
  const swapUsedBytes = Math.max(swapTotalBytes - swapFreeBytes, 0);
  const swapUsedPercent = swapTotalBytes > 0 ? Math.round((swapUsedBytes / swapTotalBytes) * 100) : 0;

  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedPercent,
    swapTotalBytes,
    swapFreeBytes,
    swapUsedBytes,
    swapUsedPercent
  };
}

// -----------------------------------------------------------------------------
// Pression Système (PSI — Pressure Stall Information : /proc/pressure/*)
// -----------------------------------------------------------------------------
// parsePressureLine : parse une ligne PSI (ex: "some avg10=0.00 avg60=0.00 avg300=0.00 total=12345")
export function parsePressureLine(line) {
  if (!line) return null;
  const match = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/.exec(String(line).trim());
  if (!match) return null;
  const [, type, avg10, avg60, avg300, total] = match;
  return {
    type,
    avg10: parseFloat(avg10),
    avg60: parseFloat(avg60),
    avg300: parseFloat(avg300),
    total: parseInt(total, 10)
  };
}

// parsePressureFile : parse l'intégralité d'un fichier PSI (/proc/pressure/{memory,cpu,io})
export function parsePressureFile(content) {
  if (!content) return null;
  const lines = String(content).trim().split('\n');
  const res = {};
  for (const line of lines) {
    const parsed = parsePressureLine(line);
    if (parsed) {
      res[parsed.type] = {
        avg10: parsed.avg10,
        avg60: parsed.avg60,
        avg300: parsed.avg300,
        total: parsed.total
      };
    }
  }
  return Object.keys(res).length > 0 ? res : null;
}

// evaluatePressureStatus : évalue l'état de pression global et la détection du thrashing
export function evaluatePressureStatus(pressure) {
  if (!pressure || (!pressure.memory && !pressure.cpu && !pressure.io)) {
    return {
      level: 'unknown',
      label: 'Indisponible',
      message: 'PSI non disponible sur cet hôte'
    };
  }
  const memFull = pressure.memory?.full?.avg10 ?? 0;
  const memSome = pressure.memory?.some?.avg10 ?? 0;
  const ioFull = pressure.io?.full?.avg10 ?? 0;
  const cpuSome = pressure.cpu?.some?.avg10 ?? 0;

  // Thrashing critique si full avg10 mémoire >= 15% (selon rapport d'optimisation VM 1 Go)
  if (memFull >= 15) {
    return {
      level: 'critical',
      label: 'Thrashing Critique',
      message: `Saturation mémoire sévère (full memory avg10: ${memFull.toFixed(1)}%)`
    };
  }
  // Pression élevée (warning)
  if (memFull >= 5 || memSome >= 20 || ioFull >= 15 || cpuSome >= 50) {
    return {
      level: 'warning',
      label: 'Pression Élevée',
      message: `Contention détectée (mem full: ${memFull.toFixed(1)}%, mem some: ${memSome.toFixed(1)}%, io: ${ioFull.toFixed(1)}%)`
    };
  }
  return {
    level: 'nominal',
    label: 'Nominale',
    message: 'Aucune contention critique détectée'
  };
}

// HostMetricsCollector : collecte in-process des métriques de l'hôte sans sidecar
export class HostMetricsCollector {
  constructor(hostProcPath = null) {
    this.hostProc = hostProcPath || process.env.HOST_PROC || (fs.existsSync('/host/proc') ? '/host/proc' : '/proc');
    this.prevStat = null;
  }

  readFile(relPath) {
    try {
      return fs.readFileSync(`${this.hostProc}/${relPath}`, 'utf-8');
    } catch {
      return '';
    }
  }

  collect() {
    const statContent = this.readFile('stat');
    const currStat = parseStat(statContent);
    let cpuPct = 0;
    if (currStat && this.prevStat) {
      cpuPct = cpuPercent(this.prevStat, currStat);
    }
    this.prevStat = currStat;

    const meminfoContent = this.readFile('meminfo');
    const memory = parseMemInfo(meminfoContent);

    // Si ni stat ni meminfo n'ont pu être lus, l'hôte est considéré indisponible
    if (!currStat && !memory) {
      return null;
    }

    const uptimeRaw = this.readFile('uptime').trim().split(/\s+/)[0];
    const uptimeNum = Number(uptimeRaw);
    const uptimeSec = Number.isFinite(uptimeNum) ? Math.round(uptimeNum) : null;

    // PSI (/proc/pressure/*)
    const memPressure = parsePressureFile(this.readFile('pressure/memory'));
    const cpuPressure = parsePressureFile(this.readFile('pressure/cpu'));
    const ioPressure = parsePressureFile(this.readFile('pressure/io'));

    let pressure = null;
    if (memPressure || cpuPressure || ioPressure) {
      pressure = {
        memory: memPressure,
        cpu: cpuPressure,
        io: ioPressure
      };
      pressure.status = evaluatePressureStatus(pressure);
    } else {
      pressure = {
        memory: null,
        cpu: null,
        io: null,
        status: evaluatePressureStatus(null)
      };
    }

    let hostname = 'hôte';
    try {
      hostname = os.hostname();
    } catch {
      // fallback
    }

    return {
      hostname,
      cpuPercent: Math.round(cpuPct * 10) / 10,
      memory,
      pressure,
      uptimeSec
    };
  }
}

// -----------------------------------------------------------------------------
// Configuration du dashboard (.env) : clés connues, sensibilité, catégories
// -----------------------------------------------------------------------------
// Une clé est sensible si elle est secrète, éventuellement préfixée par passerelle (GW1_, GW2_...)
const SENSITIVE_KEY_RE = /^(GW\d+_)?(ISP_PROXY_PASS|.*_PASSWORD|.*_API_KEY)$/;

// Meta des clés globales (dashboard + gateway commun)
const GLOBAL_KEYS = [
  { key: 'DASHBOARD_PORT', category: 'global', label: 'Port du dashboard' },
  { key: 'COMPOSE_PROFILES', category: 'global', label: 'Profils actifs', options: ['none', 'repocket', 'honeygain', 'packetstream', 'pawns', 'antgain', 'all', 'honeygain-pot'] },
  { key: 'ENABLED_GATEWAYS', category: 'global', label: 'Passerelles actives (ex. 1,2,3,4)' },
  { key: 'GATEWAY_LOGLEVEL', category: 'global', label: 'Niveau de log gateway', options: ['warning', 'info', 'debug'] },
  { key: 'ANTGAIN_API_KEY', category: 'global', label: 'Antgain — clé API (partagée)' },
  { key: 'HONEYGAIN_POT_EMAIL', category: 'global', label: 'Honeygain Pot — email (optionnel)' },
  { key: 'HONEYGAIN_POT_PASSWORD', category: 'global', label: 'Honeygain Pot — mot de passe (optionnel)' }
];

// Meta des clés par passerelle (proxy + 5 providers)
const GATEWAY_KEYS = (n) => [
  { key: `GW${n}_ISP_PROXY_PROTOCOL`, category: `gw${n}`, label: 'Protocole du proxy', options: ['socks5', 'http'] },
  { key: `GW${n}_ISP_PROXY_HOST`, category: `gw${n}`, label: 'Hôte du proxy' },
  { key: `GW${n}_ISP_PROXY_PORT`, category: `gw${n}`, label: 'Port du proxy' },
  { key: `GW${n}_ISP_PROXY_USER`, category: `gw${n}`, label: 'Utilisateur du proxy' },
  { key: `GW${n}_ISP_PROXY_PASS`, category: `gw${n}`, label: 'Mot de passe du proxy' },
  { key: `GW${n}_ANTGAIN_DEVICE_ID`, category: `gw${n}`, label: 'Antgain — UUID device (stable)' },
  { key: `GW${n}_HONEYGAIN_EMAIL`, category: `gw${n}`, label: 'Honeygain — email' },
  { key: `GW${n}_HONEYGAIN_PASSWORD`, category: `gw${n}`, label: 'Honeygain — mot de passe' },
  { key: `GW${n}_HONEYGAIN_DEVICE_NAME`, category: `gw${n}`, label: 'Honeygain — device' },
  { key: `GW${n}_PACKETSTREAM_CID`, category: `gw${n}`, label: 'PacketStream — CID' },
  { key: `GW${n}_PAWNS_EMAIL`, category: `gw${n}`, label: 'Pawns — email' },
  { key: `GW${n}_PAWNS_PASSWORD`, category: `gw${n}`, label: 'Pawns — mot de passe' },
  { key: `GW${n}_PAWNS_DEVICE_NAME`, category: `gw${n}`, label: 'Pawns — device' },
  { key: `GW${n}_REPOCKET_EMAIL`, category: `gw${n}`, label: 'Repocket — email' },
  { key: `GW${n}_REPOCKET_API_KEY`, category: `gw${n}`, label: 'Repocket — clé API' }
];

// Clés historiques (mono-passerelle) : conservées pour la migration et la redaction
const LEGACY_KEYS = [
  { key: 'ISP_PROXY_PROTOCOL', category: 'legacy', label: 'Protocole du proxy (legacy)' },
  { key: 'ISP_PROXY_HOST', category: 'legacy', label: 'Hôte du proxy (legacy)' },
  { key: 'ISP_PROXY_PORT', category: 'legacy', label: 'Port du proxy (legacy)' },
  { key: 'ISP_PROXY_USER', category: 'legacy', label: 'Utilisateur du proxy (legacy)' },
  { key: 'ISP_PROXY_PASS', category: 'legacy', label: 'Mot de passe du proxy (legacy)' },
  { key: 'ANTGAIN_DEVICE_ID', category: 'legacy', label: 'Antgain — UUID device (legacy)' },
  { key: 'HONEYGAIN_EMAIL', category: 'legacy', label: 'Honeygain — email (legacy)' },
  { key: 'HONEYGAIN_PASSWORD', category: 'legacy', label: 'Honeygain — mot de passe (legacy)' },
  { key: 'HONEYGAIN_DEVICE_NAME', category: 'legacy', label: 'Honeygain — device (legacy)' },
  { key: 'PACKETSTREAM_CID', category: 'legacy', label: 'PacketStream — CID (legacy)' },
  { key: 'PAWNS_EMAIL', category: 'legacy', label: 'Pawns — email (legacy)' },
  { key: 'PAWNS_PASSWORD', category: 'legacy', label: 'Pawns — mot de passe (legacy)' },
  { key: 'PAWNS_DEVICE_NAME', category: 'legacy', label: 'Pawns — device (legacy)' },
  { key: 'REPOCKET_EMAIL', category: 'legacy', label: 'Repocket — email (legacy)' },
  { key: 'REPOCKET_API_KEY', category: 'legacy', label: 'Repocket — clé API (legacy)' }
];

export const CONFIG_KEYS = [
  ...GLOBAL_KEYS,
  ...GATEWAY_NUMS.flatMap(n => GATEWAY_KEYS(n)),
  ...LEGACY_KEYS
];

const CONFIG_BY_KEY = new Map(CONFIG_KEYS.map(c => [c.key, c]));

export function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(key);
}

export function isKnownConfigKey(key) {
  return CONFIG_BY_KEY.has(key);
}

export function getConfigMeta(key) {
  return CONFIG_BY_KEY.get(key) || null;
}

export function configSnapshot(env) {
  return CONFIG_KEYS.map(meta => ({
    key: meta.key,
    label: meta.label,
    category: meta.category,
    options: meta.options || null,
    sensitive: isSensitiveKey(meta.key),
    hasValue: Boolean(env[meta.key]),
    value: isSensitiveKey(meta.key) ? null : (env[meta.key] ?? '')
  }));
}

export function validateConfigUpdates(updates) {
  const errors = [];
  const clean = {};
  for (const [key, value] of Object.entries(updates || {})) {
    if (!isKnownConfigKey(key)) {
      errors.push(`Clé inconnue : ${key}`);
      continue;
    }
    if (value === null || value === undefined || value === '') continue; // inchangé
    if (typeof value !== 'string') {
      errors.push(`Valeur invalide pour ${key}`);
      continue;
    }
    if (value.includes('\n') || value.includes('\r')) {
      errors.push(`Valeur avec saut de ligne refusée pour ${key}`);
      continue;
    }
    clean[key] = value;
  }
  return { errors, clean };
}
