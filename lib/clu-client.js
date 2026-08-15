'use strict';

const http = require('node:http');

const {
  applyCurrent,
  applyPlugAndCharge,
  applyChargeOffline,
  plugAndChargeFromConfig,
  assertMatchesExpected,
} = require('./clu-current');

const DEFAULT_PORT = 80;
const DEFAULT_TIMEOUT_MS = 15000;

class CluError extends Error {
  constructor(message, { status = 0, body = '', code = 'unknown' } = {}) {
    super(message);
    this.name = 'CluError';
    this.status = status;
    this.body = body;
    this.code = code;
  }

  get isAuthError() {
    return this.code === 'bad_pin' || this.status === 401 || this.status === 403;
  }
}

function httpRequest({ host, port, path, method, headers, body, timeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    const request = http.request({ host, port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => done({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      // Feil midt i svaret kommer på response-strømmen, ikke på request —
      // uten lyttere krasjer et Wi-Fi-blipp mot laderen hele appen.
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('Forbindelsen ble brutt midt i svaret')));
    });

    request.setTimeout(timeout, () => {
      request.destroy(new Error(`Tidsavbrudd mot CLU etter ${timeout} ms`));
    });
    request.on('error', fail);
    if (body) request.write(body);
    request.end();
  });
}

// Snakker med idriftsettelsesverktøyet på selve laderen. Det er ikke et
// runtime-API — det er der montøren setter opp anlegget — så skrivinger holdes
// bevisst sjeldne og alltid som les-endre-skriv.
class CluClient {
  constructor({
    host,
    port = DEFAULT_PORT,
    pin = '',
    timeout = DEFAULT_TIMEOUT_MS,
    request = httpRequest,
    log = () => {},
  } = {}) {
    this._host = host;
    this._port = port;
    this._pin = pin;
    this._timeout = timeout;
    this._request = request;
    this._log = log;
    this._cookie = null;

    // Montøridentiteten (navn/firma) endrer seg ikke mellom skrivinger —
    // caches etter første oppslag og sparer ett HTTP-kall per skriving.
    this._identity = null;

    // Skrivinger serialiseres: to samtidige les-endre-skriv ville lest samme
    // basiskonfigurasjon, og den siste ville stille reversert den første.
    this._writeQueue = Promise.resolve();
  }

  setPin(pin) {
    if (pin !== this._pin) this._cookie = null;
    this._pin = pin;
  }

  setHost(host, port = DEFAULT_PORT) {
    if (host !== this._host || port !== this._port) {
      this._cookie = null;
      this._identity = null; // annen lader, annen montør
    }
    this._host = host;
    this._port = port;
  }

