'use strict';

// Regnestykket rundt ladestrøm på den lokale CLU-en.
//
// Grensene er hentet fra konfiguratorens eget skjema (assets/settings.json i
// CLU-ens webapp):
//   maxTotalChargeCurrent : heltall, min 7, lessOrEqual homeFuseSize
//   connectors[].maxCurrent : heltall, 6–32
//
// Effektiv ladestrøm er den laveste av de to. Det er også nøkkelen til å komme
// under 7 A: totalfeltet nekter det, men connector-feltet går til 6, og den
// laveste vinner. En bruker med solceller ba om nettopp 6 A.
//
// VIKTIG: connector-feltet kan være satt bevisst av montøren etter
// kabeltverrsnitt. Vi senker det, men hever det aldri over verdien det hadde
// da enheten ble paret — se `connectorCeiling`.
//
// Rene funksjoner, ingen Homey- eller nettverksavhengigheter.

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

// Laveste connector-maxCurrent i konfigurasjonen akkurat nå.
function connectorMaxFromConfig(config) {
  return (Array.isArray(config && config.connectors) ? config.connectors : [])
    .map((connector) => toAmps(connector && connector.maxCurrent))
    .filter((amps) => amps !== null)
    .reduce((lowest, amps) => (lowest === null ? amps : Math.min(lowest, amps)), null);
}

// Taket vi aldri går over. `ceiling` er verdien connector-feltet hadde da
// enheten ble paret, lagret av enheten. Uten den faller vi tilbake på det som
// står nå — men da har vi heller aldri senket den.
function connectorCeiling(config, ceiling) {
  const lagret = toAmps(ceiling);
  return lagret === null ? connectorMaxFromConfig(config) : lagret;
}

// Hva Homey-brukeren faktisk kan velge mellom.
function resolveCurrentLimits(config, ceiling) {
  const fuse = parseFuseSize(config && config.homeFuseSize);
  const connectorMax = connectorCeiling(config, ceiling);

  const ceilings = [fuse, connectorMax, CONNECTOR_MAX_AMPS].filter((value) => value !== null);
  const max = ceilings.length ? Math.min.apply(null, ceilings) : CONNECTOR_MAX_AMPS;

  // 6 tilbys bare når vi VET hva connector-feltet sto på opprinnelig. Uten det
  // taket ville en 6 A-skriving vært en enveisdør: neste avlesning leste 6 som
  // det nye taket, og brukeren kom aldri opp igjen.
  const min = toAmps(ceiling) === null ? TOTAL_MIN_AMPS : CONNECTOR_MIN_AMPS;

  return {
    min,
    max: Math.max(min, max),
    fuse,
    connectorMax,
  };
}

// Effektiv ladestrøm: den laveste av totalfeltet og connector-feltet. Leser vi
// bare totalfeltet, ville en lader som står på 6 A rapportert 7 eller mer.
function currentFromConfig(config) {
  const total = toAmps(config && config.maxTotalChargeCurrent);
  const connector = connectorMaxFromConfig(config);

  if (total === null) return connector;
  if (connector === null) return total;
  return Math.min(total, connector);
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
function applyCurrent(config, amps, ceiling) {
  assertUsable(config);

  const requested = toAmps(amps);
  if (requested === null || !Number.isInteger(requested)) {
    throw new CluConfigError(`Ladestrøm må være et heltall, fikk ${amps}`, 'not_integer');
  }

  const limits = resolveCurrentLimits(config, ceiling);
  if (requested < limits.min || requested > limits.max) {
    throw new CluConfigError(
      `Ladestrøm må være mellom ${limits.min} og ${limits.max} A, fikk ${requested}`,
      'out_of_range',
    );
  }

  // To felt, to roller:
  //   under 7 A — totalfeltet nekter, så connector-feltet settes ned i stedet
  //               og totalfeltet står urørt på sin egen lovlige verdi.
  //   7 A eller mer — totalfeltet settes, og connector-feltet settes tilbake til
  //               montørens opprinnelige tak. Uten det ville en tidligere
  //               6 A-skriving holdt strømmen nede for alltid.
  //
  // Connector-feltet heves aldri over taket. Står det 16 A fordi kabelen tåler
  // 16, skal ingen Homey-flow kunne gjøre den til 32.
  const tak = connectorCeiling(config, ceiling);
  const connectorVerdi = requested < TOTAL_MIN_AMPS
    ? requested
    : (tak === null ? null : Math.min(tak, CONNECTOR_MAX_AMPS));

  const next = { ...config };

  if (requested >= TOTAL_MIN_AMPS) next.maxTotalChargeCurrent = requested;

  // Røres kun når verdien faktisk er en annen. Ellers ville en skriving på
  // 16 A gjort montørens `"32"` om til `32` uten grunn — vi skal levere
  // konfigurasjonen tilbake så lik som mulig.
  if (connectorVerdi !== null) {
    next.connectors = config.connectors.map((connector) => {
      const naa = toAmps(connector && connector.maxCurrent);
      if (naa === null || naa === connectorVerdi) return connector;
      return { ...connector, maxCurrent: connectorVerdi };
    });
  }

  return next;
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
  connectorMaxFromConfig,
  connectorCeiling,
  currentFromConfig,
  plugAndChargeFromConfig,
  chargeOfflineFromConfig,
  applyCurrent,
  applyPlugAndCharge,
  applyChargeOffline,
  assertMatchesExpected,
};
