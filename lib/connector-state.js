'use strict';

// Oversetter CloudCharge sitt /operationaldata til Homey-kapabiliteter.
// Rent regnestykke uten Homey-avhengigheter, slik at det kan testes med
// `node --test`.

// powerConsumption er kW hos CloudCharge; Homeys measure_power er W.
const KW_TO_W = 1000;

const STATUS_VALUES = [
  'available',
  'occupied',
  'preparing',
  'charging',
  'suspended_ev',
  'suspended_evse',
  'finishing',
  'faulted',
  'unavailable',
  'reserved',
  'restarting',
  'facility_finishing',
  'idle',
  'ev_connected',
  'unknown',
];

const CHARGING_STATE_MAP = {
  EVConnected: 'ev_connected',
  Charging: 'charging',
  SuspendedEV: 'suspended_ev',
  SuspendedEVSE: 'suspended_evse',
  Idle: 'idle',
  UNRECOGNIZED: 'unrecognized',
};

const CHARGING_STATE_VALUES = [
  'idle',
  'ev_connected',
  'charging',
  'suspended_ev',
  'suspended_evse',
  'unrecognized',
];

// Bilen står i, men lader ikke akkurat nå.
const PLUGGED_IN_STATES = new Set([
  'ev_connected',
]);

// Lading er satt på pause — av bilen selv, eller av laderen/smartlading.
// Homey har en egen tilstand for dette, som er mer presis enn «tilkoblet».
const PAUSED_STATES = new Set([
  'suspended_ev',
  'suspended_evse',
]);

const PAUSED_STATUSES = new Set([
  'suspended_ev',
  'suspended_evse',
]);

const PLUGGED_IN_STATUSES = new Set([
  'preparing',
  'occupied',
  'finishing',
  'ev_connected',
  'suspended_ev',
  'suspended_evse',
]);

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeStatus(raw) {
  if (!raw) return 'unknown';
  const value = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_VALUES.includes(value) ? value : 'unknown';
}

// chargingState er null når ingenting står tilkoblet.
function normalizeChargingState(raw) {
  if (!raw) return 'idle';
  const mapped = CHARGING_STATE_MAP[raw];
  if (mapped) return mapped;

  const value = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CHARGING_STATE_VALUES.includes(value) ? value : 'unrecognized';
}

// Homeys evcharger_charging_state har fire faste verdier. Vi har mer detalj enn
// det, så flere CloudCharge-tilstander kollapser til plugged_in.
function toEvChargerState(chargingState, status) {
  if (chargingState === 'charging' || status === 'charging') return 'plugged_in_charging';
  if (PAUSED_STATES.has(chargingState) || PAUSED_STATUSES.has(status)) return 'plugged_in_paused';
  if (PLUGGED_IN_STATES.has(chargingState)) return 'plugged_in';
  if (PLUGGED_IN_STATUSES.has(status)) return 'plugged_in';
  return 'plugged_out';
}

// Et brukbart /operationaldata-svar er alltid et objekt. Klienten returnerer
// null når kroppen er tom, og råteksten når 200-svaret ikke er JSON — for
// eksempel en HTML-feilside fra en lastbalanserer. Begge er reelle: uten denne
// vakten oversatte toCapabilityValues() dem til «frakoblet, 0 W, ingen feil»,
// og midt i en ladeøkt fyrte det «lading stoppet», «bil koblet fra», «status
// endret» og «feilen er borte» — samtidig som en ekte feilkode ble borte.
// Manglende data skal bli en lesefeil med backoff, ikke en falsk trygg tilstand.
function isOperationalData(payload) {
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload);
}

function toCapabilityValues(data) {
  const source = data && typeof data === 'object' ? data : {};
  const ocpp = source.ocpp && typeof source.ocpp === 'object' ? source.ocpp : {};

  const status = normalizeStatus(ocpp.status);
  const chargingState = normalizeChargingState(ocpp.chargingState);
  const powerKw = toNumber(source.powerConsumption);
  const evChargerState = toEvChargerState(chargingState, status);

  return {
    measure_power: powerKw === null ? null : Math.round(powerKw * KW_TO_W),
    meter_power: toNumber(source.meterValue),
    defa_session_energy: toNumber(source.transactionMeterValue),
    defa_status: status,
    defa_charging_state: chargingState,
    // Mangler feltet helt, vet vi ingenting — og «vet ingenting» er ikke det
    // samme som «ingen feil». null skrives ikke til kapabiliteten, så den siste
    // kjente verdien står, og detectTransitions fyrer ikke «feilen er borte».
    defa_error_code: typeof source.errorCode === 'string'
      ? (source.errorCode || 'NoError')
      : null,
    evcharger_charging: evChargerState === 'plugged_in_charging',
    evcharger_charging_state: evChargerState,
  };
}

const isCharging = (values) => Boolean(values && values.evcharger_charging);

const isPluggedIn = (values) => Boolean(values)
  && values.evcharger_charging_state !== 'plugged_out';

const hasError = (values) => Boolean(values)
  && typeof values.defa_error_code === 'string'
  && values.defa_error_code !== 'NoError';

