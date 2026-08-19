'use strict';

const Homey = require('homey');
const { pickConnectorsFrom } = require('../../lib/connector-state');
const {
  DEFAULT_DEV_TOKEN,
  isValidPhoneNumber,
  isValidSmsCode,
  normalizePhoneNumber,
} = require('../../lib/cloudcharge-config');

// Formen på et API-svar for diagnostikk: nøkkelnavn og antall, aldri verdier,
// siden svarene inneholder tokens. Vises i paringsskjermen ved tomt resultat.
// Teksten her er teknisk og med vilje engelsk: den vises i paringsvisningen på
// alle språk, og skal kopieres inn i en feilrapport. «(ingenting)» hjalp ingen.
function describeShape(payload) {
  if (payload === null || payload === undefined) return '(empty)';
  if (Array.isArray(payload)) return `[${payload.length}]`;
  if (typeof payload !== 'object') return `(${typeof payload})`;
  const shape = Object.entries(payload)
    .map(([key, value]) => (Array.isArray(value) ? `${key}[${value.length}]` : key))
    .join(' ');
  return shape || '(no fields)';
}

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
        // Alltid DEFA Power-tokenet, aldri det lagrede. CloudCharge-tokenet
        // svarer 200 OK og oppretter en gyldig loginAttempt, men SMS-en kommer
        // aldri fram — så en bruker som hadde valgt CloudCharge-plassen fikk
        // «kode sendt» og ventet forgjeves. Innløsningen under bruker fortsatt
        // den valgte plassen; det er hele poenget med å skille de to.
        await this.homey.app.getClient().sendSmsCode(phoneNumber, DEFAULT_DEV_TOKEN);
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

    // Vises i paringsskjermen når lista er tom. Uten dette må brukeren finne
    // fram til en diagnoserapport for å fortelle hva som skjedde, og da kommer
    // rapporten sjelden. Kun formen på svaret — nøkkelnavn og antall.
    session.setHandler('empty_reason', async () => this._lastEmptyShape || '');
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

    // En lader kan ligge i én av to lister, og ikke nødvendigvis i begge:
    //   /mychargers       — ladere du har fått tilgang til
    //   /chargers/private — dine egne private ladepunkt
    // ha-defa-power slår sammen begge for å finne ladere, og en bruker har
    // meldt om en lader som er usynlig i /mychargers. Derfor spørres begge, og
    // bare /mychargers får velte paringen hvis den feiler.
    let chargers;
    try {
      chargers = await client.getMyChargers();
    } catch (error) {
      this.error('list_connectors: /mychargers feilet', error.code || '', error.message);
      throw this.translate(error);
    }

    let priv = null;
    let privShape = '(failed)';
    try {
      priv = await client.getPrivateChargers();
      privShape = describeShape(priv);
    } catch (error) {
      this.error('/chargers/private feilet', error.code || '', error.message);
    }

    const found = pickConnectorsFrom(chargers, priv);

    // Homeys egen list_devices-mal filtrerer bort alt som alt er lagt til. Vi
    // bygger lista selv, så filtreringen må gjøres her — ellers kan samme lader
    // legges til to ganger.
    const paired = new Set(this.getDevices().map((device) => device.getData().id));
    const connectors = found.filter((connector) => !paired.has(connector.id));

    this.log(
      `Fant ${found.length} ladepunkt(er), ${connectors.length} ikke lagt til ennå — `
      + `mychargers: ${describeShape(chargers)}, private: ${privShape}`,
    );

    // Formen tas bare vare på når kontoen faktisk ikke ga noen ladere. Var det
    // filtreringen over som tømte lista, er det ikke noe galt å diagnostisere.
    this._lastEmptyShape = found.length === 0
      ? `mychargers: ${describeShape(chargers)} | private: ${privShape}`
      : null;

    // «Kontoen har ingen ladere» ville vært direkte feil her. Visningen viser
    // feilmeldinger i rødt allerede, så den sanne beskjeden går den veien.
    if (found.length > 0 && connectors.length === 0) {
      throw new Error(this.homey.__('pair.errors.all_paired'));
    }

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
