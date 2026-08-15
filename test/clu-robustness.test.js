'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { CluClient } = require('../lib/clu-client');

const BASE_CONFIG = {
  connectors: [{ address: 1, maxCurrent: '32', evccType: 'Gen2', isFree: true, priority: true }],
  distNetType: 'IT',
  chargePointType: 'Single-phase only',
  homeFuseSize: '63A',
  connector1Phase: 'L1-L2',
  homeCluSensor: 'None',
  maxTotalChargeCurrent: '32',
  chargeOffline: false,
};

// En stub som oppfører seg som laderen: skrivinger endrer faktisk tilstanden
// som senere lesinger returnerer. Det er det som gjør racet synlig.
function statefulClu({ sessionValidator } = {}) {
  let state = JSON.parse(JSON.stringify(BASE_CONFIG));
  let authCount = 0;
  let session = 0;
  const calls = [];

  const client = new CluClient({
    host: '192.168.10.60',
    pin: '123456',
    request: async (request) => {
      calls.push(request);
      const key = `${request.method} ${request.path}`;

      if (key === 'POST /auth-user') {
        authCount += 1;
        session += 1;
        return {
          status: 200,
          headers: { 'set-cookie': [`session=s${session}; Path=/`] },
          body: JSON.stringify({ success: true, user: { name: 'T', company: 'G' } }),
        };
      }
      if (key === 'GET /get-homeCLU') {
        return { status: 200, headers: {}, body: JSON.stringify(state) };
      }
      if (key === 'GET /get-status') {
        return { status: 200, headers: {}, body: JSON.stringify([{ id: 'name', value: 'T' }, { id: 'company', value: 'G' }]) };
      }
      if (key === 'POST /set-homeCLU') {
        if (sessionValidator && !sessionValidator(request.headers.Cookie, session)) {
          return { status: 403, headers: {}, body: '' };
        }
        state = JSON.parse(request.body).settings;
        return { status: 200, headers: {}, body: '' };
      }
      return { status: 404, headers: {}, body: 'not found' };
    },
  });

  return {
    client,
    calls,
    getState: () => state,
    getAuthCount: () => authCount,
    // Simulerer en reboot av laderen: alle utstedte cookies blir ugyldige,
    // uten at klienten vet noe.
    reboot: () => { session += 1; },
  };
}

test('concurrent writes are serialized so neither reverts the other', async () => {
  const { client, getState } = statefulClu();

  // Uten kø leser begge samme basiskonfigurasjon: den som skriver sist,
  // reverterer den andres endring stille.
  await Promise.all([
    client.setChargeCurrent(10),
    client.setPlugAndCharge(1, false),
  ]);

  const state = getState();
  assert.strictEqual(state.maxTotalChargeCurrent, 10, 'strømendringen må overleve');
  assert.strictEqual(state.connectors[0].isFree, false, 'Plug & Charge-endringen må overleve');
});

test('three concurrent writes all land', async () => {
  const { client, getState } = statefulClu();

  await Promise.all([
    client.setChargeCurrent(16),
    client.setPlugAndCharge(1, false),
    client.setChargeOffline(true),
  ]);

  const state = getState();
  assert.strictEqual(state.maxTotalChargeCurrent, 16);
  assert.strictEqual(state.connectors[0].isFree, false);
  assert.strictEqual(state.chargeOffline, true);
});

test('a failed write does not wedge the queue', async () => {
  const { client, getState } = statefulClu();

  await assert.rejects(() => client.setChargeCurrent(99)); // utenfor grensene
  const result = await client.setChargeCurrent(12);        // neste i køen må gå

  assert.strictEqual(result.changed, true);
  assert.strictEqual(getState().maxTotalChargeCurrent, 12);
});

test('an expired session cookie is renewed and the write retried once', async () => {
  // Bare den nyeste sesjonen aksepteres — som en Flask-server der gamle
  // cookies dør ved reboot.
  const { client, getState, getAuthCount, reboot } = statefulClu({
    sessionValidator: (cookie, current) => cookie === `session=s${current}`,
  });

  // Første skriving autentiserer (s1) og lykkes.
  await client.setChargeCurrent(10);
  assert.strictEqual(getAuthCount(), 1);

  // Laderen rebooter: s1 er død, klienten aner ingenting.
  reboot();

  // Neste skriving får 403 på den gamle cookien, logger inn på nytt og
  // fullfører — uten at kalleren merker noe. Før denne fiksen feilet alle
  // skrivinger permanent til appen ble restartet.
  const result = await client.setChargeCurrent(14);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(getState().maxTotalChargeCurrent, 14);
  assert.strictEqual(getAuthCount(), 2, 'nøyaktig én re-autentisering');
});

test('the installer identity is cached after the first write', async () => {
  const { client, calls } = statefulClu();

  await client.setChargeCurrent(10);
  await client.setChargeCurrent(14);
  await client.setPlugAndCharge(1, false);

  // getStatus trengs bare til identiteten, og den endrer seg ikke — ett
  // oppslag skal holde for alle tre skrivingene.
  const statusCalls = calls.filter((call) => call.path === '/get-status').length;
  assert.ok(statusCalls <= 1, `forventet maks 1 /get-status, fikk ${statusCalls}`);
});

test('a truncated JSON response becomes a classified error, not a SyntaxError', async () => {
  const client = new CluClient({
    host: '192.168.10.60',
    pin: '123456',
    request: async () => ({ status: 200, headers: {}, body: '{"connectors":[{"addr' }),
  });

  await assert.rejects(
    () => client.getConfig(),
    (error) => error.name === 'CluError' && error.code === 'invalid_json',
  );
});

test('a login without a session cookie fails loudly instead of sending Cookie: null', async () => {
  const client = new CluClient({
    host: '192.168.10.60',
    pin: '123456',
    request: async () => ({
      status: 200,
      headers: {}, // ingen set-cookie
      body: JSON.stringify({ success: true, user: { name: 'T', company: 'G' } }),
    }),
  });

  await assert.rejects(
    () => client.authenticate(),
    (error) => error.code === 'no_cookie',
  );
});

test('a wrong PIN still surfaces as bad_pin, not an infinite retry', async () => {
  let attempts = 0;
  const client = new CluClient({
    host: '192.168.10.60',
    pin: '000000',
    request: async (request) => {
      if (request.path === '/auth-user') {
        attempts += 1;
        return { status: 200, headers: {}, body: JSON.stringify({ success: false }) };
      }
      // Lesingene er uautentiserte og går fint — det er først skrivingen som
      // trenger innlogging, og der skal bad_pin stoppe alt.
      if (request.path === '/get-homeCLU') {
        return { status: 200, headers: {}, body: JSON.stringify(BASE_CONFIG) };
      }
      if (request.path === '/get-status') {
        return { status: 200, headers: {}, body: JSON.stringify([{ id: 'name', value: 'T' }]) };
      }
      return { status: 403, headers: {}, body: '' };
    },
  });

  await assert.rejects(
    () => client.setChargeCurrent(10),
    (error) => error.code === 'bad_pin',
  );
  assert.strictEqual(attempts, 1, 'ingen retry-løkke på feil PIN');
});