// Plukker ut ladepunktene fra /mychargers.
//
// Strukturen er nestet og har to identifikatorer som er lette å blande:
//   - nøkkelen i aliasMap er `alias`, som /charging/start og /charging/stop vil ha
//   - connector.id er det som går i /connector/{id}/…
// Kontoen på testmaskinen har laderen under `receivingAccess`, men vi vet ikke
// at det er den eneste plasseringen — en bruker meldte «kontoen har ingen
// ladere» på en konto som beviselig har en. Derfor: gå gjennom alle
// toppnivålister med objekter som har en `chargePoint`, i stedet for å låse
// oss til nøkkelnavn vi bare har sett ett eksempel på. Uttrekket under er
// uendret; det er kun letingen som er bredere.
function pickConnectors(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const lists = Array.isArray(source) ? [source] : Object.values(source).filter(Array.isArray);
  const entries = [];

  for (const list of lists) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;

      // Samme ladepunkt kommer i tre innpakninger avhengig av endepunkt:
      //   /mychargers      → { chargePoint: {...} }  (receivingAccess/givingAccess)
      //   /chargers/private → { data: {...} }        (bekreftet i modellen til
      //                                               ha-defa-power)
      // og noen svar kan tenkes å gi ladepunktet rett ut. Det som identifiserer
      // et ladepunkt er aliasMap-en, ikke hvilken nøkkel det ligger under.
      const point = [item.chargePoint, item.data, item]
        .find((candidate) => candidate
          && typeof candidate === 'object'
          && candidate.aliasMap
          && typeof candidate.aliasMap === 'object');

      if (point) entries.push({ chargePoint: point });
    }
  }

  const seen = new Set();
  const connectors = [];

  for (const entry of entries) {
    const chargePoint = entry && entry.chargePoint;
    if (!chargePoint || typeof chargePoint !== 'object') continue;

    const aliasMap = chargePoint.aliasMap && typeof chargePoint.aliasMap === 'object'
      ? chargePoint.aliasMap
      : {};

    for (const [alias, connector] of Object.entries(aliasMap)) {
      if (!connector || typeof connector !== 'object' || !connector.id) continue;
      if (seen.has(connector.id)) continue;
      seen.add(connector.id);

      connectors.push({
        id: connector.id,
        alias,
        chargePointId: chargePoint.id || null,
        name: connector.displayName
          || connector.nickname
          || chargePoint.displayName
          || chargePoint.locationDescription
          || alias,
        vendor: connector.vendor || null,
        model: connector.model || null,
        serialNumber: connector.serialNumber || null,
        firmwareVersion: connector.firmwareVersion || null,
        connectorType: connector.connectorType || null,
        maxPowerKw: toNumber(connector.power),
        capabilities: connector.capabilities && typeof connector.capabilities === 'object'
          ? connector.capabilities
          : {},
      });
    }
  }

  return connectors;
}

// Laderoppdagelse går mot to endepunkter — /mychargers og /chargers/private —
// og et ladepunkt kan ligge i det ene uten å ligge i det andre. Sammenslåingen
// bor her, slik at paringen og «test tilkoblingen» på innstillingssiden bruker
// nøyaktig samme oppdagelse. Da de hadde hver sin kopi, fant paringen laderen
// mens innstillingssiden fortsatt meldte «kontoen har ingen ladere».
function pickConnectorsFrom(...payloads) {
  const seen = new Set();

  return payloads
    .flatMap((payload) => pickConnectors(payload))
    .filter((connector) => {
      if (seen.has(connector.id)) return false;
      seen.add(connector.id);
      return true;
    });
}


// --- Skybasert ladestrøm --------------------------------------------------
//
// Noen ladere kan sette ladestrøm gjennom CloudCharge i stedet for gjennom
// laderens lokale konfigurator. Da slipper brukeren IP-adresse og PIN helt.
// Om laderen støtter det, ser man på capabilities.maxPower i /mychargers, og
// endelig ved at /maxcurrent/alternatives ikke svarer CAPABILITY_NOT_FOUND.

// Svaret er { "16": 11.0, "20": 13.8, … } — ampere som nøkkel, kW som verdi.
function currentAlternatives(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const amps = Object.keys(payload)
    .map((key) => Number(key))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (amps.length === 0) return null;
  return { min: amps[0], max: amps[amps.length - 1], values: amps };
}

// Gjeldende ladestrøm ligger på selve ladepunktet som maxProfileCurrent, ikke
// i /operationaldata. Ladepunktet hentes med /chargepoints/get.
function currentFromChargePoint(payload, connectorId) {
  const points = pickChargePoints(payload);

  for (const point of points) {
    const aliasMap = point.aliasMap && typeof point.aliasMap === 'object' ? point.aliasMap : {};
    for (const connector of Object.values(aliasMap)) {
      if (!connector || connector.id !== connectorId) continue;
      return toNumber(connector.maxProfileCurrent);
    }
  }

  return null;
}

// /chargepoints/get svarer med ladepunktet direkte, mens listeendepunktene
// pakker det inn. Begge formene må kunne leses.
function pickChargePoints(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.aliasMap) return [payload];
  if (payload.data && payload.data.aliasMap) return [payload.data];
  if (payload.chargePoint && payload.chargePoint.aliasMap) return [payload.chargePoint];

  return Object.values(payload)
    .filter(Array.isArray)
    .flat()
    .map((item) => (item && typeof item === 'object'
      ? (item.chargePoint || item.data || item)
      : null))
    .filter((point) => point && point.aliasMap);
}

module.exports = {
  KW_TO_W,
  STATUS_VALUES,
  CHARGING_STATE_VALUES,
  CHARGING_STATE_MAP,
  toNumber,
  normalizeStatus,
  normalizeChargingState,
  toEvChargerState,
  isOperationalData,
  toCapabilityValues,
  isCharging,
  isPluggedIn,
  hasError,
  pickConnectors,
  pickConnectorsFrom,
  currentAlternatives,
  currentFromChargePoint,
};
