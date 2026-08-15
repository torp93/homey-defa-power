'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  DEV_TOKENS,
  DEFAULT_DEV_TOKEN,
  SETTING_USER_ID,
  SETTING_TOKEN,
  SETTING_DEV_TOKEN,
  normalizePhoneNumber,
  isValidPhoneNumber,
  normalizeSmsCode,
  isValidSmsCode,
  isValidUserId,
  isValidToken,
  resolveSession,
  maskSecret,
} = require('../lib/cloudcharge-config');

const settingsFrom = (values) => ({ get: (key) => values[key] });

const VALID_USER_ID = '00000000-0000-4000-8000-000000000000';
const VALID_TOKEN = 'exampletoken0123456789xyz';

test('the default devToken is the DEFA Power app', () => {
  // Bare denne får SMS-koden faktisk levert. CloudCharge-tokenet oppretter en
  // gyldig loginAttempt, men meldingen kommer aldri fram.
  assert.strictEqual(DEFAULT_DEV_TOKEN, DEV_TOKENS.defa_power);
});

test('normalizePhoneNumber strips everything but digits', () => {
  assert.strictEqual(normalizePhoneNumber('+47 900 00000'), '4790000000');
  assert.strictEqual(normalizePhoneNumber('4790000000'), '4790000000');
  assert.strictEqual(normalizePhoneNumber('(47) 90-00-00-00'), '4790000000');
});

test('normalizePhoneNumber adds the country code to Norwegian mobile numbers', () => {
  assert.strictEqual(normalizePhoneNumber('90000000'), '4790000000');
  assert.strictEqual(normalizePhoneNumber('40000000'), '4740000000');
});

test('normalizePhoneNumber leaves other lengths alone', () => {
  // Et svensk nummer skal ikke få 47 foran seg.
  assert.strictEqual(normalizePhoneNumber('46701234567'), '46701234567');
  assert.strictEqual(normalizePhoneNumber('22334455'), '22334455');
});

test('isValidPhoneNumber rejects obvious nonsense', () => {
  assert.ok(isValidPhoneNumber('+47 900 00000'));
  assert.ok(!isValidPhoneNumber('1234'));
  assert.ok(!isValidPhoneNumber(''));
  assert.ok(!isValidPhoneNumber(null));
});

test('normalizeSmsCode ignores the Android SMS Retriever hash', () => {
  // SMS-en er «123456 er bekreftelseskoden din for å logge på DEFA Power.
  // AbCdEfGhIjK» — limer brukeren inn alt, skal vi fortsatt finne koden.
  assert.strictEqual(normalizeSmsCode('123456'), '123456');
  assert.strictEqual(normalizeSmsCode(' 123456 '), '123456');
  assert.ok(isValidSmsCode('123456'));
  assert.ok(!isValidSmsCode('abc'));
  assert.ok(!isValidSmsCode(''));
});

test('isValidUserId and isValidToken accept the real session shapes', () => {
  assert.ok(isValidUserId(VALID_USER_ID));
  assert.ok(isValidToken(VALID_TOKEN));
  assert.ok(!isValidUserId('nope'));
  assert.ok(!isValidToken('short'));
  assert.ok(!isValidToken(null));
});

test('resolveSession reports no session before pairing', () => {
  const session = resolveSession(undefined);
  assert.strictEqual(session.userId, null);
  assert.strictEqual(session.token, null);
  assert.strictEqual(session.source, 'none');
  assert.strictEqual(session.devToken, DEFAULT_DEV_TOKEN);
});

test('resolveSession reads a stored session', () => {
  const session = resolveSession(settingsFrom({
    [SETTING_USER_ID]: VALID_USER_ID,
    [SETTING_TOKEN]: VALID_TOKEN,
  }));

  assert.strictEqual(session.userId, VALID_USER_ID);
  assert.strictEqual(session.token, VALID_TOKEN);
  assert.strictEqual(session.source, 'settings');
});

test('resolveSession ignores a half-written session', () => {
  // Uten begge deler er headerne ubrukelige, så vi later som ingenting finnes.
  const session = resolveSession(settingsFrom({ [SETTING_USER_ID]: VALID_USER_ID }));
  assert.strictEqual(session.source, 'none');
  assert.strictEqual(session.token, null);
});

test('resolveSession accepts an overridden devToken', () => {
  const session = resolveSession(settingsFrom({
    [SETTING_DEV_TOKEN]: DEV_TOKENS.cloud_charge,
  }));
  assert.strictEqual(session.devToken, DEV_TOKENS.cloud_charge);
});

test('maskSecret never returns the whole token', () => {
  const masked = maskSecret(VALID_TOKEN);
  assert.ok(!masked.includes(VALID_TOKEN));
  assert.ok(masked.startsWith(VALID_TOKEN.slice(0, 4)));
  assert.strictEqual(maskSecret(''), '');
  assert.strictEqual(maskSecret('abcd'), '****');
});
