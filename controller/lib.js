import crypto from 'crypto';

// Clés considérées comme secrètes (redaction dans les logs)
export const SECRET_KEYS = [
  'ISP_PROXY_PASS', 'API_KEY', 'UUID', 'HONEYGAIN_PASSWORD', 'PAWNS_PASSWORD',
  'PACKETSTREAM_CID', 'REPOCKET_API_KEY', 'DASHBOARD_TOKEN', 'DASHBOARD_SECRET'
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
// Configuration du dashboard (.env) : clés connues, sensibilité, catégories
// -----------------------------------------------------------------------------
const SENSITIVE_KEY_RE = /^(ISP_PROXY_PASS|API_KEY|UUID|.*_PASSWORD|.*_API_KEY)$/;

export const CONFIG_KEYS = [
  // Passerelle
  { key: 'ISP_PROXY_PROTOCOL', category: 'gateway', label: 'Protocole du proxy', options: ['socks5', 'http'] },
  { key: 'ISP_PROXY_HOST', category: 'gateway', label: 'Hôte du proxy' },
  { key: 'ISP_PROXY_PORT', category: 'gateway', label: 'Port du proxy' },
  { key: 'ISP_PROXY_USER', category: 'gateway', label: 'Utilisateur du proxy' },
  { key: 'ISP_PROXY_PASS', category: 'gateway', label: 'Mot de passe du proxy' },
  { key: 'AUTO_ROTATE_SESSION', category: 'gateway', label: 'Rotation automatique', options: ['true', 'false'] },
  { key: 'AUTO_ROTATE_INTERVAL', category: 'gateway', label: 'Intervalle de rotation (min)' },
  { key: 'GATEWAY_LOGLEVEL', category: 'gateway', label: 'Niveau de log gateway', options: ['warning', 'info', 'debug'] },
  // Dashboard
  { key: 'DASHBOARD_PORT', category: 'dashboard', label: 'Port du dashboard' },
  { key: 'COMPOSE_PROFILES', category: 'dashboard', label: 'Profils actifs', options: ['repocket', 'honeygain', 'packetstream', 'pawns', 'proxyrack', 'all'] },
  // Fournisseurs
  { key: 'API_KEY', category: 'providers', label: 'Proxyrack — clé API' },
  { key: 'UUID', category: 'providers', label: 'Proxyrack — UUID' },
  { key: 'DEVICE_NAME', category: 'providers', label: 'Proxyrack — nom du device' },
  { key: 'HONEYGAIN_EMAIL', category: 'providers', label: 'Honeygain — email' },
  { key: 'HONEYGAIN_PASSWORD', category: 'providers', label: 'Honeygain — mot de passe' },
  { key: 'HONEYGAIN_DEVICE_NAME', category: 'providers', label: 'Honeygain — device' },
  { key: 'PACKETSTREAM_CID', category: 'providers', label: 'PacketStream — CID' },
  { key: 'PAWNS_EMAIL', category: 'providers', label: 'Pawns — email' },
  { key: 'PAWNS_PASSWORD', category: 'providers', label: 'Pawns — mot de passe' },
  { key: 'PAWNS_DEVICE_NAME', category: 'providers', label: 'Pawns — device' },
  { key: 'REPOCKET_EMAIL', category: 'providers', label: 'Repocket — email' },
  { key: 'REPOCKET_API_KEY', category: 'providers', label: 'Repocket — clé API' }
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
