'use strict';

const Homey = require('homey');
const { toCapabilityValues, isCharging } = require('../../lib/connector-state');
const { CluClient } = require('../../lib/clu-client');
const {
  resolveCurrentLimits,
  currentFromConfig,
  plugAndChargeFromConfig,
  chargeOfflineFromConfig,
} = require('../../lib/clu-current');
const {
  detectTransitions,
  nextSessionEnergy,
  needsLiveConsumption,
  nextLiveConsumptionState,
  backoffSeconds,
  shouldMarkUnavailable,
} = require('../../lib/device-transitions');

const DEFAULT_IDLE_INTERVAL = 60;
const DEFAULT_CHARGING_INTERVAL = 10;

// Eco-modus endres sjelden, og hvert kall spiser av rate-limiten.
const ECO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// Ladestrøm leses fra laderen selv, ikke fra skyen. Den endres bare når noen
// endrer den, så sjelden lesing holder.
const CLU_CAPABILITIES = ['defa_charge_current', 'defa_plug_and_charge', 'defa_charge_offline'];
const CLU_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

class DefaChargerDevice extends Homey.Device {
  async onInit() {
    const store = this.getStore();

    this._connectorId = this.getData().id;
    this._alias = store.alias || null;
    this._pollTimer = null;
    this._stopped = false;
    this._previous = null;
    this._lastSessionEnergy = 0;
    this._liveConsumptionStarted = false;
    this._consecutiveFailures = 0;
    this._polling = false;
    this._nextPollAt = 0;
    this._lastUpdateWrittenAt = 0;
    this._timeFormatter = null;
    this._ecoRefreshedAt = 0;
    // «Støttes ikke» huskes over restarter — OOM-killeren restarter appen
    // ofte nok til at det ellers koster ett bortkastet skykall hver gang.
    this._ecoSupported = this.getStoreValue('ecoUnsupported') !== true;
    this._clu = null;
    this._cluRefreshedAt = 0;
    this._cluWriteSeq = 0;
    this._cluSnapshot = null;
    this._cluListenerRegistered = false;

    if (!this._alias) {
      // Uten alias virker verken start eller stopp. Det skal ikke kunne skje
      // etter paring, men en enhet fra en eldre versjon kan mangle det.
      this.error('Enheten mangler alias — start og stopp vil ikke fungere');
    }

    this.registerCapabilityListeners();
    await this.syncLocalControl();
    this.log(`DEFA Power-lader klar — connector ${this._connectorId}, alias ${this._alias}`);

    this.schedulePoll(0);
  }

  onDeleted() {
    this.stopPolling();
  }

  onUninit() {
    this.stopPolling();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some((key) => key.startsWith('poll_interval'))) {
      this.log('Oppdateringsintervall endret — planlegger neste henting på nytt');
      this.schedulePoll(1);
    }

