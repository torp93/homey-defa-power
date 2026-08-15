'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { toCapabilityValues } = require('../lib/connector-state');
const {
  UNAVAILABLE_AFTER_FAILURES,
  MAX_BACKOFF_SECONDS,
  detectTransitions,
  nextSessionEnergy,
  needsLiveConsumption,
  nextLiveConsumptionState,
  backoffSeconds,
  shouldMarkUnavailable,
} = require('../lib/device-transitions');

const values = ({ status = 'AVAILABLE', chargingState = null, session = 0, errorCode = 'NoError' } = {}) =>
  toCapabilityValues({
    ocpp: { status, chargingState, version: 'OCPP16' },
    errorCode,
    meterValue: 7367.7,
    transactionMeterValue: session,
    powerConsumption: chargingState === 'Charging' ? 7.4 : 0,
  });

const IDLE = values();
const PLUGGED = values({ status: 'PREPARING', chargingState: 'EVConnected' });
const CHARGING = values({ status: 'CHARGING', chargingState: 'Charging', session: 4.2 });

const ids = (events) => events.map((event) => event.id);

test('the first poll after startup fires nothing', () => {
  // Uten en forrige avlesning finnes det ingen endring — ellers ville hver
  // omstart av appen sett ut som at bilen nettopp ble koblet til.
  assert.deepStrictEqual(detectTransitions(null, CHARGING), []);
  assert.deepStrictEqual(detectTransitions(undefined, IDLE), []);
});

test('plugging in and starting to charge fires both events', () => {
  assert.deepStrictEqual(ids(detectTransitions(IDLE, PLUGGED)),
    ['defa_car_connected', 'defa_status_changed']);

  assert.deepStrictEqual(ids(detectTransitions(PLUGGED, CHARGING)),
    ['defa_charging_started', 'defa_status_changed']);
});

test('unplugging fires stop and disconnect', () => {
  assert.deepStrictEqual(ids(detectTransitions(CHARGING, IDLE)),
    ['defa_charging_stopped', 'defa_car_disconnected', 'defa_status_changed']);
});

test('a steady state fires nothing', () => {
  assert.deepStrictEqual(detectTransitions(CHARGING, CHARGING), []);
  assert.deepStrictEqual(detectTransitions(IDLE, IDLE), []);
});

test('the status token carries the new status', () => {
  const [event] = detectTransitions(IDLE, values({ status: 'FAULTED' }));
  assert.strictEqual(event.id, 'defa_status_changed');
  assert.strictEqual(event.tokens.status, 'faulted');
});

test('an error fires once, not on every poll while it persists', () => {
  const faulted = values({ errorCode: 'GroundFailure' });

  assert.ok(ids(detectTransitions(IDLE, faulted)).includes('defa_error_occurred'));
  assert.ok(!ids(detectTransitions(faulted, faulted)).includes('defa_error_occurred'));
});

test('the error token carries the code', () => {
  const events = detectTransitions(IDLE, values({ errorCode: 'GroundFailure' }));
  const error = events.find((event) => event.id === 'defa_error_occurred');
  assert.strictEqual(error.tokens.error_code, 'GroundFailure');
});

test('a cleared error fires the falling-edge event exactly once', () => {
  const faulted = values({ errorCode: 'GroundFailure' });

  // Feilen forsvinner: én defa_error_cleared, så en flow kan rydde opp etter
  // varselet sitt.
  assert.ok(ids(detectTransitions(faulted, IDLE)).includes('defa_error_cleared'));
  // Og bare på selve overgangen — ikke på hver polling etterpå.
  assert.ok(!ids(detectTransitions(IDLE, IDLE)).includes('defa_error_cleared'));
  // En feil som bytter kode er fortsatt en feil, ikke en opprydding.
  const other = values({ errorCode: 'OverCurrent' });
  assert.ok(!ids(detectTransitions(faulted, other)).includes('defa_error_cleared'));
});

test('a pause by the car does not read as unplugged', () => {
  const suspended = values({ status: 'SUSPENDED_EV', chargingState: 'SuspendedEV' });
  const events = ids(detectTransitions(CHARGING, suspended));

  assert.ok(events.includes('defa_charging_stopped'));
  assert.ok(!events.includes('defa_car_disconnected'), 'bilen står fortsatt i');
});

test('session energy starts from what the charger already reports', () => {
  // Feilen som var her før: en ny økt nullstilte til 0 og kastet den første
  // avlesningen, som godt kan være over null.
  assert.strictEqual(nextSessionEnergy(99, PLUGGED, CHARGING), 4.2);
});

test('session energy keeps climbing during a session', () => {
  const later = values({ status: 'CHARGING', chargingState: 'Charging', session: 9.6 });
  assert.strictEqual(nextSessionEnergy(4.2, CHARGING, later), 9.6);
});

test('session energy survives the charger resetting it to zero', () => {
  // transactionMeterValue faller til 0 når økten avsluttes, men flow-tokenet
  // skal fortsatt kunne fortelle hvor mye som ble ladet.
  assert.strictEqual(nextSessionEnergy(9.6, CHARGING, IDLE), 9.6);
});

test('session energy never goes backwards mid-session', () => {
  const dip = values({ status: 'CHARGING', chargingState: 'Charging', session: 2 });
  assert.strictEqual(nextSessionEnergy(9.6, CHARGING, dip), 9.6);
});

test('live consumption is needed whenever charging and not yet started', () => {
  // Dette er poenget: restarter appen midt i en økt finnes ingen overgang,
  // men live-forbruk må likevel vekkes, ellers står effekten på 0 W.
  assert.ok(needsLiveConsumption(false, CHARGING));
  assert.ok(!needsLiveConsumption(true, CHARGING));
  assert.ok(!needsLiveConsumption(false, IDLE));
  assert.ok(!needsLiveConsumption(false, PLUGGED));
});

test('live consumption state resets when charging ends', () => {
  assert.strictEqual(nextLiveConsumptionState(true, IDLE, false), false);
  assert.strictEqual(nextLiveConsumptionState(true, CHARGING, false), true);
});

test('a failed start is retried on the next poll', () => {
  assert.strictEqual(nextLiveConsumptionState(false, CHARGING, false), false);
  assert.strictEqual(nextLiveConsumptionState(false, CHARGING, true), true);
});

test('the device only goes unavailable after repeated failures', () => {
  assert.ok(!shouldMarkUnavailable(1));
  assert.ok(!shouldMarkUnavailable(2));
  assert.ok(shouldMarkUnavailable(UNAVAILABLE_AFTER_FAILURES));
  assert.ok(shouldMarkUnavailable(10));
});

test('backoff grows but stays bounded', () => {
  assert.strictEqual(backoffSeconds(60, 1), 60);
  assert.strictEqual(backoffSeconds(60, 2), 120);
  assert.strictEqual(backoffSeconds(60, 3), 240);
  assert.strictEqual(backoffSeconds(60, 9), MAX_BACKOFF_SECONDS);
  assert.strictEqual(backoffSeconds(10, 1), 10);
});

test('backoff tolerates nonsense input', () => {
  assert.strictEqual(backoffSeconds(0, 1), 60);
  assert.strictEqual(backoffSeconds(60, 0), 60);
  assert.strictEqual(backoffSeconds(undefined, undefined), 60);
});
