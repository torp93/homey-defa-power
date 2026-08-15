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

// Tilstander der bilen står i, men ikke trekker strøm.
const PLUGGED_IN_STATES = new Set([
  'ev_connected',
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
  if (PLUGGED_IN_STATES.has(chargingState)) return 'plugged_in';
  if (PLUGGED_IN_STATUSES.has(status)) return 'plugged_in';
  return 'plugged_out';
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
    defa_error_code: typeof source.errorCode === 'string' && source.errorCode
      ? source.errorCode
      : 'NoError',
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
function pickConnectors(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const entries = [
    ...(Array.isArray(source.receivingAccess) ? source.receivingAccess : []),
    ...(Array.isArray(source.givingAccess) ? source.givingAccess : []),
  ];

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

module.exports = {
  KW_TO_W,
  STATUS_VALUES,
  CHARGING_STATE_VALUES,
  CHARGING_STATE_MAP,
  toNumber,
  normalizeStatus,
  normalizeChargingState,
  toEvChargerState,
  toCapabilityValues,
  isCharging,
  isPluggedIn,
  hasError,
  pickConnectors,
};
