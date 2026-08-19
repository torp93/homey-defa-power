'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { CloudChargeClient, CloudChargeError, classifyError } = require('../lib/cloudcharge-client');

// Fanger opp forespørslene i stedet for å ringe CloudCharge.
function stubClient(responses, options = {}) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];

  const client = new CloudChargeClient({
    minRequestInterval: 0,
    request: async (request) => {
      calls.push(request);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return { status: 200, body: '', ...next };
    },
    ...options,
  });

  return { client, calls };
}

const jsonBody = (call) => JSON.parse(call.body);

test('login posts phoneNr, password and devToken, then stores the session', async () => {
  const { client, calls } = stubClient({
    status: 200,
    body: JSON.stringify({ token: 'exampletoken0123456789xyz', id: 'user-1234567890abcdef' }),
  });

  const session = await client.loginWithCode('+47 900 00000', '123456');

  assert.strictEqual(calls[0].method, 'POST');
  assert.ok(calls[0].url.endsWith('/login'));
  assert.deepStrictEqual(jsonBody(calls[0]), {
    phoneNr: '4790000000',
    password: '123456',
    devToken: 'XqP3sCFKdg4vrV8J',
  });

  assert.strictEqual(session.userId, 'user-1234567890abcdef');
  assert.ok(client.hasSession());
});

test('sendSmsCode normalizes the phone number', async () => {
  const { client, calls } = stubClient({ status: 200, body: '' });
  await client.sendSmsCode('90000000');
  assert.strictEqual(jsonBody(calls[0]).phoneNr, '4790000000');
  assert.ok(calls[0].url.endsWith('/prelogin'));
});

test('authenticated calls send x-authorization and x-user', async () => {
  const { client, calls } = stubClient({ status: 200, body: '{"ok":true}' });
  client.setSession({ userId: 'user-1', token: 'token-1' });

  await client.getOperationalData('connector-1');

  assert.strictEqual(calls[0].headers['x-authorization'], 'token-1');
  assert.strictEqual(calls[0].headers['x-user'], 'user-1');
  assert.ok(calls[0].url.endsWith('/connector/connector-1/operationaldata'));
});

test('calling an authenticated endpoint without a session throws before any HTTP', async () => {
  const { client, calls } = stubClient({ status: 200, body: '{}' });

  await assert.rejects(
    () => client.getMyChargers(),
    (error) => error instanceof CloudChargeError && error.code === 'not_logged_in',
  );
  assert.strictEqual(calls.length, 0);
});

test('start and stop charging use the alias, not the connector id', async () => {
  const { client, calls } = stubClient({ status: 200, body: '' });
  client.setSession({ userId: 'user-1', token: 'token-1' });

  await client.startCharging('00.00.00.0000');
  await client.stopCharging('00.00.00.0000');

  assert.ok(calls[0].url.endsWith('/charging/start'));
  assert.deepStrictEqual(jsonBody(calls[0]), { alias: '00.00.00.0000' });
  assert.ok(calls[1].url.endsWith('/charging/stop'));
  assert.deepStrictEqual(jsonBody(calls[1]), { alias: '00.00.00.0000' });
});

test('reset only accepts soft and hard', async () => {
  const { client, calls } = stubClient({ status: 200, body: '' });
  client.setSession({ userId: 'user-1', token: 'token-1' });

  await client.reset('connector-1', 'hard');
  await client.reset('connector-1', 'nonsense');

  assert.ok(calls[0].url.endsWith('/connector/connector-1/reset?type=hard'));
  assert.ok(calls[1].url.endsWith('/connector/connector-1/reset?type=soft'));
});

test('a 204 with no body resolves to null rather than throwing', async () => {
  // /connector/{id}/loadBalancer svarer slik når lastbalansering ikke er satt opp.
  const { client } = stubClient({ status: 204, body: '' });
  client.setSession({ userId: 'user-1', token: 'token-1' });

  assert.strictEqual(await client.getActiveScheduleSettings('connector-1'), null);
});

test('an unsupported capability is flagged rather than retried', async () => {
  const { client } = stubClient({
    status: 404,
    body: JSON.stringify({ error: 'CAPABILITY_NOT_FOUND', details: {} }),
  });
  client.setSession({ userId: 'user-1', token: 'token-1' });

  await assert.rejects(
    () => client.getEcoModeConfiguration('connector-1'),
    (error) => error.isUnsupported && error.code === 'capability_not_supported',
  );
});

test('a dead token is reported as an auth error', async () => {
  const { client } = stubClient({ status: 403, body: 'Invalid login credentials.' });
  client.setSession({ userId: 'user-1', token: 'token-1' });

  await assert.rejects(
    () => client.getMyChargers(),
    (error) => error.isAuthError === true,
  );
});

test('logout clears the session even when the call fails', async () => {
  const { client } = stubClient({ status: 500, body: 'boom' });
  client.setSession({ userId: 'user-1', token: 'token-1' });

  await assert.rejects(() => client.logout());
  assert.ok(!client.hasSession());
});

