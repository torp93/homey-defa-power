'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { CluClient, CluError } = require('../lib/clu-client');

const CONFIG = {
  connectors: [{ address: 1, maxCurrent: '32', evccType: 'Gen2', isFree: true, priority: true }],
  distNetType: 'IT',
  chargePointType: 'Single-phase only',
  homeFuseSize: '63A',
  connector1Phase: 'L1-L2',
  homeCluSensor: 'None',
  maxTotalChargeCurrent: '32',
  chargeOffline: false,
};

const STATUS = [
  { id: 'serial', value: '00.00.00.0000.00000000.00.00.00.00.0000' },
  { id: 'name', value: 'Ola Nordmann' },
  { id: 'company', value: 'Eksempel AS' },
];

// Etterligner CLU-en: ruter på sti og logger alt som blir sendt.
function stubClu(overrides = {}) {
  const calls = [];

  const routes = Object.assign({
    'POST /auth-user': () => ({
      status: 200,
      headers: { 'set-cookie': ['session=abc123; Path=/; HttpOnly'] },
      body: JSON.stringify({ success: true, user: { name: 'Ola Nordmann', company: 'Eksempel AS' } }),
    }),
    'GET /get-homeCLU': () => ({ status: 200, headers: {}, body: JSON.stringify(CONFIG) }),
    'GET /get-status': () => ({ status: 200, headers: {}, body: JSON.stringify(STATUS) }),
    'POST /set-homeCLU': () => ({ status: 200, headers: {}, body: '' }),
  }, overrides);

  const client = new CluClient({
    host: '192.168.10.60',
    pin: '123456',
    request: async (request) => {
      calls.push(request);
      const route = routes[`${request.method} ${request.path}`];
      if (!route) return { status: 404, headers: {}, body: 'not found' };
      return route(request);
    },
  });

  return { client, calls };
}

const find = (calls, method, path) =>
  calls.find((call) => call.method === method && call.path === path);

test('authenticate posts the pin and keeps the session cookie', async () => {
  const { client, calls } = stubClu();
  const user = await client.authenticate();

  assert.deepStrictEqual(JSON.parse(calls[0].body), { password: '123456' });
  assert.strictEqual(user.name, 'Ola Nordmann');

  // Bare navn=verdi skal gjenbrukes, ikke Path/HttpOnly.
  await client.setChargeCurrent(16);
  assert.strictEqual(find(calls, 'POST', '/set-homeCLU').headers.Cookie, 'session=abc123');
});

test('a rejected pin is reported as an auth error', async () => {
  const { client } = stubClu({
    'POST /auth-user': () => ({ status: 200, headers: {}, body: JSON.stringify({ success: false }) }),
  });

  await assert.rejects(
    () => client.authenticate(),
    (error) => error instanceof CluError && error.isAuthError && error.code === 'bad_pin',
  );
});

test('getStatus flattens the id/value list', async () => {
  const { client } = stubClu();
  const status = await client.getStatus();

  assert.strictEqual(status.name, 'Ola Nordmann');
  assert.strictEqual(status.company, 'Eksempel AS');
});

test('setChargeCurrent reads first and writes the whole config back', async () => {
  const { client, calls } = stubClu();
  const result = await client.setChargeCurrent(10);

  assert.deepStrictEqual(result, { changed: true, amps: 10 });
  assert.ok(find(calls, 'GET', '/get-homeCLU'), 'må lese før den skriver');

  const written = JSON.parse(find(calls, 'POST', '/set-homeCLU').body);
  assert.strictEqual(written.settings.maxTotalChargeCurrent, 10);
  assert.strictEqual(written.settings.distNetType, 'IT');
  assert.strictEqual(written.settings.homeFuseSize, '63A');
  assert.strictEqual(written.settings.connector1Phase, 'L1-L2');
  assert.deepStrictEqual(written.settings.connectors, CONFIG.connectors);
});

test('setChargeCurrent carries the installer identity from the charger', async () => {
  const { client, calls } = stubClu();
  await client.setChargeCurrent(10);

  const written = JSON.parse(find(calls, 'POST', '/set-homeCLU').body);
  assert.strictEqual(written.user.name, 'Ola Nordmann');
  assert.strictEqual(written.user.company, 'Eksempel AS');
  assert.strictEqual(written.user.password, '123456');
  assert.strictEqual(written.user.rePassword, '123456');
});

test('setChargeCurrent skips the write when nothing would change', async () => {
  // Dette er et idriftsettelsesendepunkt, ikke en runtime-knapp. Unødvendige
  // skrivinger slites på flash og kan avbryte en pågående lading.
  const { client, calls } = stubClu();
  const result = await client.setChargeCurrent(32);

  assert.deepStrictEqual(result, { changed: false, amps: 32 });
  assert.strictEqual(find(calls, 'POST', '/set-homeCLU'), undefined);
});

test('setChargeCurrent refuses out-of-range values before touching the network', async () => {
  const { client, calls } = stubClu();

  await assert.rejects(() => client.setChargeCurrent(40), (error) => error.code === 'out_of_range');
  assert.strictEqual(find(calls, 'POST', '/set-homeCLU'), undefined);
});

test('setChargeCurrent aborts when the installation no longer matches', async () => {
  const { client, calls } = stubClu();

  await assert.rejects(
    () => client.setChargeCurrent(10, { expected: { homeFuseSize: '20A' } }),
    (error) => error.code === 'config_changed',
  );
  assert.strictEqual(find(calls, 'POST', '/set-homeCLU'), undefined);
});

test('setChargeCurrent will not write a config it could not read properly', async () => {
  const { client, calls } = stubClu({
    'GET /get-homeCLU': () => ({ status: 200, headers: {}, body: JSON.stringify({ maxTotalChargeCurrent: '32' }) }),
  });

  await assert.rejects(
    () => client.setChargeCurrent(10),
    (error) => error.code === 'incomplete_config',
  );
  assert.strictEqual(find(calls, 'POST', '/set-homeCLU'), undefined);
});

test('changing the pin drops the cached cookie', async () => {
  const { client, calls } = stubClu();
  await client.authenticate();

  client.setPin('999999');
  await client.setChargeCurrent(16);

  const auths = calls.filter((call) => call.path === '/auth-user');
  assert.strictEqual(auths.length, 2, 'må logge inn på nytt etter ny PIN');
  assert.deepStrictEqual(JSON.parse(auths[1].body), { password: '999999' });
});

test('no host configured fails before any request', async () => {
  const client = new CluClient({ pin: '123456', request: async () => { throw new Error('skulle ikke kalles'); } });
  await assert.rejects(() => client.getConfig(), (error) => error.code === 'no_host');
});
