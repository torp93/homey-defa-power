'use strict';

// Hvor CloudCharge finnes, og hvilken app vi utgir oss for å være.
//
// env.json leveres ikke på Homey Pro (kommer stille tomt via `app run --remote`),
// så sesjonen bor i appinnstillingene med konstantene her i lib/ som fallback.

const API_BASE_URL = 'https://prod.cloudcharge.se/services/user';

// devToken forteller CloudCharge hvilken app den tror den snakker med. API-et
// tillater én aktiv sesjon per app, så en innlogging herfra logger deg ut av
// den tilsvarende mobilappen.
//
// Bare DEFA Power-tokenet får SMS-koden faktisk levert. CloudCharge-tokenet
// svarer 200 OK på /prelogin og oppretter en gyldig loginAttempt — /login med
// feil kode svarer da «Invalid login credentials.» i stedet for «No
// loginAttempts found» — men SMS-en kommer aldri fram. Verifisert 2026-08-09.
const DEV_TOKENS = {
  defa_power: 'XqP3sCFKdg4vrV8J',
  cloud_charge: 'X5zVn6MCWvrf6ft2',
};

const DEFAULT_DEV_TOKEN = DEV_TOKENS.defa_power;

const SETTING_USER_ID = 'cloudChargeUserId';
const SETTING_TOKEN = 'cloudChargeToken';
const SETTING_DEV_TOKEN = 'cloudChargeDevToken';

// CloudCharge rate-limiter per token. Med under ~1 s mellom kall begynner
// forespørsler å time ut.
const MIN_REQUEST_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

// CloudCharge vil ha bare siffer. Norske åttesifrede mobilnumre får landkode,
// slik at «907 03534» og «+47 907 03534» havner samme sted.
function normalizePhoneNumber(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (digits.length === 8 && /^[49]/.test(digits)) return `47${digits}`;
  return digits;
}

function isValidPhoneNumber(value) {
  const digits = normalizePhoneNumber(value);
  return digits.length >= 8 && digits.length <= 15;
}

// Koden i SMS-en er sekssifret. Android-appens SMS Retriever-hash henger bak i
// meldingen, så vi plukker ut sifrene og ignorerer resten.
function normalizeSmsCode(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

const isValidSmsCode = (value) => /^\d{4,8}$/.test(normalizeSmsCode(value));

const isValidUserId = (value) => isNonEmptyString(value)
  && /^[a-f0-9-]{16,64}$/i.test(value.trim());

const isValidToken = (value) => isNonEmptyString(value)
  && /^[a-z0-9]{8,128}$/i.test(value.trim());

const isValidDevToken = (value) => isNonEmptyString(value)
  && /^[a-z0-9]{8,64}$/i.test(value.trim());

// settings er en Homey ManagerSettings eller et hvilket som helst objekt med get().
function resolveSession(settings) {
  let userId = null;
  let token = null;
  let devToken = DEFAULT_DEV_TOKEN;
  let source = 'none';

  if (settings && typeof settings.get === 'function') {
    const storedUserId = settings.get(SETTING_USER_ID);
    const storedToken = settings.get(SETTING_TOKEN);

    if (isValidUserId(storedUserId) && isValidToken(storedToken)) {
      userId = storedUserId.trim();
      token = storedToken.trim();
      source = 'settings';
    }

    const storedDevToken = settings.get(SETTING_DEV_TOKEN);
    if (isValidDevToken(storedDevToken)) devToken = storedDevToken.trim();
  }

  return { userId, token, devToken, source };
}

// Til logging og innstillingssiden — aldri hele token-et.
function maskSecret(value) {
  if (!isNonEmptyString(value)) return '';
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '*'.repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

module.exports = {
  API_BASE_URL,
  DEV_TOKENS,
  DEFAULT_DEV_TOKEN,
  SETTING_USER_ID,
  SETTING_TOKEN,
  SETTING_DEV_TOKEN,
  MIN_REQUEST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  normalizePhoneNumber,
  isValidPhoneNumber,
  normalizeSmsCode,
  isValidSmsCode,
  isValidUserId,
  isValidToken,
  isValidDevToken,
  resolveSession,
  maskSecret,
};
