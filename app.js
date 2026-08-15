'use strict';

const Homey = require('homey');
const { version } = require('./app.json');
const { CloudChargeClient } = require('./lib/cloudcharge-client');
const {
  API_BASE_URL,
  MIN_REQUEST_INTERVAL_MS,
  SETTING_USER_ID,
  SETTING_TOKEN,
  SETTING_DEV_TOKEN,
  resolveSession,
  maskSecret,
} = require('./lib/cloudcharge-config');

const TRIGGER_CARDS = [
  'defa_charging_started',
  'defa_charging_stopped',
  'defa_car_connected',
  'defa_car_disconnected',
  'defa_status_changed',
  'defa_error_occurred',
  'defa_error_cleared',
  'defa_eco_mode_changed',
  'defa_plug_and_charge_changed',
  'defa_charge_offline_changed',
];

class DefaPowerApp extends Homey.App {
  async onInit() {
    this._client = null;
    this._triggers = new Map();
    // Innloggingen fra innstillingssiden skjer over to kall — SMS, så kode —
    // så nummeret må overleve mellom dem.
    this._pendingPhone = '';

    this.registerFlowCards();

    // Ingen lytter på settings her med vilje. Appen er eneste skriver, og en
    // lytter som river klienten ned midt i paringen tvinger neste kall til å
    // lese sesjonen tilbake fra innstillingene før skrivningen er synlig.
    // Sesjonen settes eksplisitt på klienten i stedet, se saveSession().

    const { userId, token, devToken, source } = resolveSession(this.homey.settings);
    this.log(
      `DEFA Power v${version} initialized — session ${source}`
      + (userId ? `, user ${maskSecret(userId)}, token ${maskSecret(token)}` : '')
      + `, devToken ${maskSecret(devToken)}`,
    );
  }

  getClient() {
    if (!this._client) {
      const { userId, token, devToken } = resolveSession(this.homey.settings);

      this._client = new CloudChargeClient({
        baseUrl: API_BASE_URL,
        minRequestInterval: MIN_REQUEST_INTERVAL_MS,
        devToken,
        log: (...args) => this.log('[cloudcharge]', ...args),
      });

      if (userId && token) this._client.setSession({ userId, token });
      this.log(`CloudCharge-klient opprettet — ${userId ? 'med' : 'uten'} lagret sesjon`);
    }
    return this._client;
  }

  resetClient() {
    if (!this._client) return;
    this._client = null;
    this.log('Sesjonen endret — bygger CloudCharge-klienten på nytt ved neste kall');
  }

  // Sesjonen må overleve omstart, og env.json leveres ikke på Homey Pro,
  // så den lagres i appinnstillingene. Men den settes også rett på klienten:
  // resten av paringen skjer i løpet av millisekunder, og skal ikke være
  // avhengig av at skrivningen kan leses tilbake med én gang.
  saveSession({ userId, token }) {
    this.homey.settings.set(SETTING_USER_ID, userId);
    this.homey.settings.set(SETTING_TOKEN, token);
    this.getClient().setSession({ userId, token });
    this.log(`Sesjon lagret — user ${maskSecret(userId)}, token ${maskSecret(token)}`);
  }

  clearStoredSession() {
    this.homey.settings.unset(SETTING_USER_ID);
    this.homey.settings.unset(SETTING_TOKEN);
    if (this._client) this._client.clearSession();
  }

  setPendingPhone(phone) {
    this._pendingPhone = phone || '';
  }

  getPendingPhone() {
    return this._pendingPhone;
  }

  // Hvilken app Homey utgir seg for å være. CloudCharge tillater én sesjon per
  // app, så dette avgjør om mobilappen din sparker Homey ut eller ikke.
  setDevToken(devToken) {
    this.homey.settings.set(SETTING_DEV_TOKEN, devToken);
    this.resetClient();
    this.log(`devToken byttet til ${maskSecret(devToken)}`);
  }

  async logout() {
    const client = this.getClient();
    try {
      if (client.hasSession()) await client.logout();
    } catch (error) {
      // Sesjonen ryddes lokalt uansett — en feil her betyr som regel bare at
      // token-et allerede var dødt, og skal ikke vises som mislykket utlogging.
      this.log('Utlogging mot CloudCharge feilet — rydder lokalt likevel:', error.message);
    } finally {
      this.clearStoredSession();
      this.resetClient();
    }
  }

  // Enhetene kaller denne; kortene hentes én gang ved oppstart.
  async triggerDeviceFlow(id, device, tokens = {}) {
    const card = this._triggers.get(id);
    if (!card) return;

    try {
      await card.trigger(device, tokens);
    } catch (error) {
      this.error(`Flow-kortet ${id} feilet`, error);
    }
  }

  registerFlowCards() {
    for (const id of TRIGGER_CARDS) {
      this._triggers.set(id, this.homey.flow.getDeviceTriggerCard(id));
    }

    this.homey.flow
      .getConditionCard('defa_condition_charging')
      .registerRunListener(({ device }) => Boolean(device.getCapabilityValue('evcharger_charging')));

    this.homey.flow
      .getConditionCard('defa_condition_car_connected')
      .registerRunListener(({ device }) =>
        device.getCapabilityValue('evcharger_charging_state') !== 'plugged_out');

    this.homey.flow
      .getConditionCard('defa_condition_eco_mode')
      .registerRunListener(({ device }) => Boolean(device.getCapabilityValue('defa_eco_mode')));

    this.homey.flow
      .getConditionCard('defa_condition_error')
      .registerRunListener(({ device }) => {
        const code = device.getCapabilityValue('defa_error_code');
        return typeof code === 'string' && code !== '' && code !== 'NoError';
      });

    this.homey.flow
      .getActionCard('defa_action_start')
      .registerRunListener(({ device }) => device.startCharging());

    this.homey.flow
      .getActionCard('defa_action_stop')
      .registerRunListener(({ device }) => device.stopCharging());

    this.homey.flow
      .getActionCard('defa_action_set_eco_mode')
      .registerRunListener(({ device, mode }) => device.setEcoMode(mode === 'on'));

    this.homey.flow
      .getActionCard('defa_action_override_schedule')
      .registerRunListener(({ device }) => device.overrideSchedule());

    this.homey.flow
      .getActionCard('defa_action_reset')
      .registerRunListener(({ device, type }) => device.resetCharger(type));

    this.homey.flow
      .getActionCard('defa_action_refresh')
      .registerRunListener(({ device }) => device.refreshNow());

    this.homey.flow
      .getActionCard('defa_action_set_current')
      .registerRunListener(({ device, amps }) => device.setChargeCurrent(amps));

    this.homey.flow
      .getActionCard('defa_action_set_plug_and_charge')
      .registerRunListener(({ device, mode }) => device.setPlugAndCharge(mode === 'on'));

    this.homey.flow
      .getActionCard('defa_action_set_charge_offline')
      .registerRunListener(({ device, mode }) => device.setChargeOffline(mode === 'on'));

    this.homey.flow
      .getConditionCard('defa_condition_plug_and_charge')
      .registerRunListener(({ device }) => Boolean(device.getCapabilityValue('defa_plug_and_charge')));

    this.homey.flow
      .getConditionCard('defa_condition_charge_offline')
      .registerRunListener(({ device }) => Boolean(device.getCapabilityValue('defa_charge_offline')));
  }
}

module.exports = DefaPowerApp;
