'use strict';

// Regnestykket rundt ladestrøm på den lokale CLU-en.
//
// Grensene er hentet fra konfiguratorens eget skjema (assets/settings.json i
// CLU-ens webapp):
//   maxTotalChargeCurrent : heltall, min 7, lessOrEqual homeFuseSize
//   connectors[].maxCurrent : heltall, 6–32
//
// Effektiv ladestrøm er den laveste av de to, så knappen i Homey begrenses av
// begge. Rene funksjoner, ingen Homey- eller nettverksavhengigheter.

const TOTAL_MIN_AMPS = 7;
const CONNECTOR_MIN_AMPS = 6;
const CONNECTOR_MAX_AMPS = 32;

// Feltene som må finnes før vi tør skrive konfigurasjonen tilbake. Mangler noe
// av dette, har vi ikke lest en gyldig konfigurasjon, og en skriving ville
// kunne ødelegge installasjonsparametere.
const REQUIRED_KEYS = [
  'distNetType',
  'chargePointType',
  'homeFuseSize',
  'connector1Phase',
  'connectors',
];

class CluConfigError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'CluConfigError';
    this.code = code;
  }
}

// "63A" -> 63
function parseFuseSize(value) {
  const match = /^(\d+)/.exec(String(value == null ? '' : value).trim());
  return match ? Number(match[1]) : null;
}

function toAmps(value) {
  const text = String(value == null ? '' : value).trim();
  // Number('') er 0, og en tom verdi må ikke bli til 0 A.
  if (!text) return null;

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function isUsableConfig(config) {
  if (!config || typeof config !== 'object') return false;
  if (!Array.isArray(config.connectors) || config.connectors.length === 0) return false;
  return REQUIRED_KEYS.every((key) => config[key] !== undefined && config[key] !== null);
}

// Hva Homey-brukeren faktisk kan velge mellom.
function resolveCurrentLimits(config) {
  const fuse = parseFuseSize(config && config.homeFuseSize);

  const connectorMax = (Array.isArray(config && config.connectors) ? config.connectors : [])
    .map((connector) => toAmps(connector && connector.maxCurrent))
    .filter((amps) => amps !== null)
    .reduce((lowest, amps) => (lowest === null ? amps : Math.min(lowest, amps)), null);

  const ceilings = [fuse, connectorMax, CONNECTOR_MAX_AMPS].filter((value) => value !== null);
  const max = ceilings.length ? Math.min.apply(null, ceilings) : CONNECTOR_MAX_AMPS;

  return {
    min: TOTAL_MIN_AMPS,
    max: Math.max(TOTAL_MIN_AMPS, max),
    fuse,
    connectorMax,
  };
}

function currentFromConfig(config) {
  return toAmps(config && config.maxTotalChargeCurrent);
}

function assertUsable(config) {
  if (!isUsableConfig(config)) {
    throw new CluConfigError(
      'Leste ikke en fullstendig CLU-konfigurasjon — skriver ingenting',
      'incomplete_config',
    );
  }
}

// Ladepunktet finnes ved `address`. Med bare ett ladepunkt er valget opplagt;
// med flere nekter vi heller enn å gjette på hvilket som er ditt.
function resolveConnectorIndex(config, address) {
  const connectors = config.connectors;
  if (connectors.length === 1) return 0;

  if (address === null || address === undefined || address === '') {
    throw new CluConfigError(
      'Laderen har flere ladepunkter, og vi vet ikke hvilket som hører til enheten',
      'ambiguous_connector',
    );
  }

  const index = connectors.findIndex((c) => Number(c.address) === Number(address));
  if (index < 0) {
    throw new CluConfigError(`Fant ikke ladepunkt med address ${address}`, 'connector_not_found');
  }

  return index;
}

// Plug & Charge: lading er gratis og kan startes uten autorisasjon. Settes per
// ladepunkt.
function applyPlugAndCharge(config, address, enabled) {
  assertUsable(config);
  const index = resolveConnectorIndex(config, address);

  return {
    ...config,
    connectors: config.connectors.map((connector, i) =>
      (i === index ? { ...connector, isFree: Boolean(enabled) } : connector)),
  };
}

// Slår på Plug & Charge automatisk hvis internettforbindelsen faller bort.
function applyChargeOffline(config, enabled) {
  assertUsable(config);
  return { ...config, chargeOffline: Boolean(enabled) };
}

function plugAndChargeFromConfig(config, address) {
  if (!isUsableConfig(config)) return null;
  try {
    return Boolean(config.connectors[resolveConnectorIndex(config, address)].isFree);
  } catch (error) {
    return null;
  }
}

const chargeOfflineFromConfig = (config) =>
  (config && typeof config.chargeOffline === 'boolean' ? config.chargeOffline : null);

// Bygger konfigurasjonen som skal sendes tilbake. Alt annet enn
// maxTotalChargeCurrent kopieres uendret fra det vi nettopp leste — vi skal
// aldri finne på verdier for nettype, sikringsstørrelse eller fasekobling.
function applyCurrent(config, amps) {
  assertUsable(config);

  const requested = toAmps(amps);
  if (requested === null || !Number.isInteger(requested)) {
    throw new CluConfigError(`Ladestrøm må være et heltall, fikk ${amps}`, 'not_integer');
  }

  const limits = resolveCurrentLimits(config);
  if (requested < limits.min || requested > limits.max) {
    throw new CluConfigError(
      `Ladestrøm må være mellom ${limits.min} og ${limits.max} A, fikk ${requested}`,
      'out_of_range',
    );
  }

  // Konfiguratoren sender tallet som number, ikke streng.
  return { ...config, maxTotalChargeCurrent: requested };
}

// Sikkerhetsnett: nekter å skrive hvis installasjonsparameterne har endret seg
// siden enheten ble paret. Da er det noe vi ikke forstår, og en skriving kan
// gjøre skade.
function assertMatchesExpected(config, expected) {
  if (!expected) return;

  const mismatches = ['distNetType', 'chargePointType', 'homeFuseSize', 'connector1Phase']
    .filter((key) => expected[key] && String(expected[key]) !== String(config[key]))
    .map((key) => `${key}: forventet ${expected[key]}, fant ${config[key]}`);

  if (mismatches.length) {
    throw new CluConfigError(
      `CLU-konfigurasjonen har endret seg siden paring — skriver ingenting.\n${mismatches.join('\n')}`,
      'config_changed',
    );
  }
}

module.exports = {
  TOTAL_MIN_AMPS,
  CONNECTOR_MIN_AMPS,
  CONNECTOR_MAX_AMPS,
  REQUIRED_KEYS,
  CluConfigError,
  parseFuseSize,
  toAmps,
  isUsableConfig,
  assertUsable,
  resolveConnectorIndex,
  resolveCurrentLimits,
  currentFromConfig,
  plugAndChargeFromConfig,
  chargeOfflineFromConfig,
  applyCurrent,
  applyPlugAndCharge,
  applyChargeOffline,
  assertMatchesExpected,
};
