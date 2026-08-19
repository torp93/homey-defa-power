'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeStatus,
  normalizeChargingState,
  toEvChargerState,
  isOperationalData,
  toCapabilityValues,
  pickConnectorsFrom,
  currentAlternatives,
  currentFromChargePoint,
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

test('toEvChargerState maps onto the Homey EV charger states', () => {
  assert.strictEqual(toEvChargerState('charging', 'charging'), 'plugged_in_charging');
  assert.strictEqual(toEvChargerState('ev_connected', 'occupied'), 'plugged_in');
  assert.strictEqual(toEvChargerState('idle', 'preparing'), 'plugged_in');
  assert.strictEqual(toEvChargerState('idle', 'available'), 'plugged_out');
});

test('a paused session uses Homey own paused state, not just plugged in', () => {
  // Homey har plugged_in_paused. Å kollapse pause til «tilkoblet» kastet bort
  // det brukeren faktisk vil se: at bilen står i, men ikke lader nå.
  assert.strictEqual(toEvChargerState('suspended_ev', 'suspended_ev'), 'plugged_in_paused');
  assert.strictEqual(toEvChargerState('idle', 'suspended_evse'), 'plugged_in_paused');
  // Lading vinner fortsatt over pause hvis laderen melder begge deler.
  assert.strictEqual(toEvChargerState('suspended_evse', 'charging'), 'plugged_in_charging');
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

test('pickConnectors finds a charger under a list name we have never seen', () => {
  // En bruker meldte «kontoen har ingen ladere» på en konto med lader. Vi har
  // bare sett receivingAccess/givingAccess på én konto, så letingen må ikke
  // være låst til de to navnene.
  const connectors = pickConnectors({ someOtherAccess: MY_CHARGERS.receivingAccess });
  assert.strictEqual(connectors.length, 1);
  assert.strictEqual(connectors[0].id, '11111111-1111-4111-8111-111111111111');
});

test('pickConnectors ignores top-level lists that are not charger entries', () => {
  assert.deepStrictEqual(pickConnectors({ notifications: [{ text: 'hei' }] }), []);
  assert.deepStrictEqual(pickConnectors({ tags: ['a', 'b'], timestamp: 1 }), []);
});

test('pickConnectors accepts a bare top-level array of access entries', () => {
  // /chargers/private-formen er ukjent — svaret kan være en array rett ut.
  const connectors = pickConnectors(MY_CHARGERS.receivingAccess);
  assert.strictEqual(connectors.length, 1);
});

test('pickConnectors reads the /chargers/private wrapper', () => {
  // /chargers/private pakker ladepunktet i `data`, ikke `chargePoint`.
  // Bekreftet mot PrivateChargePoint i ha-defa-power sin models.py.
  const priv = MY_CHARGERS.receivingAccess.map((entry) => ({
    access: 'OWNER',
    type: 'PRIVATE',
    data: entry.chargePoint,
  }));

  const connectors = pickConnectors(priv);
  assert.strictEqual(connectors.length, 1);
  assert.strictEqual(connectors[0].id, '11111111-1111-4111-8111-111111111111');
  assert.strictEqual(connectors[0].alias, '00.00.00.0000');
});

test('pickConnectors accepts charge points without an access wrapper', () => {
  const bare = MY_CHARGERS.receivingAccess.map((entry) => entry.chargePoint);
  const connectors = pickConnectors({ chargers: bare });
  assert.strictEqual(connectors.length, 1);
  assert.strictEqual(connectors[0].id, '11111111-1111-4111-8111-111111111111');
});

// --- Ugyldige 200-svar må ikke bli en falsk trygg tilstand ----------------
//
// CloudCharge kan svare 200 med tom kropp (klienten returnerer null) eller med
// en HTML-feilside fra en lastbalanserer (klienten returnerer råteksten).
// Uten en vakt oversatte toCapabilityValues() begge til «frakoblet, 0 W,
// ingen feil», og device.poll() fyrte da fire flow-triggere midt i en
// pågående ladeøkt samtidig som en ekte feilkode ble borte.

test('isOperationalData rejects the payloads a broken 200 actually produces', () => {
  assert.strictEqual(isOperationalData(null), false, 'tom kropp');
  assert.strictEqual(isOperationalData(undefined), false);
  assert.strictEqual(isOperationalData('<html>502 Bad Gateway</html>'), false, 'ugyldig JSON');
  assert.strictEqual(isOperationalData(''), false);
  assert.strictEqual(isOperationalData([]), false, 'array er ikke operationaldata');
  assert.strictEqual(isOperationalData(IDLE_OPERATIONAL_DATA), true);
  // Et objekt uten ocpp er fortsatt et svar — vakten skal ikke være strengere
  // enn nødvendig, ellers avvises gyldige svar med felter vi ikke kjenner.
  assert.strictEqual(isOperationalData({}), true);
});

test('a broken 200 would otherwise unplug the car, so the guard must reject it', () => {
  // Dokumenterer hvorfor vakten finnes: dette er utfallet den forhindrer.
  const values = toCapabilityValues(null);
  assert.strictEqual(values.evcharger_charging_state, 'plugged_out');
  assert.strictEqual(values.evcharger_charging, false);
  // Derfor må device.poll() aldri mate dette inn i applyValues().
  assert.strictEqual(isOperationalData(null), false);
});

test('a missing errorCode is unknown, not "no error"', () => {
  // «Vet ingenting» skal ikke bli «ingen feil». null skrives ikke til
  // kapabiliteten, så siste kjente feilkode står.
  const { errorCode, ...withoutErrorCode } = IDLE_OPERATIONAL_DATA;
  assert.strictEqual(toCapabilityValues(withoutErrorCode).defa_error_code, null);
  // En tom streng fra API-et betyr derimot at laderen svarte, uten feil.
  assert.strictEqual(toCapabilityValues({ ...IDLE_OPERATIONAL_DATA, errorCode: '' }).defa_error_code, 'NoError');
  assert.strictEqual(toCapabilityValues(IDLE_OPERATIONAL_DATA).defa_error_code, 'NoError');
});

// --- Felles laderoppdagelse ----------------------------------------------

test('pickConnectorsFrom merges both charger lists without duplicating', () => {
  // Samme lader i begge endepunktene skal gi én enhet, ikke to.
  const priv = MY_CHARGERS.receivingAccess.map((entry) => ({ data: entry.chargePoint }));
  const merged = pickConnectorsFrom(MY_CHARGERS, priv);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].id, '11111111-1111-4111-8111-111111111111');
});

