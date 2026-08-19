import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactSecrets, signSession, buildSessionCookie, parseSession,
  escapeEnvValue, parseEnv, applyEnvUpdates, clampInt,
  CONTAINER_NAME_RE, ALLOWED_ACTIONS
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
    redactSecrets('API_KEY="test-key-1234567890"'),
    'API_KEY="***"'
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