    // newSettings, ikke getSetting() — de nye verdiene er ikke skrevet ennå
    // når denne kjører.
    if (changedKeys.some((key) => key.startsWith('clu_'))) {
      await this.syncLocalControl(newSettings);
    }
  }

  // --- Oppsett ------------------------------------------------------------

  client() {
    return this.homey.app.getClient();
  }

  idleInterval() {
    const value = Number(this.getSetting('poll_interval_idle'));
    return Number.isFinite(value) && value >= 5 ? value : DEFAULT_IDLE_INTERVAL;
  }

  chargingInterval() {
    const value = Number(this.getSetting('poll_interval_charging'));
    return Number.isFinite(value) && value >= 5 ? value : DEFAULT_CHARGING_INTERVAL;
  }

  registerCapabilityListeners() {
    this.registerCapabilityListener('evcharger_charging', (value) =>
      (value ? this.startCharging() : this.stopCharging()));

    this.registerCapabilityListener('defa_eco_mode', (value) => this.setEcoMode(Boolean(value)));
    this.registerCapabilityListener('defa_button_override', () => this.overrideSchedule());
    this.registerCapabilityListener('defa_button_reset', () => this.resetCharger('soft'));
    this.registerCapabilityListener('defa_button_refresh', () => this.refreshNow());
  }

  // --- Polling ------------------------------------------------------------

  stopPolling() {
    this._stopped = true;
    if (this._pollTimer) {
      this.homey.clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  schedulePoll(seconds) {
    if (this._stopped) return;

    const at = Date.now() + Math.max(0, seconds) * 1000;

    // En allerede planlagt henting som fyrer tidligere får stå. Uten dette
    // overskrev en pågående pollings finally 3-sekunderen som start/stopp
    // nettopp hadde planlagt, og statusen hang igjen i opptil ett minutt.
    if (this._pollTimer && this._nextPollAt <= at) return;
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);

    this._nextPollAt = at;
    this._pollTimer = this.homey.setTimeout(() => {
      this._pollTimer = null;
      this.poll().catch((error) => this.error('Uventet feil i polling', error));
    }, Math.max(0, seconds) * 1000);
  }

  async refreshNow() {
    await this.poll();
  }

  async poll() {
    if (this._stopped) return;

    // Oppdater nå-knappen og flow-kortet kan treffe midt i en planlagt
    // henting. To parallelle pollinger leser samme _previous og fyrer
    // flow-triggerne dobbelt, så den som kommer sist får vente.
    if (this._polling) return;
    this._polling = true;

    let nextInterval = this.idleInterval();

    try {
      const data = await this.client().getOperationalData(this._connectorId);
      const values = toCapabilityValues(data);

      await this.applyValues(values);
      this._consecutiveFailures = 0;
      nextInterval = isCharging(values) ? this.chargingInterval() : this.idleInterval();

      if (!this.getAvailable()) await this.setAvailable();
      await this.maybeRefreshEcoMode();
      await this.refreshLocalSettings();
    } catch (error) {
      nextInterval = await this.handleError(error);
    } finally {
      this._polling = false;
      this.schedulePoll(nextInterval);
    }
  }

  async applyValues(values) {
    const previous = this._previous;

    // Første avlesning etter oppstart logges, slik at tilstanden er synlig
    // uten å måtte gjette. Videre pollinger er stille.
    if (!previous) {
      this.log(
        `Første avlesning: status=${values.defa_status}, `
        + `lading=${values.defa_charging_state}, ${values.measure_power} W, `
        + `økt=${values.defa_session_energy} kWh, total=${values.meter_power} kWh`,
      );
    }

    // applied er det vi husker som skrevet. Feiler en skriving, kopieres den
    // gamle verdien tilbake, slik at diffen prøver igjen ved neste polling i
    // stedet for å regne verdien som levert for alltid.
    const applied = { ...values };
    let changed = false;

    for (const [capability, value] of Object.entries(values)) {
      if (value === null || !this.hasCapability(capability)) continue;
      if (previous && previous[capability] === value) continue;

      await this.setCapabilityValue(capability, value)
        .then(() => { changed = true; })
        .catch((error) => {
          applied[capability] = previous ? previous[capability] : null;
          this.error(`Kunne ikke sette ${capability}`, error);
        });
    }

    // Tidsstempelet skrives bare når noe faktisk endret seg, pluss kvartersvis
    // som livstegn. Å skrive det hver polling var appens største kilde til
    // unødvendig lagringsaktivitet på en Homey med lite minne.
    if (changed || Date.now() - this._lastUpdateWrittenAt >= 15 * 60 * 1000) {
      await this.setCapabilityValue('defa_last_update', this.timestamp())
        .then(() => { this._lastUpdateWrittenAt = Date.now(); })
        .catch(() => {});
    }

    this._lastSessionEnergy = nextSessionEnergy(this._lastSessionEnergy, previous, values);

    // Må skje uavhengig av overgangene: restarter appen midt i en ladeøkt,
    // finnes det ingen overgang å henge live-forbruket på.
    await this.ensureLiveConsumption(values);

    // Triggerne fyrer på de faktiske avlesningene; applied styrer bare hva
    // diffen hopper over neste gang.
    await this.fireTriggers(previous, values);
    this._previous = applied;
  }

  async fireTriggers(previous, values) {
    for (const event of detectTransitions(previous, values)) {
      const tokens = event.id === 'defa_charging_stopped'
        ? { session_energy: this._lastSessionEnergy }
        : event.tokens;

      await this.homey.app.triggerDeviceFlow(event.id, this, tokens);
    }
  }

  // Uten dette står powerConsumption på 0 gjennom hele økten.
  async ensureLiveConsumption(values) {
    if (!needsLiveConsumption(this._liveConsumptionStarted, values)) {
      this._liveConsumptionStarted = nextLiveConsumptionState(
        this._liveConsumptionStarted, values, false,
      );
      return;
    }

    let succeeded = false;
    try {
      await this.client().startLiveConsumption(this._connectorId);
      succeeded = true;
      this.log('Live-forbruk startet');
    } catch (error) {
      // Ikke fatalt — vi prøver igjen ved neste polling.
      this.error('Kunne ikke starte live-forbruk', error.message);
    }

    this._liveConsumptionStarted = nextLiveConsumptionState(
      this._liveConsumptionStarted, values, succeeded,
    );
  }

  async handleError(error) {
    this._consecutiveFailures += 1;

    // Et dødt token retter seg ikke av seg selv, så der venter vi ikke på at
    // feilen skal gjenta seg.
    if (error.isAuthError) {
      await this.setUnavailable(this.homey.__('errors.session_expired')).catch(() => {});
      this.error('CloudCharge avviste sesjonen — logg inn på nytt i appinnstillingene', error.message);
      return Math.max(this.idleInterval(), 300);
    }

    this.error(
      `Henting fra CloudCharge feilet (${this._consecutiveFailures} på rad)`,
      error.message,
    );

    if (shouldMarkUnavailable(this._consecutiveFailures)) {
      await this.setUnavailable(this.homey.__('errors.unreachable')).catch(() => {});
    }

    return backoffSeconds(this.idleInterval(), this._consecutiveFailures);
  }

  timestamp() {
    try {
      // Formattereren caches — toLocaleString bygger en ny Intl.DateTimeFormat
      // ved hvert kall, en av de dyrere allokeringene i Node. Og språket
      // følger Homey, ikke en hardkodet norsk locale.
      if (!this._timeFormatter) {
        const locale = this.homey.i18n.getLanguage() === 'no' ? 'nb-NO' : 'en-GB';
        this._timeFormatter = new Intl.DateTimeFormat(locale, {
          timeZone: this.homey.clock.getTimezone(),
          dateStyle: 'short',
          timeStyle: 'medium',
        });
      }
      return this._timeFormatter.format(new Date());
    } catch (error) {
      return new Date().toISOString();
    }
  }

  // --- Styring ------------------------------------------------------------

  // 403 her betyr ikke at sesjonen er død — start og status virker fortsatt.
  // Det betyr at CloudCharge ikke regner ladeøkten som din, noe som skjer når
  // Plug & Charge lot den starte uten autorisasjon.
  async sendChargingCommand(action) {
    if (!this._alias) throw new Error(this.homey.__('errors.missing_alias'));

    try {
      if (action === 'start') await this.client().startCharging(this._alias);
      else await this.client().stopCharging(this._alias);
    } catch (error) {
      this.error(`${action === 'start' ? 'Start' : 'Stopp'} feilet`, error.status || '', error.message);

      if (error.status === 403) {
        throw new Error(this.homey.__(action === 'start'
          ? 'errors.start_forbidden'
          : 'errors.stop_forbidden'));
      }
      throw error;
    }

    this.log(`${action === 'start' ? 'Start' : 'Stopp'} sendt`);
    this.schedulePoll(3);
  }

  startCharging() {
    return this.sendChargingCommand('start');
  }

  stopCharging() {
    return this.sendChargingCommand('stop');
  }

  async maybeRefreshEcoMode() {
    if (!this._ecoSupported) return;
    if (Date.now() - this._ecoRefreshedAt < ECO_REFRESH_INTERVAL_MS) return;

    // Forsøkstidspunkt, ikke suksesstidspunkt. Ellers gjentas et feilende kall
    // på hver eneste polling — og dobler skytrafikken akkurat når API-et
    // allerede sliter.
    this._ecoRefreshedAt = Date.now();

    try {
      const configuration = await this.client().getEcoModeConfiguration(this._connectorId);

      if (configuration && typeof configuration.active === 'boolean') {
        await this.setCapabilityValue('defa_eco_mode', configuration.active).catch(() => {});
      }
    } catch (error) {
      if (error.isUnsupported) {
        this._ecoSupported = false;
        await this.setStoreValue('ecoUnsupported', true).catch(() => {});
        this.log('Laderen støtter ikke eco-modus — slutter å spørre');
        return;
      }
      this.error('Kunne ikke lese eco-modus', error.message);
    }
  }

  // Eco-modus settes ved å sende hele konfigurasjonen tilbake med endret
  // active-flagg, så vi leser den ferskt først.
  async setEcoMode(active) {
    const client = this.client();
    const current = await client.getEcoModeConfiguration(this._connectorId);
    const configuration = { ...(current || {}), active: Boolean(active) };

    await client.setEcoModeConfiguration(this._connectorId, configuration);
    this._ecoRefreshedAt = Date.now();

    await this.setCapabilityValue('defa_eco_mode', Boolean(active)).catch(() => {});
    this.log(`Eco-modus satt til ${active ? 'på' : 'av'}`);
  }

  async overrideSchedule() {
    await this.client().overrideSchedule(this._connectorId);
    this.log('Smartlading overstyrt — lader nå');
    this.schedulePoll(3);
  }

  async resetCharger(type = 'soft') {
    await this.client().reset(this._connectorId, type);
    this.log(`Restart sendt (${type})`);
    this.schedulePoll(15);
  }

  // --- Lokal strømstyring -------------------------------------------------
  //
  // CloudCharge svarer CAPABILITY_NOT_FOUND på /maxcurrent for denne laderen,
  // men laderens egen konfigurator kan sette «Total charging current per
  // phase». Den ligger på LAN-et og krever PIN, så den er valgfri og av som
  // standard.

  async syncLocalControl(settings = this.getSettings()) {
    const enabled = settings.clu_enabled === true;
    const host = String(settings.clu_host || '').trim();
    const pin = String(settings.clu_pin || '').trim();

    // Logges alltid. Uten dette er «av» og «innstillingene kom aldri fram»
    // umulig å skille fra hverandre i loggen.
    this.log(
      `Lokal strømstyring: avkrysset=${enabled}, adresse=${host || '<tom>'}, `
      + `PIN=${pin ? 'satt' : '<tom>'}`,
    );

    if (!enabled || !host || !pin) {
      this._clu = null;

      for (const capability of CLU_CAPABILITIES) {
        if (this.hasCapability(capability)) {
          await this.removeCapability(capability)
            .catch((error) => this.error(`Kunne ikke fjerne ${capability}`, error));
        }
      }

      if (enabled) this.log('Lokal strømstyring er på, men mangler adresse eller PIN');
      return;
    }

    // Peker innstillingene på en annen lader enn sist, må referansene læres på
    // nytt — ellers blokkerer skrivevakten alt (config_changed mot feil
    // anlegg), eller Plug & Charge treffer feil ladepunkt.
    const lastHost = this.getStoreValue('cluHost');
    if (lastHost && lastHost !== host) {
      this.log(`CLU-adressen endret (${lastHost} → ${host}) — nullstiller installasjonsreferansen`);
      await this.unsetStoreValue('cluBaseline').catch(() => {});
      await this.unsetStoreValue('cluAddress').catch(() => {});
    }
    await this.setStoreValue('cluHost', host).catch(() => {});

    this._clu = new CluClient({ host, pin, log: (...args) => this.log('[clu]', ...args) });

    for (const capability of CLU_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        this.log(`Legger til kapabilitet ${capability}`);
        await this.addCapability(capability)
          .catch((error) => this.error(`Kunne ikke legge til ${capability}`, error.message));
      }
    }

    this.log(`Kapabiliteter nå: ${this.getCapabilities().join(', ')}`);

    // Lytterne registreres bare én gang, uansett hvor mange ganger
    // innstillingene endres.
    if (!this._cluListenerRegistered) {
      const listeners = {
        defa_charge_current: (v) => this.setChargeCurrent(v),
        defa_plug_and_charge: (v) => this.setPlugAndCharge(v),
        defa_charge_offline: (v) => this.setChargeOffline(v),
      };

      // registerCapabilityListener kaster hvis kapabiliteten ikke finnes på
      // enheten. Uten denne fangsten ville én manglende kapabilitet stoppet
      // resten av oppsettet uten spor i loggen.
      for (const [capability, listener] of Object.entries(listeners)) {
        try {
          this.registerCapabilityListener(capability, listener);
        } catch (error) {
          this.error(`Kunne ikke registrere lytter for ${capability}`, error.message);
        }
      }

      this._cluListenerRegistered = true;
    }

    this.log(`Lokal strømstyring aktiv mot ${host}`);
    this._cluRefreshedAt = 0;
    await this.refreshLocalSettings(true);
  }

  // Hvilket ladepunkt i CLU-konfigurasjonen som er vårt. Med bare ett er svaret
  // opplagt, og da lagres adressen ved første lesing.
  cluAddress() {
    const stored = this.getStoreValue('cluAddress');
    return stored === undefined ? null : stored;
  }

  async refreshLocalSettings(force = false) {
    if (!this._clu || !this.hasCapability('defa_charge_current')) return;
    if (!force && Date.now() - this._cluRefreshedAt < CLU_REFRESH_INTERVAL_MS) return;

    // Forsøkstidspunkt, ikke suksesstidspunkt: en død CLU skal koste én
    // timeout per kvarter, ikke ett 15-sekunders stall på hver polling.
    this._cluRefreshedAt = Date.now();

    // Fullfører en skriving mens denne lesingen er underveis, er dataene
    // våre foreldet i det de ankommer — da forkastes de i stedet for å
    // overskrive den ferske verdien brukeren nettopp satte.
    const seqAtStart = this._cluWriteSeq;

    try {
      const config = await this._clu.getConfig();
      if (seqAtStart !== this._cluWriteSeq) return;

      // Skyveknappen skal ikke tilby mer enn anlegget tåler.
      const limits = resolveCurrentLimits(config);
      await this.setCapabilityOptions('defa_charge_current', { min: limits.min, max: limits.max })
        .catch(() => {});

      // Referansen skrivevakten sammenligner mot, satt første gang vi leser en
      // fullstendig konfigurasjon.
      if (!this.getStoreValue('cluBaseline') && config && config.distNetType) {
        await this.setStoreValue('cluBaseline', {
          distNetType: config.distNetType,
          chargePointType: config.chargePointType,
          homeFuseSize: config.homeFuseSize,
          connector1Phase: config.connector1Phase,
        }).catch(() => {});
        this.log('Lagret installasjonsreferanse for skrivevakten');
      }

      if (this.cluAddress() === null
        && Array.isArray(config.connectors) && config.connectors.length === 1) {
        await this.setStoreValue('cluAddress', config.connectors[0].address).catch(() => {});
      }

      const amps = currentFromConfig(config);
      const plugAndCharge = plugAndChargeFromConfig(config, this.cluAddress());
      const offline = chargeOfflineFromConfig(config);

      // Logges bare når noe faktisk er annerledes — ikke 96 ganger i døgnet.
      const snapshot = `strøm=${amps} A, Plug & Charge=${plugAndCharge}, `
        + `offline=${offline}, address=${this.cluAddress()}`;
      if (snapshot !== this._cluSnapshot) {
        this.log(`Lest fra laderen: ${snapshot}`);
        this._cluSnapshot = snapshot;
      }

      // Skrives bare ved endring; feil logges, for ellers er «kapabiliteten
      // mangler» og «verdien er null» umulig å skille fra hverandre.
      const setIfChanged = (capability, value) => {
        if (value === null || this.getCapabilityValue(capability) === value) return Promise.resolve();
        return this.setCapabilityValue(capability, value)
          .catch((error) => this.error(`Kunne ikke sette ${capability}`, error.message));
      };

      await setIfChanged('defa_charge_current', amps);
      await setIfChanged('defa_plug_and_charge', plugAndCharge);
      await setIfChanged('defa_charge_offline', offline);
    } catch (error) {
      this.error('Kunne ikke lese innstillinger fra laderen', error.message);
    }
  }

  writeOptions() {
    return { expected: this.getStoreValue('cluBaseline') || null };
  }

  async setChargeCurrent(amps) {
    if (!this._clu) throw new Error(this.homey.__('errors.local_disabled'));

    const result = await this._clu.setChargeCurrent(Math.round(Number(amps)), this.writeOptions());

    this._cluWriteSeq += 1;
    this._cluRefreshedAt = Date.now();
    await this.setCapabilityValue('defa_charge_current', result.amps).catch(() => {});

    if (result.changed) this.log(`Ladestrøm satt til ${result.amps} A`);
    return result;
  }

  // Gratis lading uten autorisasjon. Logges tydelig — dette er ikke en
  // innstilling man vil oppdage at står på.
  async setPlugAndCharge(enabled) {
    if (!this._clu) throw new Error(this.homey.__('errors.local_disabled'));

    const result = await this._clu.setPlugAndCharge(
      this.cluAddress(), Boolean(enabled), this.writeOptions(),
    );

    this._cluWriteSeq += 1;
    this._cluRefreshedAt = Date.now();
    await this.setCapabilityValue('defa_plug_and_charge', result.enabled).catch(() => {});

    if (result.changed) {
      this.log(`Plug & Charge satt til ${result.enabled ? 'PÅ — lading er nå gratis og uten autorisasjon' : 'av'}`);
    }
    return result;
  }

  async setChargeOffline(enabled) {
    if (!this._clu) throw new Error(this.homey.__('errors.local_disabled'));

    const result = await this._clu.setChargeOffline(Boolean(enabled), this.writeOptions());

    this._cluWriteSeq += 1;
    this._cluRefreshedAt = Date.now();
    await this.setCapabilityValue('defa_charge_offline', result.enabled).catch(() => {});

    if (result.changed) this.log(`Offline-lading satt til ${result.enabled ? 'på' : 'av'}`);
    return result;
  }
}

module.exports = DefaChargerDevice;