test('classifyError recognizes the CloudCharge wordings', () => {
  assert.strictEqual(classifyError(400, 'Invalid phone number'), 'invalid_phone_number');
  assert.strictEqual(classifyError(403, 'Invalid login credentials.'), 'invalid_code');
  assert.strictEqual(classifyError(403, 'No loginAttempts found'), 'no_login_attempt');
  assert.strictEqual(
    classifyError(403, 'field "devToken" in request body did not match any existing developer key'),
    'invalid_dev_token',
  );
  assert.strictEqual(classifyError(500, '{"status":500}'), 'server_error');
});

test('requests are spaced by the throttle interval', async () => {
  // CloudCharge rate-limiter per token; uten pause begynner kall å time ut.
  let clock = 0;
  const slept = [];

  const client = new CloudChargeClient({
    minRequestInterval: 1000,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    request: async () => {
      clock += 5;
      return { status: 200, body: '{}' };
    },
  });
  client.setSession({ userId: 'user-1', token: 'token-1' });

  await client.getOperationalData('a');
  await client.getOperationalData('b');
  await client.getOperationalData('c');

  // Første kall går med én gang; de neste venter ut resten av intervallet.
  assert.deepStrictEqual(slept, [995, 995]);
});

test('concurrent callers are serialized instead of bursting', async () => {
  let clock = 0;
  const startedAt = [];

  const client = new CloudChargeClient({
    minRequestInterval: 1000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    request: async () => {
      startedAt.push(clock);
      return { status: 200, body: '{}' };
    },
  });
  client.setSession({ userId: 'user-1', token: 'token-1' });

  await Promise.all([
    client.getOperationalData('a'),
    client.getOperationalData('b'),
    client.getOperationalData('c'),
  ]);

  assert.deepStrictEqual(startedAt, [0, 1000, 2000]);
});

// --- INGRESSCOOKIE: hele innloggingen må treffe samme server -------------
//
// CloudCharge kjører på flere servere bak en lastbalanserer. loginAttempt-en
// /prelogin oppretter, finnes bare på serveren som håndterte den, så treffer
// /login en annen server svarer den «No loginAttempts found». Cookien er det
// eneste som holder kallene på samme server.

test('a Set-Cookie from prelogin is sent back on the next request', () => {
  const { client, calls } = stubClient([
    { status: 200, body: '{}', headers: { 'set-cookie': ['INGRESSCOOKIE=abc123; Path=/; HttpOnly'] } },
    { status: 200, body: '{"id":"u","token":"t"}', headers: {} },
  ]);

  return client.sendSmsCode('90000000')
    .then(() => client.loginWithCode('90000000', '123456'))
    .then(() => {
      assert.strictEqual(calls.length, 2);
      assert.ok(!calls[0].headers.Cookie, 'første kall har ingen cookie ennå');
      assert.strictEqual(calls[1].headers.Cookie, 'INGRESSCOOKIE=abc123',
        'andre kall må bære cookien, ellers treffer /login en annen server');
    });
});

test('several cookies are kept, and a re-issued one replaces the old value', async () => {
  const { client, calls } = stubClient([
    { status: 200, body: '{}', headers: { 'set-cookie': ['A=1; Path=/', 'B=2'] } },
    { status: 200, body: '{}', headers: { 'set-cookie': ['A=9'] } },
    { status: 200, body: '{}', headers: {} },
  ]);

  client.setSession({ userId: 'u', token: 't' });
  await client.getMyChargers();
  await client.getMyChargers();
  await client.getMyChargers();

  assert.strictEqual(calls[1].headers.Cookie, 'A=1; B=2');
  assert.strictEqual(calls[2].headers.Cookie, 'A=9; B=2', 'A skal være oppdatert, B beholdt');
});

test('a response without Set-Cookie does not wipe what we already have', async () => {
  const { client, calls } = stubClient([
    { status: 200, body: '{}', headers: { 'set-cookie': ['INGRESSCOOKIE=keep'] } },
    { status: 200, body: '{}', headers: undefined },
    { status: 200, body: '{}', headers: {} },
  ]);

  client.setSession({ userId: 'u', token: 't' });
  await client.getMyChargers();
  await client.getMyChargers();
  await client.getMyChargers();

  assert.strictEqual(calls[2].headers.Cookie, 'INGRESSCOOKIE=keep');
});

// --- Skybasert ladestrøm -------------------------------------------------

test('the cloud current endpoints use the shapes the API expects', async () => {
  const { client, calls } = stubClient({ status: 200, body: '{}' });
  client.setSession({ userId: 'u', token: 't' });

  await client.getMaxCurrentAlternatives('conn-1');
  assert.ok(calls[0].url.endsWith('/connector/conn-1/maxcurrent/alternatives'));
  assert.strictEqual(calls[0].method, 'GET');

  // Ampere går som query-parameter, ikke i kroppen.
  await client.setMaxCurrent('conn-1', 16);
  assert.ok(calls[1].url.endsWith('/connector/conn-1/maxcurrent?current=16'), calls[1].url);
  assert.strictEqual(calls[1].method, 'POST');

  // Desimaler avrundes — API-et vil ha et heltall.
  await client.setMaxCurrent('conn-1', 15.6);
  assert.ok(calls[2].url.endsWith('?current=16'), calls[2].url);

  // chargePointId sendes som «token», som er navnet API-et bruker. Det er en
  // ladepunkt-id, ikke et sikkerhetstoken.
  await client.getChargePoint('cp-1');
  assert.strictEqual(calls[3].method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[3].body), { token: 'cp-1' });
});
