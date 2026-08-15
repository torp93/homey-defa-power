'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  resolveConnectorIndex,
  plugAndChargeFromConfig,
  chargeOfflineFromConfig,
  applyPlugAndCharge,
  applyChargeOffline,
} = require('../lib/clu-current');
const { CluClient } = require('../lib/clu-client');

const CONFIG = {
  connectors: [
    {
      address: 1,
      energyMeter: true,
      maxCurrent: '32',
      rfid: true,
      rfidGroup: 'None',
      evccType: 'Gen2',
      isFree: true,
      priority: true,
    },
  ],
  distNetType: 'IT',
  chargePointType: 'Single-phase only',
  homeFuseSize: '63A',
  connector1Phase: 'L1-L2',
  homeCluSensor: 'None',
  maxTotalChargeCurrent: '32',
  chargeOffline: false,
};

const TWO_CONNECTORS = {
  ...CONFIG,
  connectors: [
    { ...CONFIG.connectors[0], address: 1, isFree: true },
    { ...CONFIG.connectors[0], address: 2, isFree: false },
  ],
};

test('a single charge point needs no address to be identified', () => {
  assert.strictEqual(resolveConnectorIndex(CONFIG, null), 0);
  assert.strictEqual(resolveConnectorIndex(CONFIG, 1), 0);
});

test('several charge points without an address is refused, not guessed', () => {
  // Å gjette feil ladepunkt ville slått av autorisasjon på naboens uttak.
  assert.throws(
    () => resolveConnectorIndex(TWO_CONNECTORS, null),
    (error) => error.code === 'ambiguous_connector',
  );
  assert.throws(
    () => resolveConnectorIndex(TWO_CONNECTORS, 7),
    (error) => error.code === 'connector_not_found',
  );
  assert.strictEqual(resolveConnectorIndex(TWO_CONNECTORS, 2), 1);
});

test('applyPlugAndCharge changes only the addressed connector', () => {
  const next = applyPlugAndCharge(TWO_CONNECTORS, 2, true);

  assert.strictEqual(next.connectors[0].isFree, true, 'ladepunkt 1 urørt');
  assert.strictEqual(next.connectors[1].isFree, true, 'ladepunkt 2 endret');
  assert.strictEqual(next.connectors[1].maxCurrent, '32', 'øvrige felter beholdt');
  assert.strictEqual(next.distNetType, 'IT');
});

test('applyPlugAndCharge leaves the rest of the installation alone', () => {
  const next = applyPlugAndCharge(CONFIG, 1, false);

  assert.strictEqual(next.connectors[0].isFree, false);
  assert.strictEqual(next.homeFuseSize, '63A');
  assert.strictEqual(next.connector1Phase, 'L1-L2');
  assert.strictEqual(next.maxTotalChargeCurrent, '32');
});

test('applyChargeOffline flips only that flag', () => {
  const next = applyChargeOffline(CONFIG, true);

  assert.strictEqual(next.chargeOffline, true);
  assert.deepStrictEqual(next.connectors, CONFIG.connectors);
  assert.strictEqual(next.distNetType, 'IT');
});

test('both refuse an incomplete config', () => {
  assert.throws(() => applyPlugAndCharge({}, 1, true), (e) => e.code === 'incomplete_config');
  assert.throws(() => applyChargeOffline({}, true), (e) => e.code === 'incomplete_config');
});

test('readers report the current state', () => {
  assert.strictEqual(plugAndChargeFromConfig(CONFIG, 1), true);
  assert.strictEqual(plugAndChargeFromConfig(TWO_CONNECTORS, 2), false);
  assert.strictEqual(chargeOfflineFromConfig(CONFIG), false);
});

test('readers return null rather than guessing on a bad config', () => {
  assert.strictEqual(plugAndChargeFromConfig({}, 1), null);
  assert.strictEqual(plugAndChargeFromConfig(TWO_CONNECTORS, null), null);
  assert.strictEqual(chargeOfflineFromConfig({}), null);
});

// --- Klientens skrivevei ---------------------------------------------------

function stubClu(config = CONFIG) {
  const calls = [];
  const client = new CluClient({
    host: '192.168.10.60',
    pin: '123456',
    request: async (request) => {
      calls.push(request);
      const key = `${request.method} ${request.path}`;

      if (key === 'POST /auth-user') {
        return {
          status: 200,
          headers: { 'set-cookie': ['session=abc; Path=/'] },
          body: JSON.stringify({ success: true, user: { name: 'T', company: 'G' } }),
        };
      }
      if (key === 'GET /get-homeCLU') return { status: 200, headers: {}, body: JSON.stringify(config) };
      if (key === 'GET /get-status') {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify([{ id: 'name', value: 'Ola Nordmann' }, { id: 'company', value: 'Eksempel AS' }]),
        };
      }
      if (key === 'POST /set-homeCLU') return { status: 200, headers: {}, body: '' };
      return { status: 404, headers: {}, body: 'not found' };
    },
  });

  return { client, calls };
}

const written = (calls) => {
  const call = calls.find((c) => c.path === '/set-homeCLU');
  return call ? JSON.parse(call.body).settings : null;
};

test('setPlugAndCharge writes the whole config with only isFree changed', async () => {
  const { client, calls } = stubClu();
  const result = await client.setPlugAndCharge(1, false);

  assert.deepStrictEqual(result, { changed: true, enabled: false });

  const settings = written(calls);
  assert.strictEqual(settings.connectors[0].isFree, false);
  assert.strictEqual(settings.connectors[0].maxCurrent, '32');
  assert.strictEqual(settings.distNetType, 'IT');
  assert.strictEqual(settings.maxTotalChargeCurrent, '32');
});

test('setChargeOffline writes the whole config with only that flag changed', async () => {
  const { client, calls } = stubClu();
  const result = await client.setChargeOffline(true);

  assert.deepStrictEqual(result, { changed: true, enabled: true });

  const settings = written(calls);
  assert.strictEqual(settings.chargeOffline, true);
  assert.deepStrictEqual(settings.connectors, CONFIG.connectors);
});

test('no write happens when the value already matches', async () => {
  const { client, calls } = stubClu();

  const plug = await client.setPlugAndCharge(1, true);
  const offline = await client.setChargeOffline(false);

  assert.strictEqual(plug.changed, false);
  assert.strictEqual(offline.changed, false);
  assert.strictEqual(written(calls), null, 'ingen skriving skal ha skjedd');
});

test('the installation guard blocks these writes too', async () => {
  const { client, calls } = stubClu();

  await assert.rejects(
    () => client.setChargeOffline(true, { expected: { homeFuseSize: '20A' } }),
    (error) => error.code === 'config_changed',
  );
  assert.strictEqual(written(calls), null);
});

test('a multi-connector charger without an address refuses rather than guessing', async () => {
  const { client, calls } = stubClu(TWO_CONNECTORS);

  await assert.rejects(
    () => client.setPlugAndCharge(null, true),
    (error) => error.code === 'ambiguous_connector',
  );
  assert.strictEqual(written(calls), null);
});
