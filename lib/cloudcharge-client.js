'use strict';

const https = require('node:https');
const { URL } = require('node:url');

const {
  API_BASE_URL,
  MIN_REQUEST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  DEFAULT_DEV_TOKEN,
  normalizePhoneNumber,
  normalizeSmsCode,
} = require('./cloudcharge-config');

// CloudCharge svarer med ren tekst på autentiseringsfeil og JSON ellers.
// Vi oversetter de kjente strengene til stabile koder, slik at paringsdialogen
// kan si noe fornuftig uten å matche på engelsk tekst.
const ERROR_CODES = {
  'Invalid phone number': 'invalid_phone_number',
  'Invalid login credentials.': 'invalid_code',
  'No loginAttempts found': 'no_login_attempt',
  'field "devToken" in request body did not match any existing developer key': 'invalid_dev_token',
};

class CloudChargeError extends Error {
  constructor(message, { status = 0, body = '', code = 'unknown' } = {}) {
    super(message);
    this.name = 'CloudChargeError';
    this.status = status;
    this.body = body;
    this.code = code;
  }

  // 401/403 betyr at token-et er dødt. not_logged_in betyr at det aldri
  // fantes — begge skal vises som «logg inn på nytt», ikke «får ikke kontakt».
  get isAuthError() {
    return this.status === 401 || this.status === 403 || this.code === 'not_logged_in';
  }

  // Laderen støtter ikke funksjonen i det hele tatt — ikke en feil vi skal
  // prøve på nytt. DEFA Power homeCLU svarer slik på /maxcurrent.
  get isUnsupported() {
    return this.code === 'capability_not_supported';
  }
}

function classifyError(status, body) {
  const text = String(body || '').trim();
  if (ERROR_CODES[text]) return ERROR_CODES[text];

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error === 'CAPABILITY_NOT_FOUND') return 'capability_not_supported';
    } catch (error) {
      // Faller gjennom til de generiske kodene under.
    }
  }

  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

