import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactSecrets, signSession, buildSessionCookie, parseSession,
  escapeEnvValue, parseEnv, applyEnvUpdates, clampInt,
  CONTAINER_NAME_RE, ALLOWED_ACTIONS,
  parseStat, cpuPercent, parseMemInfo
} from '../lib.js';

const SECRET = 'a'.repeat(64);

// -----------------------------------------------------------------------------
// redactSecrets
// -----------------------------------------------------------------------------
test('redactSecrets masque les valeurs de clés secrètes', () => {
  assert.equal(
    redactSecrets('ISP_PROXY_PASS="monpass"'),
    'ISP_PROXY_PASS="***"'
  );
  assert.equal(
    redactSecrets('EARNFM_TOKEN="jeton-earnfm-1234567890"'),
    'EARNFM_TOKEN="***"'
  );
});

test('redactSecrets masque les sessions résidentielles', () => {
  assert.equal(
    redactSecrets('user flmb59bb112-session-fresh736029426-time-60'),
    'user flmb59bb112-session-***'
  );
});

test('redactSecrets masque les clés en JSON', () => {
  assert.equal(
    redactSecrets('{"DASHBOARD_SECRET": "valeur-secrete"}'),
    '{"DASHBOARD_SECRET": "***"}'
  );
});

test('redactSecrets laisse les messages normaux intacts', () => {
  assert.equal(redactSecrets('Tout va bien'), 'Tout va bien');
  assert.equal(redactSecrets(null), null);
});

// -----------------------------------------------------------------------------
// Session signée HMAC
// -----------------------------------------------------------------------------
test('parseSession accepte un cookie valide', () => {
  const cookie = buildSessionCookie(SECRET);
  assert.ok(parseSession(cookie, SECRET));
});

test('parseSession rejette un cookie falsifié', () => {
  const cookie = buildSessionCookie(SECRET);
  const forged = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  assert.equal(parseSession(forged, SECRET), null);
});

test('parseSession rejette un cookie avec un autre secret', () => {
  const cookie = buildSessionCookie(SECRET);
  assert.equal(parseSession(cookie, 'b'.repeat(64)), null);
});

test('parseSession rejette un cookie expiré', () => {
  // Construit un cookie expiré manuellement
  const token = 'x'.repeat(64);
  const expiresAt = Date.now() - 1000;
  const payload = `${token}.${expiresAt}`;
  const sig = signSession(payload, SECRET);
  assert.equal(parseSession(`${payload}.${sig}`, SECRET), null);
});

test('parseSession rejette un cookie malformé', () => {
  assert.equal(parseSession('pas-un-cookie', SECRET), null);
  assert.equal(parseSession('', SECRET), null);
  assert.equal(parseSession(undefined, SECRET), null);
});

// -----------------------------------------------------------------------------
// .env : parse, échappement, updates
// -----------------------------------------------------------------------------
test('parseEnv lit les clés avec et sans quotes', () => {
  const env = parseEnv('A="valeur avec espaces"\nB=simple\n# commentaire\nC="x"');
  assert.deepEqual(env, { A: 'valeur avec espaces', B: 'simple', C: 'x' });
});

test('escapeEnvValue échappe backslash et double-quote', () => {
  assert.equal(escapeEnvValue('a\\b'), 'a\\\\b');
  assert.equal(escapeEnvValue('a"b'), 'a\\"b');
  assert.equal(escapeEnvValue('simple'), 'simple');
});

test('escapeEnvValue refuse les retours à la ligne', () => {
  assert.throws(() => escapeEnvValue('a\nb'), /retour à la ligne/);
});

test('applyEnvUpdates met à jour une clé existante', () => {
  const out = applyEnvUpdates('A="1"\nB="2"\n', { A: 'nouvelle' });
  assert.equal(out, 'A="nouvelle"\nB="2"\n');
});

test('applyEnvUpdates ajoute une clé absente', () => {
  const out = applyEnvUpdates('A="1"\n', { B: '2' });
  assert.match(out, /A="1"/);
  assert.match(out, /B="2"/);
});

