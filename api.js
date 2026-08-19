'use strict';

const {
  DEV_TOKENS,
  DEFAULT_DEV_TOKEN,
  resolveSession,
  maskSecret,
  normalizePhoneNumber,
  isValidPhoneNumber,
  isValidSmsCode,
} = require('./lib/cloudcharge-config');
const { pickConnectorsFrom } = require('./lib/connector-state');

// Hvilken app-plass Homey skal okkupere. CloudCharge tillater én aktiv sesjon
// per app, så velger man den appen man ikke bruker på mobilen, slutter de to å
// sparke hverandre ut.
const SLOTS = {
  cloud_charge: DEV_TOKENS.cloud_charge,
  defa_power: DEV_TOKENS.defa_power,
};

const fail = (error) => ({
  ok: false,
  code: (error && error.code) || 'unknown',
  message: error && error.message,
});

module.exports = {
  // Innstillingssiden viser bare maskerte verdier — hele token-et forlater
  // aldri appen.
  async getSession({ homey }) {
    const { userId, token, devToken, source } = resolveSession(homey.settings);

    const slot = Object.keys(SLOTS).find((key) => SLOTS[key] === devToken) || 'custom';

    return {
      loggedIn: Boolean(userId && token),
      userId: maskSecret(userId),
      token: maskSecret(token),
      devToken: maskSecret(devToken),
      slot,
      source,
    };
  },

  async testConnection({ homey }) {
    const client = homey.app.getClient();

    if (!client.hasSession()) {
      return { ok: false, code: 'not_logged_in', connectors: 0 };
    }

    try {
      // Begge endepunktene, samme oppdagelse som paringen bruker. Med bare
      // /mychargers meldte denne «kontoen har ingen ladere» for en konto der
      // paringen fant laderen helt fint.
      const chargers = await client.getMyChargers();
      const priv = await client.getPrivateChargers().catch(() => null);
      const connectors = pickConnectorsFrom(chargers, priv);

      return {
        ok: true,
        connectors: connectors.length,
        names: connectors.map((connector) => connector.name),
      };
    } catch (error) {
      return { ...fail(error), connectors: 0 };
    }
  },

  // SMS-en sendes alltid som DEFA Power. Det er den eneste appen CloudCharge
  // faktisk leverer koden for — CloudCharge-tokenet gir 200 OK og en gyldig
  // loginAttempt, men meldingen kommer aldri fram.
  async sendCode({ homey, body }) {
    const phone = body && body.phone;
    if (!isValidPhoneNumber(phone)) return { ok: false, code: 'invalid_phone_number' };

    const normalized = normalizePhoneNumber(phone);

    try {
      await homey.app.getClient().sendSmsCode(normalized, DEFAULT_DEV_TOKEN);
      homey.app.setPendingPhone(normalized);
      return { ok: true, phone: normalized };
    } catch (error) {
      return fail(error);
    }
  },

  // Koden løses inn mot den valgte app-plassen. Om CloudCharge tillater at
  // koden er bestilt som én app og innløst som en annen, er nettopp det som
  // avgjør om Homey kan slutte å krangle med mobilappen.
  async login({ homey, body }) {
    const code = body && body.code;
    if (!isValidSmsCode(code)) return { ok: false, code: 'invalid_code' };

    const phone = homey.app.getPendingPhone();
    if (!phone) return { ok: false, code: 'no_phone' };

    const slot = (body && body.slot) || 'defa_power';
    const devToken = SLOTS[slot] || DEFAULT_DEV_TOKEN;

    try {
      const credentials = await homey.app.getClient().loginWithCode(phone, code, devToken);

      homey.app.setDevToken(devToken);
      homey.app.saveSession(credentials);
      homey.app.setPendingPhone('');

      return { ok: true, slot };
    } catch (error) {
      return fail(error);
    }
  },

  async logout({ homey }) {
    await homey.app.logout();
    return { ok: true };
  },
};
