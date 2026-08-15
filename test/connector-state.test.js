'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeStatus,
  normalizeChargingState,
  toEvChargerState,
  toCapabilityValues,
  isCharging,
  isPluggedIn,
  hasError,
  pickConnectors,
} = require('../lib/connector-state');

// Faktisk svar fra /connector/{id}/operationaldata, 2026-08-09.
const IDLE_OPERATIONAL_DATA = {
  id: '11111111-1111-4111-8111-111111111111',
  ocpp: { chargingState: null, status: 'AVAILABLE', version: 'OCPP16' },
  errorCode: 'NoError',
  info: 'A',
  hbLastAlive: 'Sun Aug 09 07:51:25 GMT 2026',
  hbTimeout: false,
  meterValue: 7367.7,
  transactionMeterValue: 0.0,
  powerConsumption: 0.0,
  chargingBlocks: [],
};

// Faktisk svar fra /mychargers, forkortet til feltene appen bruker.
const MY_CHARGERS = {
  timestamp: 1786264586852,
  receivingAccess: [
    {
      chargePoint: {
        id: '00.00.00.0000.00000000.00.00.00.00.0000',
        locationDescription: 'Testveien 1',
        displayName: '',
        aliasMap: {
          '00.00.00.0000': {
            id: '11111111-1111-4111-8111-111111111111',
            connector: 1,
            smsAlias: '00.00.00.0000',
            displayName: null,
            nickname: null,
            power: 7.4,
            meterValue: 7367.7,
            connectorType: 'TYPE2_SOCKET',
            status: 'AVAILABLE',
            vendor: 'DEFA',
            model: 'homeCLU',
            serialNumber: '00.00.00.0000.00000000.00.00.00.00.0000',
            firmwareVersion: 'v3.4.0',
            capabilities: { ecoMode: true, maxPower: false, loadBalancing: false },
          },
        },
      },
      token: { role: 'OWNER' },
    },
  ],
  givingAccess: [],
};

test('normalizeStatus lowercases known OCPP statuses', () => {
  assert.strictEqual(normalizeStatus('AVAILABLE'), 'available');
  assert.strictEqual(normalizeStatus('SUSPENDED_EV'), 'suspended_ev');
  assert.strictEqual(normalizeStatus('Charging'), 'charging');
});

test('normalizeStatus falls back to unknown rather than inventing enum values', () => {
  // Homey avviser en enum-verdi som ikke står i app.json, så alt ukjent
  // må kollapse til unknown.
  assert.strictEqual(normalizeStatus('SOMETHING_NEW'), 'unknown');
  assert.strictEqual(normalizeStatus(null), 'unknown');
  assert.strictEqual(normalizeStatus(''), 'unknown');
});

test('normalizeChargingState treats a missing state as idle', () => {
  // chargingState er null når ingenting står tilkoblet.
  assert.strictEqual(normalizeChargingState(null), 'idle');
  assert.strictEqual(normalizeChargingState(undefined), 'idle');
});

test('normalizeChargingState maps the CloudCharge spellings', () => {
  assert.strictEqual(normalizeChargingState('EVConnected'), 'ev_connected');
  assert.strictEqual(normalizeChargingState('Charging'), 'charging');
  assert.strictEqual(normalizeChargingState('SuspendedEVSE'), 'suspended_evse');
  assert.strictEqual(normalizeChargingState('Whatever'), 'unrecognized');
});

test('toEvChargerState collapses CloudCharge detail into Homey four states', () => {
  assert.strictEqual(toEvChargerState('charging', 'charging'), 'plugged_in_charging');
  assert.strictEqual(toEvChargerState('ev_connected', 'occupied'), 'plugged_in');
  assert.strictEqual(toEvChargerState('suspended_ev', 'suspended_ev'), 'plugged_in');
  assert.strictEqual(toEvChargerState('idle', 'preparing'), 'plugged_in');
  assert.strictEqual(toEvChargerState('idle', 'available'), 'plugged_out');
});

test('toCapabilityValues converts kW to W', () => {
  // powerConsumption er kW hos CloudCharge, measure_power er W i Homey.
  const values = toCapabilityValues({ ...IDLE_OPERATIONAL_DATA, powerConsumption: 7.36 });
  assert.strictEqual(values.measure_power, 7360);
});