test('applyEnvUpdates échappe les valeurs spéciales', () => {
  const out = applyEnvUpdates('A="1"\n', { A: 'v"l' });
  assert.match(out, /A="v\\"l"/);
});

// -----------------------------------------------------------------------------
// clampInt
// -----------------------------------------------------------------------------
test('clampInt borne les valeurs', () => {
  assert.equal(clampInt('500', 80, 1, 2000), 500);
  assert.equal(clampInt('5000', 80, 1, 2000), 2000);
  assert.equal(clampInt('0', 80, 1, 2000), 1);
  assert.equal(clampInt('abc', 80, 1, 2000), 80);
});

// -----------------------------------------------------------------------------
// Validation entrées
// -----------------------------------------------------------------------------
test('CONTAINER_NAME_RE valide les noms Docker', () => {
  assert.ok(CONTAINER_NAME_RE.test('gateway-isp'));
  assert.ok(CONTAINER_NAME_RE.test('repocket'));
  assert.ok(!CONTAINER_NAME_RE.test('../etc'));
  assert.ok(!CONTAINER_NAME_RE.test('a/b'));
  assert.ok(!CONTAINER_NAME_RE.test(''));
  assert.ok(!CONTAINER_NAME_RE.test('-leading'));
});

test('ALLOWED_ACTIONS contient start/stop/restart', () => {
  assert.ok(ALLOWED_ACTIONS.has('start'));
  assert.ok(ALLOWED_ACTIONS.has('stop'));
  assert.ok(ALLOWED_ACTIONS.has('restart'));
  assert.ok(!ALLOWED_ACTIONS.has('delete'));
});

// -----------------------------------------------------------------------------
// Métriques hôte : parseStat / cpuPercent / parseMemInfo
// -----------------------------------------------------------------------------
test('parseStat extrait les compteurs CPU agrégés', () => {
  const stat = parseStat('cpu  100 20 300 500 30 5 3 0\ncpu0 10 2 30 50\nintr 123\n');
  assert.deepEqual(stat, { user: 100, nice: 20, system: 300, idle: 500, iowait: 30, irq: 5, softirq: 3, steal: 0, total: 958 });
});

test('parseStat gère les lignes incomplètes (iowait/irq absents)', () => {
  const stat = parseStat('cpu  100 20 300 500\ncpu0 10 2 30 50\n');
  assert.equal(stat.user, 100);
  assert.equal(stat.total, 920);
});

test('parseStat retourne null sans ligne cpu agrégée', () => {
  assert.equal(parseStat('cpu0 10 2 30 50\n'), null);
  assert.equal(parseStat(''), null);
  assert.equal(parseStat(null), null);
});

test('cpuPercent calcule le pourcentage sur un intervalle', () => {
  // Delta idle (500+30) -> (600+40) = 110 ; delta total = 958 -> 1970
  // Usage = (1012 - 110) / 1012 = 89,1%
  const prev = parseStat('cpu  100 20 300 500 30 5 3 0');
  const curr = parseStat('cpu  500 100 700 600 40 15 10 5');
  assert.ok(Math.abs(cpuPercent(prev, curr) - 89.13) < 0.01);
});

test('cpuPercent borne à 0 si les snapshots sont identiques ou invalides', () => {
  const a = parseStat('cpu  100 20 300 500');
  assert.equal(cpuPercent(a, a), 0);
  assert.equal(cpuPercent(null, a), 0);
  assert.equal(cpuPercent(a, null), 0);
});

test('parseMemInfo calcule usedPercent depuis MemTotal/MemAvailable', () => {
  const meminfo = 'MemTotal:       1000000 kB\nMemFree:         200000 kB\nMemAvailable:    300000 kB\nBuffers:          50000 kB\n';
  const m = parseMemInfo(meminfo);
  assert.equal(m.totalBytes, 1000000 * 1024);
  assert.equal(m.availableBytes, 300000 * 1024);
  assert.equal(m.usedBytes, 700000 * 1024);
  assert.equal(m.usedPercent, 70);
});

test('parseMemInfo retourne null sans MemAvailable (hôte non-Linux)', () => {
  assert.equal(parseMemInfo('MemTotal:       1000000 kB\n'), null);
  assert.equal(parseMemInfo(''), null);
});