  async _call(method, path, { body, auth = false, retried = false } = {}) {
    if (!this._host) throw new CluError('Ingen adresse satt for CLU-en', { code: 'no_host' });

    const headers = { Accept: 'application/json' };
    let payload;

    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    if (auth) {
      if (!this._cookie) await this.authenticate();
      headers.Cookie = this._cookie;
    }

    const response = await this._request({
      host: this._host,
      port: this._port,
      path,
      method,
      headers,
      body: payload,
      timeout: this._timeout,
    });

    if (response.status < 200 || response.status >= 300) {
      // Utløpt sesjonscookie — f.eks. etter at laderen har rebootet. Logg inn
      // på nytt og prøv én gang til; en feil PIN kaster fortsatt bad_pin fra
      // authenticate() ved neste forsøk.
      if (auth && !retried && (response.status === 401 || response.status === 403)) {
        this._log('CLU: sesjonen utløpt — logger inn på nytt');
        this._cookie = null;
        return this._call(method, path, { body, auth, retried: true });
      }

      throw new CluError(
        `${method} ${path} svarte ${response.status}: ${String(response.body || '').trim().slice(0, 200) || '<tomt>'}`,
        { status: response.status, body: response.body, code: 'http_error' },
      );
    }

    // /get-status svarer med en array, resten med objekter — begge må parses.
    // Et trunkert svar (Wi-Fi-blipp, CLU-reset midt i sendingen) skal bli en
    // klassifisert feil, ikke en naken SyntaxError.
    const text = String(response.body || '').trim();
    let data = text || null;

    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new CluError(
          `${method} ${path} svarte med ugyldig JSON: ${text.slice(0, 200)}`,
          { status: response.status, body: text.slice(0, 200), code: 'invalid_json' },
        );
      }
    }

    return { data, headers: response.headers };
  }

  async authenticate() {
    if (!this._pin) throw new CluError('Ingen PIN satt for CLU-en', { code: 'no_pin' });

    const { data, headers } = await this._call('POST', '/auth-user', {
      body: { password: String(this._pin) },
    });

    if (!data || data.success !== true) {
      throw new CluError('CLU-en avviste PIN-koden', { code: 'bad_pin' });
    }

    const setCookie = headers['set-cookie'];
    if (setCookie && setCookie.length) {
      // Vi trenger bare navn=verdi, ikke Path/HttpOnly-attributtene.
      this._cookie = setCookie.map((value) => String(value).split(';')[0]).join('; ');
    }

    // Uten cookie ville neste authed kall sendt «Cookie: null» og feilet
    // kryptisk — si det heller rett ut.
    if (!this._cookie) {
      throw new CluError('CLU-en godtok PIN-en, men ga ingen sesjonscookie', { code: 'no_cookie' });
    }

    if (data.user) {
      this._identity = {
        name: data.user.name || '',
        company: data.user.company || '',
      };
    }

    this._log('CLU: innlogget');
    return data.user || null;
  }

  async getStatus() {
    const { data } = await this._call('GET', '/get-status');
    if (!Array.isArray(data)) return {};

    return data.reduce((status, item) => {
      if (item && item.id) status[item.id] = item.value;
      return status;
    }, {});
  }

  async getConfig() {
    const { data } = await this._call('GET', '/get-homeCLU');
    return data;
  }

  async getVersion() {
    const { data } = await this._call('GET', '/get-version');
    return data && data.version ? String(data.version).trim() : null;
  }

  // Felles les-endre-skriv for alle innstillinger. Kalleren endrer kun sitt
  // eget felt; alt annet sendes tilbake nøyaktig slik det ble lest. Skrivingen
  // avbrytes hvis installasjonsparameterne ikke er som forventet, og hoppes
  // over hvis ingenting faktisk endrer seg.
  //
  // Skrivinger går i kø: hele les-endre-skriv-syklusen må fullføre før neste
  // får lese, ellers reverterer den andre stille det den første endret.
  _writeConfig(options) {
    const run = this._writeQueue.then(() => this._writeConfigNow(options));
    this._writeQueue = run.catch(() => {});
    return run;
  }

  async _writeConfigNow({ mutate, isUnchanged, label, expected = null, user = null }) {
    const config = await this.getConfig();
    assertMatchesExpected(config, expected);

    const next = mutate(config);

    if (isUnchanged(config, next)) {
      this._log(`CLU: ${label} er allerede satt — skriver ikke`);
      return { changed: false, config: next };
    }

    const identity = user || this._identity || await this.getStatus().then((status) => ({
      name: status.name || '',
      company: status.company || '',
    }));
    this._identity = identity;

    await this._call('POST', '/set-homeCLU', {
      auth: true,
      body: {
        settings: next,
        user: {
          name: identity.name || '',
          company: identity.company || '',
          password: String(this._pin),
          rePassword: String(this._pin),
        },
      },
    });

    this._log(`CLU: ${label} skrevet`);
    return { changed: true, config: next };
  }

  async setChargeCurrent(amps, options = {}) {
    const result = await this._writeConfig({
      ...options,
      mutate: (config) => applyCurrent(config, amps),
      isUnchanged: (before, after) =>
        Number(before.maxTotalChargeCurrent) === Number(after.maxTotalChargeCurrent),
      label: `ladestrøm ${amps} A`,
    });

    return { changed: result.changed, amps: Number(result.config.maxTotalChargeCurrent) };
  }

  // Gratis lading uten autorisasjon, per ladepunkt.
  async setPlugAndCharge(address, enabled, options = {}) {
    const result = await this._writeConfig({
      ...options,
      mutate: (config) => applyPlugAndCharge(config, address, enabled),
      isUnchanged: (before, after) =>
        plugAndChargeFromConfig(before, address) === plugAndChargeFromConfig(after, address),
      label: `Plug & Charge ${enabled ? 'på' : 'av'}`,
    });

    return { changed: result.changed, enabled: plugAndChargeFromConfig(result.config, address) };
  }

  // Slår på Plug & Charge automatisk hvis internett faller bort.
  async setChargeOffline(enabled, options = {}) {
    const result = await this._writeConfig({
      ...options,
      mutate: (config) => applyChargeOffline(config, enabled),
      isUnchanged: (before, after) => Boolean(before.chargeOffline) === Boolean(after.chargeOffline),
      label: `offline-lading ${enabled ? 'på' : 'av'}`,
    });

    return { changed: result.changed, enabled: Boolean(result.config.chargeOffline) };
  }
}

module.exports = {
  CluClient,
  CluError,
  httpRequest,
  DEFAULT_PORT,
};