test('toCapabilityValues maps the real idle payload', () => {
  const values = toCapabilityValues(IDLE_OPERATIONAL_DATA);

  assert.strictEqual(values.measure_power, 0);
  assert.strictEqual(values.meter_power, 7367.7);
  assert.strictEqual(values.defa_session_energy, 0);
  assert.strictEqual(values.defa_status, 'available');
  assert.strictEqual(values.defa_charging_state, 'idle');
  assert.strictEqual(values.defa_error_code, 'NoError');
  assert.strictEqual(values.evcharger_charging, false);
  assert.strictEqual(values.evcharger_charging_state, 'plugged_out');
});

test('toCapabilityValues reports charging when the car draws power', () => {
  const values = toCapabilityValues({
    ...IDLE_OPERATIONAL_DATA,
    ocpp: { chargingState: 'Charging', status: 'CHARGING', version: 'OCPP16' },
    powerConsumption: 7.4,
    transactionMeterValue: 3.25,
  });

  assert.strictEqual(values.measure_power, 7400);
  assert.strictEqual(values.defa_session_energy, 3.25);
  assert.strictEqual(values.evcharger_charging, true);
  assert.strictEqual(values.evcharger_charging_state, 'plugged_in_charging');
  assert.ok(isCharging(values));
  assert.ok(isPluggedIn(values));
});

test('toCapabilityValues survives a malformed payload', () => {
  const values = toCapabilityValues(null);
  assert.strictEqual(values.measure_power, null);
  assert.strictEqual(values.meter_power, null);
  assert.strictEqual(values.defa_status, 'unknown');
  assert.strictEqual(values.evcharger_charging_state, 'plugged_out');
});

test('hasError only fires on a real error code', () => {
  assert.ok(!hasError(toCapabilityValues(IDLE_OPERATIONAL_DATA)));
  assert.ok(hasError(toCapabilityValues({ ...IDLE_OPERATIONAL_DATA, errorCode: 'GroundFailure' })));
});

test('pickConnectors keeps alias and connector id apart', () => {
  // Dette er hele poenget: alias går til /charging/start, id går til
  // /connector/{id}/…. Bytter man om, feiler begge stille.
  const connectors = pickConnectors(MY_CHARGERS);

  assert.strictEqual(connectors.length, 1);
  assert.strictEqual(connectors[0].alias, '00.00.00.0000');
  assert.strictEqual(connectors[0].id, '11111111-1111-4111-8111-111111111111');
  assert.notStrictEqual(connectors[0].alias, connectors[0].id);
});

test('pickConnectors falls back to the location when no name is set', () => {
  const connectors = pickConnectors(MY_CHARGERS);
  assert.strictEqual(connectors[0].name, 'Testveien 1');
  assert.strictEqual(connectors[0].vendor, 'DEFA');
  assert.strictEqual(connectors[0].model, 'homeCLU');
  assert.strictEqual(connectors[0].maxPowerKw, 7.4);
});

test('pickConnectors reports that this charger cannot set a current limit', () => {
  // /connector/{id}/maxcurrent/alternatives svarer CAPABILITY_NOT_FOUND, og
  // det speiles i capabilities.maxPower. Appen skal ikke tilby noe den ikke har.
  const connectors = pickConnectors(MY_CHARGERS);
  assert.strictEqual(connectors[0].capabilities.maxPower, false);
  assert.strictEqual(connectors[0].capabilities.ecoMode, true);
});

test('pickConnectors handles an empty or malformed response', () => {
  assert.deepStrictEqual(pickConnectors(null), []);
  assert.deepStrictEqual(pickConnectors({}), []);
  assert.deepStrictEqual(pickConnectors({ receivingAccess: [] }), []);
  assert.deepStrictEqual(pickConnectors({ receivingAccess: [{ chargePoint: null }] }), []);
});

test('pickConnectors deduplicates a connector shared through both lists', () => {
  const payload = {
    receivingAccess: MY_CHARGERS.receivingAccess,
    givingAccess: MY_CHARGERS.receivingAccess,
  };
  assert.strictEqual(pickConnectors(payload).length, 1);
});
