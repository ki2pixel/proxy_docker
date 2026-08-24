import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_KEYS, isSensitiveKey, isKnownConfigKey,
  configSnapshot, validateConfigUpdates
} from '../lib.js';

// -----------------------------------------------------------------------------
// Sensibilité des clés
// -----------------------------------------------------------------------------
test('les clés de mot de passe/API sont sensibles', () => {
  assert.ok(isSensitiveKey('ISP_PROXY_PASS'));
  assert.ok(isSensitiveKey('HONEYGAIN_PASSWORD'));
  assert.ok(isSensitiveKey('HONEYGAIN_POT_PASSWORD'));
  assert.ok(isSensitiveKey('PAWNS_PASSWORD'));
  assert.ok(isSensitiveKey('REPOCKET_API_KEY'));
  assert.ok(isSensitiveKey('ANTGAIN_API_KEY'));
});

test('les clés préfixées GW{n}_ sont sensibles quand secrètes', () => {
  assert.ok(isSensitiveKey('GW1_ISP_PROXY_PASS'));
  assert.ok(isSensitiveKey('GW2_HONEYGAIN_PASSWORD'));
  assert.ok(isSensitiveKey('GW3_PAWNS_PASSWORD'));
  assert.ok(isSensitiveKey('GW4_REPOCKET_API_KEY'));
  assert.ok(!isSensitiveKey('GW1_ISP_PROXY_HOST'));
  assert.ok(!isSensitiveKey('GW2_HONEYGAIN_EMAIL'));
  assert.ok(!isSensitiveKey('GW1_ANTGAIN_DEVICE_ID'));
});

test('le schéma CONFIG_KEYS couvre les 4 passerelles et le global', () => {
  for (const n of [1, 2, 3, 4]) {
    assert.ok(isKnownConfigKey(`GW${n}_ISP_PROXY_HOST`), `GW${n}_ISP_PROXY_HOST manquante`);
    assert.ok(isKnownConfigKey(`GW${n}_PAWNS_EMAIL`), `GW${n}_PAWNS_EMAIL manquante`);
    assert.ok(isKnownConfigKey(`GW${n}_REPOCKET_API_KEY`), `GW${n}_REPOCKET_API_KEY manquante`);
    assert.ok(isKnownConfigKey(`GW${n}_ANTGAIN_DEVICE_ID`), `GW${n}_ANTGAIN_DEVICE_ID manquante`);
  }
  assert.ok(isKnownConfigKey('ENABLED_GATEWAYS'));
  assert.ok(isKnownConfigKey('GATEWAY_LOGLEVEL'));
  assert.ok(isKnownConfigKey('ANTGAIN_API_KEY'));
  assert.ok(isKnownConfigKey('HONEYGAIN_POT_EMAIL'));
  assert.ok(isKnownConfigKey('HONEYGAIN_POT_PASSWORD'));
  // Légacy conservé pour la migration
  assert.ok(isKnownConfigKey('ISP_PROXY_HOST'));
  assert.ok(isKnownConfigKey('PAWNS_EMAIL'));
  assert.ok(isKnownConfigKey('ANTGAIN_DEVICE_ID'));
});

test('les clés non secrètes ne sont pas sensibles', () => {
  assert.ok(!isSensitiveKey('ISP_PROXY_HOST'));
  assert.ok(!isSensitiveKey('ISP_PROXY_PORT'));
  assert.ok(!isSensitiveKey('HONEYGAIN_EMAIL'));
  assert.ok(!isSensitiveKey('COMPOSE_PROFILES'));
  assert.ok(!isSensitiveKey('DEVICE_NAME'));
  assert.ok(!isSensitiveKey('ANTGAIN_DEVICE_ID'));
});

test('toutes les clés de CONFIG_KEYS sont connues', () => {
  for (const meta of CONFIG_KEYS) {
    assert.ok(isKnownConfigKey(meta.key), `clé manquante : ${meta.key}`);
  }
});

test('les clés inconnues sont refusées', () => {
  assert.ok(!isKnownConfigKey('INJECTION'));
  assert.ok(!isKnownConfigKey('PATH'));
  assert.ok(!isKnownConfigKey(''));
});

// -----------------------------------------------------------------------------
// configSnapshot : ne JAMAIS exposer les valeurs sensibles
// -----------------------------------------------------------------------------
test('configSnapshot masque les valeurs sensibles', () => {
  const env = {
    ISP_PROXY_HOST: 'proxy.example.com',
    ISP_PROXY_PORT: '1080',
    ISP_PROXY_PASS: 'motdepasse-secret',
    ANTGAIN_API_KEY: 'jeton-secret',
    HONEYGAIN_EMAIL: 'user@example.com'
  };
  const snap = configSnapshot(env);
  const pass = snap.find(s => s.key === 'ISP_PROXY_PASS');
  const api = snap.find(s => s.key === 'ANTGAIN_API_KEY');
  assert.equal(pass.value, null);
  assert.equal(pass.hasValue, true);
  assert.equal(api.value, null);
  assert.equal(api.hasValue, true);
});

test('configSnapshot expose les valeurs non sensibles', () => {
  const env = { ISP_PROXY_HOST: 'proxy.example.com', HONEYGAIN_EMAIL: 'a@b.c' };
  const snap = configSnapshot(env);
  const host = snap.find(s => s.key === 'ISP_PROXY_HOST');
  const email = snap.find(s => s.key === 'HONEYGAIN_EMAIL');
  assert.equal(host.value, 'proxy.example.com');
  assert.equal(email.value, 'a@b.c');
});

test('configSnapshot signale hasValue=false pour les clés absentes', () => {
  const snap = configSnapshot({});
  const pass = snap.find(s => s.key === 'ISP_PROXY_PASS');
  assert.equal(pass.hasValue, false);
  assert.equal(pass.value, null);
});

// -----------------------------------------------------------------------------
// validateConfigUpdates
// -----------------------------------------------------------------------------
test('validateConfigUpdates accepte les clés connues non sensibles', () => {
  const { errors, clean } = validateConfigUpdates({ ISP_PROXY_HOST: 'new.example.com' });
  assert.deepEqual(errors, []);
  assert.deepEqual(clean, { ISP_PROXY_HOST: 'new.example.com' });
});

test('validateConfigUpdates refuse les clés inconnues', () => {
  const { errors } = validateConfigUpdates({ INJECTION: 'x' });
  assert.ok(errors.length > 0);
  assert.match(errors[0], /Clé inconnue/);
});

test('validateConfigUpdates refuse les valeurs avec saut de ligne', () => {
  const { errors } = validateConfigUpdates({ ISP_PROXY_HOST: 'a\nb' });
  assert.ok(errors.length > 0);
  assert.match(errors[0], /saut de ligne/);
});

test('validateConfigUpdates ignore les valeurs null/vides (inchangé)', () => {
  const { errors, clean } = validateConfigUpdates({
    ISP_PROXY_HOST: null,
    ISP_PROXY_PASS: '',
    HONEYGAIN_PASSWORD: undefined
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(clean, {});
});

test('validateConfigUpdates accepte les clés sensibles avec valeur', () => {
  const { errors, clean } = validateConfigUpdates({ ISP_PROXY_PASS: 'nouveau-mdp' });
  assert.deepEqual(errors, []);
  assert.deepEqual(clean, { ISP_PROXY_PASS: 'nouveau-mdp' });
});

test('validateConfigUpdates refuse les valeurs non string', () => {
  const { errors } = validateConfigUpdates({ ISP_PROXY_PORT: 12345 });
  assert.ok(errors.length > 0);
});