function httpsRequest({ url, method, headers, body, timeout, agent }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    const target = new URL(url);
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => done({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      // Brytes forbindelsen midt i svaret, kommer feilen på response-strømmen,
      // ikke på request. Uten lyttere her er det en uncaughtException som tar
      // ned hele appen.
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('Forbindelsen ble brutt midt i svaret')));
    });

    // setTimeout er en inaktivitetsfrist på socketen: så lenge motparten sender
    // én byte i ny og ne, utløper den aldri. Da ble _polling i device.js
    // stående på true for alltid, og laderen sluttet å oppdatere seg til appen
    // ble restartet. Derfor en absolutt frist i tillegg.
    const deadline = setTimeout(() => {
      request.destroy(new Error(`Tidsavbrudd mot CloudCharge etter ${timeout} ms`));
    }, timeout);
    if (typeof deadline.unref === 'function') deadline.unref();

    request.setTimeout(timeout, () => {
      request.destroy(new Error(`Tidsavbrudd mot CloudCharge etter ${timeout} ms`));
    });
    request.on('error', fail);
    request.on('close', () => clearTimeout(deadline));
    if (body) request.write(body);
    request.end();
  });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CloudChargeClient {
  constructor({
    baseUrl = API_BASE_URL,
    minRequestInterval = MIN_REQUEST_INTERVAL_MS,
    timeout = REQUEST_TIMEOUT_MS,
    devToken = DEFAULT_DEV_TOKEN,
    agent,
    request = httpsRequest,
    sleep = defaultSleep,
    now = () => Date.now(),
    log = () => {},
  } = {}) {
    this._baseUrl = baseUrl.replace(/\/+$/, '');
    this._minRequestInterval = minRequestInterval;
    this._timeout = timeout;
    this._devToken = devToken;
    this._request = request;
    this._sleep = sleep;
    this._now = now;
    this._log = log;

    this._userId = null;
    this._token = null;

    // CloudCharge kjører på flere servere bak en lastbalanserer, og en
    // INGRESSCOOKIE avgjør hvilken du treffer. loginAttempt-en som /prelogin
    // oppretter, finnes bare på serveren som håndterte den — treffer /login en
    // annen server, svarer den «No loginAttempts found». Derfor tas cookiene
    // vare på og forbindelsen gjenbrukes, så hele innloggingen blir liggende
    // på samme server. Funnet oppstrøms i ha-defa-power v0.5.4.
    this._cookies = new Map();
    this._agent = agent === undefined
      ? new https.Agent({ keepAlive: true, maxSockets: 1 })
      : agent;

    // Serialiserer bare *starten* av hvert kall, ikke hele svaret.
    // -Infinity gjør at det aller første kallet slipper å vente ut intervallet.
    this._queue = Promise.resolve();
    this._lastRequestAt = Number.NEGATIVE_INFINITY;
  }

  setSession({ userId, token }) {
    this._userId = userId || null;
    this._token = token || null;
  }

  clearSession() {
    this._userId = null;
    this._token = null;
  }

  hasSession() {
    return Boolean(this._userId && this._token);
  }

  getSession() {
    return { userId: this._userId, token: this._token };
  }

  setDevToken(devToken) {
    if (devToken) this._devToken = devToken;
  }

  // CloudCharge rate-limiter per token, så vi holder et minsteintervall mellom
  // kall uansett hvor mange enheter eller flows som spør samtidig.
  _throttle() {
    const run = this._queue.then(async () => {
      const wait = this._minRequestInterval - (this._now() - this._lastRequestAt);
      if (wait > 0) await this._sleep(wait);
      this._lastRequestAt = this._now();
    });
    this._queue = run.catch(() => {});
    return run;
  }

  // Bare navn=verdi beholdes; Path/HttpOnly/Expires er uten betydning for oss,
  // og vi snakker uansett bare med ett vertsnavn.
  _storeCookies(headers) {
    const setCookie = headers && headers['set-cookie'];
    if (!setCookie) return;

    for (const raw of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const pair = String(raw).split(';')[0];
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      this._cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  _cookieHeader() {
    if (this._cookies.size === 0) return '';
    return [...this._cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async _call(method, path, { body, auth = true } = {}) {
    if (auth && !this.hasSession()) {
      throw new CloudChargeError('Ikke innlogget på CloudCharge', { code: 'not_logged_in' });
    }

    const headers = { Accept: 'application/json' };
    let payload;

    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    if (auth) {
      headers['x-authorization'] = this._token;
      headers['x-user'] = this._userId;
    }

    const cookie = this._cookieHeader();
    if (cookie) headers.Cookie = cookie;

    await this._throttle();

    const response = await this._request({
      url: `${this._baseUrl}${path}`,
      method,
      headers,
      body: payload,
      timeout: this._timeout,
      agent: this._agent,
    });

    this._storeCookies(response.headers);

    if (response.status < 200 || response.status >= 300) {
      const code = classifyError(response.status, response.body);
      // Kroppen trunkeres i meldingen: en 502 fra en lastbalanserer kan være
      // 20 KB HTML, og den skal ikke inn i hver logglinje.
      const excerpt = String(response.body || '').trim().slice(0, 200) || '<tomt>';
      throw new CloudChargeError(
        `${method} ${path} svarte ${response.status}: ${excerpt}`,
        { status: response.status, body: response.body, code },
      );
    }

    const text = String(response.body || '').trim();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch (error) {
      return text;
    }
  }

  // --- Innlogging ---------------------------------------------------------

  async sendSmsCode(phoneNumber, devToken = this._devToken) {
    const phoneNr = normalizePhoneNumber(phoneNumber);
    await this._call('POST', '/prelogin', {
      body: { phoneNr, devToken },
      auth: false,
    });
    return { phoneNr };
  }

  async loginWithCode(phoneNumber, code, devToken = this._devToken) {
    const phoneNr = normalizePhoneNumber(phoneNumber);
    const data = await this._call('POST', '/login', {
      body: { phoneNr, password: normalizeSmsCode(code), devToken },
      auth: false,
    });

    if (!data || !data.token || !data.id) {
      throw new CloudChargeError('CloudCharge svarte uten token', { code: 'no_token' });
    }

    this.setSession({ userId: data.id, token: data.token });
    return { userId: data.id, token: data.token };
  }

  async logout() {
    try {
      await this._call('POST', '/logout');
    } finally {
      this.clearSession();
    }
  }

  // --- Lesing -------------------------------------------------------------

  // De to laderlistene. Et ladepunkt kan ligge i den ene uten å ligge i den
  // andre, så paringen spør alltid begge — se pickConnectorsFrom().
  //
  // /mychargers lister tilgangsdelinger: ladepunktet ligger under
  // receivingAccess[].chargePoint eller givingAccess[].chargePoint.
  getMyChargers() {
    return this._call('GET', '/mychargers');
  }

  // /chargers/private lister ladepunkt du selv eier, og pakker dem i `data` i
  // stedet for `chargePoint`. For en eier kan /mychargers være helt tom mens
  // laderen ligger her — bekreftet mot en bruker og mot modellene i
  // ha-defa-power, som opprinnelig brukte kun dette endepunktet.
  getPrivateChargers() {
    return this._call('GET', '/chargers/private');
  }

  // Detaljene om ett ladepunkt, inkludert maxProfileCurrent — den gjeldende
  // ladestrømmen. Den ligger ikke i /operationaldata, så den må hentes her.
  // `token` er chargePointId-en, ikke et sikkerhetstoken.
  getChargePoint(chargePointId) {
    return this._call('POST', '/chargepoints/get', { body: { token: chargePointId } });
  }

  // Lovlige ladestrømmer for dette ladepunktet: { "16": 11.0, "20": 13.8, … }
  // — nøkkel er ampere, verdi er effekt i kW. Svarer CAPABILITY_NOT_FOUND på
  // ladere som ikke støtter det, og da er lokal CLU eneste vei.
  getMaxCurrentAlternatives(connectorId) {
    return this._call('GET', `/connector/${encodeURIComponent(connectorId)}/maxcurrent/alternatives`);
  }

  setMaxCurrent(connectorId, current) {
    const amps = Math.round(Number(current));
    return this._call('POST', `/connector/${encodeURIComponent(connectorId)}/maxcurrent?current=${amps}`);
  }

  getOperationalData(connectorId) {
    return this._call('GET', `/connector/${encodeURIComponent(connectorId)}/operationaldata`);
  }

  getEcoModeConfiguration(connectorId) {
    return this._call('GET', `/connector/${encodeURIComponent(connectorId)}/ecomode/configuration`);
  }

  getActiveScheduleSettings(connectorId) {
    return this._call('GET', `/connector/${encodeURIComponent(connectorId)}/schedule/active-settings`);
  }

  // --- Styring ------------------------------------------------------------

  // Vekker måleravlesningen slik at powerConsumption blir noe annet enn 0.
  startLiveConsumption(connectorId) {
    return this._call('POST', `/connector/${encodeURIComponent(connectorId)}/startliveconsumption`);
  }

  // Start og stopp bruker alias — nøkkelen i aliasMap — ikke connector-id-en.
  startCharging(alias) {
    return this._call('POST', '/charging/start', { body: { alias } });
  }

  stopCharging(alias) {
    return this._call('POST', '/charging/stop', { body: { alias } });
  }

  setEcoModeConfiguration(connectorId, configuration) {
    return this._call('PUT', `/connector/${encodeURIComponent(connectorId)}/ecomode/configuration`, {
      body: configuration,
    });
  }

  overrideSchedule(connectorId) {
    return this._call('PUT', `/connector/${encodeURIComponent(connectorId)}/schedule/override`);
  }

  reset(connectorId, type = 'soft') {
    const resetType = type === 'hard' ? 'hard' : 'soft';
    return this._call('POST', `/connector/${encodeURIComponent(connectorId)}/reset?type=${resetType}`);
  }
}

module.exports = {
  CloudChargeClient,
  CloudChargeError,
  classifyError,
  httpsRequest,
};