test('pickConnectorsFrom finds a charger present in only one list', () => {
  // Eierens lader ligger i /chargers/private mens /mychargers er helt tom —
  // nøyaktig tilfellet en bruker rapporterte.
  const empty = { timestamp: 1, receivingAccess: [], givingAccess: [] };
  const priv = MY_CHARGERS.receivingAccess.map((entry) => ({ data: entry.chargePoint }));
  assert.strictEqual(pickConnectorsFrom(empty, priv).length, 1);
  // Og motsatt vei, når det private endepunktet feilet og ble null.
  assert.strictEqual(pickConnectorsFrom(MY_CHARGERS, null).length, 1);
});

// --- Skybasert ladestrøm -------------------------------------------------

test('currentAlternatives reads the amp keys and finds the range', () => {
  // Svaret er { ampere: kW }, og nøklene kommer ikke nødvendigvis sortert.
  const limits = currentAlternatives({ '20': 13.8, '6': 4.1, '16': 11.0 });
  assert.deepStrictEqual(limits, { min: 6, max: 20, values: [6, 16, 20] });
});

test('currentAlternatives refuses anything that is not a usable answer', () => {
  // Skulle disse gitt {min:0,max:0} ville skyveknappen i Homey blitt ubrukelig.
  assert.strictEqual(currentAlternatives(null), null);
  assert.strictEqual(currentAlternatives({}), null);
  assert.strictEqual(currentAlternatives([]), null);
  assert.strictEqual(currentAlternatives('CAPABILITY_NOT_FOUND'), null);
  assert.strictEqual(currentAlternatives({ tull: 1 }), null);
});

test('currentFromChargePoint finds maxProfileCurrent for the right connector', () => {
  // Gjeldende ladestrøm ligger her, ikke i /operationaldata.
  const point = {
    id: 'cp-1',
    aliasMap: {
      a1: { id: 'conn-1', maxProfileCurrent: 16 },
      a2: { id: 'conn-2', maxProfileCurrent: 32 },
    },
  };

  assert.strictEqual(currentFromChargePoint(point, 'conn-1'), 16);
  assert.strictEqual(currentFromChargePoint(point, 'conn-2'), 32);
  assert.strictEqual(currentFromChargePoint(point, 'ukjent'), null);
});

test('currentFromChargePoint accepts every wrapper the API uses', () => {
  const point = { id: 'cp-1', aliasMap: { a1: { id: 'conn-1', maxProfileCurrent: 10 } } };

  assert.strictEqual(currentFromChargePoint(point, 'conn-1'), 10, 'direkte');
  assert.strictEqual(currentFromChargePoint({ data: point }, 'conn-1'), 10, 'private-innpakning');
  assert.strictEqual(currentFromChargePoint({ chargePoint: point }, 'conn-1'), 10, 'access-innpakning');
  assert.strictEqual(currentFromChargePoint({ receivingAccess: [{ chargePoint: point }] }, 'conn-1'), 10, 'liste');
  assert.strictEqual(currentFromChargePoint(null, 'conn-1'), null);
});
