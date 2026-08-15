'use strict';

const Homey = require('homey');
const { pickConnectors } = require('../../lib/connector-state');
const {
  isValidPhoneNumber,
  isValidSmsCode,
  normalizePhoneNumber,
} = require('../../lib/cloudcharge-config');

// CloudCharge-feilkoder oversatt til noe paringsdialogen kan vise.
const ERROR_KEYS = {
  invalid_phone_number: 'pair.errors.invalid_phone',
  invalid_code: 'pair.errors.invalid_code',
  no_login_attempt: 'pair.errors.no_login_attempt',
  invalid_dev_token: 'pair.errors.invalid_dev_token',
  unauthorized: 'pair.errors.unauthorized',
};

class DefaChargerDriver extends Homey.Driver {
  async onPair(session) {
    this.registerPairHandlers(session, 'pair');
  }

  // Ingen onRepair her med vilje. Innloggingen er app-global og deles av alle
  // ladere, så den hører hjemme i appinnstillingene — ikke i en reparasjon av
  // én enhet. Enhetene blir tilgjengelige igjen av seg selv ved neste
  // vellykkede polling.

  registerPairHandlers(session, mode) {
    let phoneNumber = '';

    // Er vi allerede innlogget, hopper visningen rett til enhetsvalget.
    session.setHandler('check_session', async () => {
      const client = this.homey.app.getClient();

      if (!client.hasSession()) {
        this.log('check_session: ingen lagret sesjon');
        return { ready: false, mode };
      }

      try {
        await client.getMyChargers();
        this.log('check_session: lagret sesjon er gyldig');
        return { ready: true, mode };
      } catch (error) {
        this.log('check_session: lagret sesjon virker ikke lenger:', error.message);
        return { ready: false, mode };
      }
    });

    session.setHandler('send_code', async ({ phone }) => {
      if (!isValidPhoneNumber(phone)) {
        throw new Error(this.homey.__('pair.errors.invalid_phone'));
      }

      phoneNumber = normalizePhoneNumber(phone);

      try {
        await this.homey.app.getClient().sendSmsCode(phoneNumber);
      } catch (error) {
        throw this.translate(error);
      }

      this.log(`SMS-kode bestilt for ${phoneNumber.slice(0, 4)}…`);
      return { phone: phoneNumber };
    });

    session.setHandler('verify_code', async ({ code }) => {
      if (!phoneNumber) throw new Error(this.homey.__('pair.errors.no_phone'));
      if (!isValidSmsCode(code)) throw new Error(this.homey.__('pair.errors.invalid_code'));

      let credentials;
      try {
        credentials = await this.homey.app.getClient().loginWithCode(phoneNumber, code);
      } catch (error) {
        throw this.translate(error);
      }

      this.homey.app.saveSession(credentials);
      this.log('Innlogget på CloudCharge');
      return { ok: true, mode };
    });

    // Enhetslisten hentes hit i stedet for gjennom list_devices-malen. Malen
    // kaller aldri handleren sin når man navigerer til den fra en egen
    // visning, og visningen ble bare stående blank.
    session.setHandler('list_connectors', async () => this.listConnectors());
  }

  translate(error) {
    const key = ERROR_KEYS[error && error.code];
    if (!key) return error;

    const translated = new Error(this.homey.__(key));
    translated.code = error.code;
    return translated;
  }

  async listConnectors() {
    const client = this.homey.app.getClient();
    this.log(`list_connectors kjører — sesjon: ${client.hasSession() ? 'ja' : 'nei'}`);

    let chargers;
    try {
      chargers = await client.getMyChargers();
    } catch (error) {
      this.error('list_connectors: /mychargers feilet', error.code || '', error.message);
      throw this.translate(error);
    }

    const connectors = pickConnectors(chargers);
    this.log(`Fant ${connectors.length} ladepunkt(er) på kontoen`);

    return connectors.map((connector) => ({
      name: connector.name,
      data: {
        // connector.id er det stabile ID-et og brukes i /connector/{id}/…
        id: connector.id,
      },
      store: {
        // alias er en annen verdi enn id, og den eneste som virker mot
        // /charging/start og /charging/stop.
        alias: connector.alias,
        chargePointId: connector.chargePointId,
      },
      settings: {
        info_connector_id: connector.id,
        info_alias: connector.alias,
        info_serial: connector.serialNumber || '',
        info_firmware: connector.firmwareVersion || '',
      },
    }));
  }
}

module.exports = DefaChargerDriver;
