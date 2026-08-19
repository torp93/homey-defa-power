'use strict';

const Homey = require('homey');
const {
  toCapabilityValues,
  isCharging,
  isOperationalData,
  currentAlternatives,
  currentFromChargePoint,
} = require('../../lib/connector-state');
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

// Plug & Charge og offline-lading finnes bare i laderens egen konfigurator.
// Ladestrøm derimot kan noen ladere sette gjennom skyen, så den kapabiliteten
// har to mulige eiere og skal ikke fjernes bare fordi CLU-en er av.
const CLU_ONLY_CAPABILITIES = ['defa_plug_and_charge', 'defa_charge_offline'];

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
    this._dateFormatter = null;
    this._ecoRefreshedAt = 0;
    this._ecoWriteSeq = 0;
    // «Støttes ikke» huskes over restarter — OOM-killeren restarter appen
    // ofte nok til at det ellers koster ett bortkastet skykall hver gang.
    this._ecoSupported = this.getStoreValue('ecoUnsupported') !== true;
    this._clu = null;
    this._cluLimits = null;
    this._cluRefreshedAt = 0;
    this._cluWriteSeq = 0;
    this._cluSnapshot = null;
    this._cluListenerRegistered = false;
    this._currentListenerRegistered = false;
    this._cloudCurrent = null;
    this._cloudCurrentRefreshedAt = 0;
    // Som eco: «støttes ikke» huskes over restarter, så vi slipper ett
    // bortkastet skykall hver gang appen starter.
    this._cloudCurrentSupported = this.getStoreValue('cloudCurrentUnsupported') !== true;

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

      // Et 200-svar uten brukbar kropp er ikke en tilstand — det er en feil.
      // Behandles den som tilstand, melder laderen «frakoblet, ingen feil» og
      // fyrer flow-triggere midt i en pågående ladeøkt.
      if (!isOperationalData(data)) {
        throw new Error(`CloudCharge svarte 200 uten brukbare data (${typeof data})`);
      }

      const values = toCapabilityValues(data);

      await this.applyValues(values);
      this._consecutiveFailures = 0;
      nextInterval = isCharging(values) ? this.chargingInterval() : this.idleInterval();

      if (!this.getAvailable()) await this.setAvailable();
      await this.maybeRefreshEcoMode();
      await this.refreshLocalSettings();
      await this.syncCloudCurrent();
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
      // null betyr «laderen sa ingenting om dette». Da skrives ingenting, men
      // den forrige verdien må bæres videre i applied — ellers glemmer
      // _previous tilstanden, og neste ekte endring ser ut som ingen endring.
      // Konkret: en feilkode som forsvant ut av ett svar gjorde at
      // «feilen er borte» aldri fyrte når laderen etterpå meldte NoError.
      if (value === null) {
        applied[capability] = previous ? previous[capability] : null;
        continue;
      }

      if (!this.hasCapability(capability)) continue;
      if (previous && previous[capability] === value) continue;

      // Rå API-strenger skal ikke vises i norsk UI. Diffing og flow-tokens
      // bruker fortsatt råverdien, så feilkoden er intakt for diagnostikk.
      const shown = capability === 'defa_error_code' ? this.errorCodeText(value) : value;

      await this.setCapabilityValue(capability, shown)
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

  // Setter en av/på-kapabilitet og fyrer tilhørende trigger hvis verdien
  // faktisk endret seg. Brukes for innstillinger som også kan endres fra
  // DEFA-appen eller laderen — da skal Homey-flowen fyre selv om endringen
  // ikke kom herfra.
  async applyToggle(capability, triggerId, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;

    const before = this.getCapabilityValue(capability);
    if (before === value) return;

    await this.setCapabilityValue(capability, value)
      .catch((error) => this.error(`Kunne ikke sette ${capability}`, error.message));

    // Første avlesning etter oppstart er ikke en endring brukeren gjorde.
    if (before === null || before === undefined) return;

    await this.homey.app.triggerDeviceFlow(triggerId, this, { enabled: value });
  }

  // «NoError» er en API-verdi, ikke noe en bruker skal lese. Ekte feilkoder
  // vises derimot som de er — de er det support trenger.
  errorCodeText(code) {
    if (!code || code === 'NoError') return this.homey.__('status.no_error');
    return code;
  }

  // Svaret på flow-betingelsen «laderen har feil».
  //
  // Må leses fra råverdien, ikke fra kapabiliteten: kapabiliteten inneholder
  // den oversatte teksten fra errorCodeText(), så en sammenligning mot 'NoError'
  // traff aldri. Betingelsen svarte derfor SANT alltid — også på en feilfri
  // lader — og enhver flow bygget på den var permanent gal.
  hasActiveError() {
    const raw = this._previous && this._previous.defa_error_code;
    if (typeof raw === 'string') return raw !== '' && raw !== 'NoError';

    // Før første avlesning finnes ingen _previous. Da er den viste teksten det
    // eneste vi har, og den sammenlignes mot den oversatte «ingen feil».
    const shown = this.getCapabilityValue('defa_error_code');
    if (typeof shown !== 'string' || shown === '') return false;
    return shown !== this.homey.__('status.no_error') && shown !== 'NoError';
  }

  timestamp() {
    try {
      // Formatterne caches — Intl.DateTimeFormat er en av de dyrere
      // allokeringene i Node, og dette kjører ved hver endring. Språket følger
      // Homey, ikke en hardkodet norsk locale.
      //
      // «18. aug, 20:32». Dato og klokkeslett formatteres hver for seg, fordi
      // Intl ellers setter inn sitt eget skilletegn og gir «18. aug., 20:32»
      // med punktum og komma rett etter hverandre. Punktumet i den norske
      // månedsforkortelsen fjernes, siden kommaet tar den rollen her.
      if (!this._dateFormatter) {
        const locale = this.homey.i18n.getLanguage() === 'no' ? 'nb-NO' : 'en-GB';
        const timeZone = this.homey.clock.getTimezone();

        this._dateFormatter = new Intl.DateTimeFormat(locale, {
          timeZone,
          day: 'numeric',
          month: 'short',
        });
        this._timeFormatter = new Intl.DateTimeFormat(locale, {
          timeZone,
          hour: '2-digit',
          minute: '2-digit',
        });
      }

      const now = new Date();
      const date = this._dateFormatter.format(now).replace(/\.$/, '');

      return `${date}, ${this._timeFormatter.format(now)}`;
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
    const seqAtStart = this._ecoWriteSeq;

    try {
      const configuration = await this.client().getEcoModeConfiguration(this._connectorId);

      // Rakk brukeren å skrive mens denne lesingen var underveis, er svaret
      // foreldet i det det ankommer. Samme vakt som _cluWriteSeq.
      if (seqAtStart !== this._ecoWriteSeq) return;

      if (configuration && typeof configuration.active === 'boolean') {
        await this.applyToggle('defa_eco_mode', 'defa_eco_mode_changed', configuration.active);
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

    // Samme vakt som CLU-skrivingene har: vi sender hele konfigurasjonen
    // tilbake, så vi må ha lest en fullstendig konfigurasjon først. Et 200-svar
    // med tom kropp ga {active:true} alene og slettet tidsplanene; et svar som
    // ikke var JSON ble spredd til indekserte tegnnøkler og sendt som
    // konfigurasjon. Å nekte er alltid riktigere enn å skrive noe vi ikke leste.
    //
    // active må være en boolean: det er feltet vi endrer, og mangler det, har
    // vi ikke lest en eco-konfigurasjon — bare et objekt. Samme predikat som
    // maybeRefreshEcoMode() bruker for å tro på en lesing.
    if (!isOperationalData(current) || typeof current.active !== 'boolean') {
      throw new Error(this.homey.__('errors.eco_read_failed'));
    }

    const configuration = { ...current, active: Boolean(active) };

    await client.setEcoModeConfiguration(this._connectorId, configuration);

    // Etter en skriving skal en lesing som alt var underveis ikke få lov til å
    // sette verdien tilbake og fyre «eco-modus endret» på et gammelt svar.
    this._ecoWriteSeq += 1;
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

      // defa_charge_current er ikke med her: klarer skyen å sette ladestrøm,
      // skal skyveknappen bli stående selv om den lokale styringen er av.
      // syncCloudCurrent() avgjør skjebnen dens.
      for (const capability of CLU_ONLY_CAPABILITIES) {
        if (this.hasCapability(capability)) {
          await this.removeCapability(capability)
            .catch((error) => this.error(`Kunne ikke fjerne ${capability}`, error));
        }
      }

      // Lytterne forsvinner med kapabilitetene. Uten dette ble flagget stående
      // på true, og slo brukeren lokal styring av og på igjen, var skyveknappen
      // der — men uten lytter, så ingenting skjedde når man dro i den.
      this._cluListenerRegistered = false;

      if (enabled) this.log('Lokal strømstyring er på, men mangler adresse eller PIN');

      // Uten CLU er skyen eneste mulige kilde til ladestrøm.
      this._cloudCurrentRefreshedAt = 0;
      await this.syncCloudCurrent();
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

    this.registerCurrentListener();
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

      // Skyveknappen skal ikke tilby mer enn anlegget tåler. Grensene tas vare
      // på, slik at et Flow-kort som sender en for høy verdi kan si nøyaktig
      // hva denne installasjonen tillater.
      const limits = resolveCurrentLimits(config);
      this._cluLimits = limits;
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

      // Sjekkes på nytt her: mellom lesingen over og skrivingene under ligger
      // flere await, og en skriving som fullførte i mellomtiden ville ellers
      // blitt overskrevet av verdiene vi leste før den.
      if (seqAtStart !== this._cluWriteSeq) return;

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
      if (amps !== null && this.getCapabilityValue('defa_charge_current') !== amps) {
        await this.setCapabilityValue('defa_charge_current', amps)
          .catch((error) => this.error('Kunne ikke sette defa_charge_current', error.message));
      }

      await this.applyToggle('defa_plug_and_charge', 'defa_plug_and_charge_changed', plugAndCharge);
      await this.applyToggle('defa_charge_offline', 'defa_charge_offline_changed', offline);
    } catch (error) {
      this.error('Kunne ikke lese innstillinger fra laderen', error.message);
    }
  }

  // --- Ladestrøm gjennom skyen -------------------------------------------
  //
  // Enkelte ladere kan sette ladestrøm via CloudCharge. Da trenger brukeren
  // hverken IP-adresse eller PIN, og skyveknappen virker rett etter paring.
  // Din egen lader svarer CAPABILITY_NOT_FOUND, og faller tilbake på CLU-en.

  async syncCloudCurrent() {
    // CLU-en eier ladestrømmen når den er satt opp — den er mer direkte, og
    // brukeren har eksplisitt konfigurert den.
    if (this._clu) return;

    if (!this._cloudCurrentSupported) {
      this._cloudCurrent = null;
      if (this.hasCapability('defa_charge_current')) {
        await this.removeCapability('defa_charge_current')
          .catch((error) => this.error('Kunne ikke fjerne defa_charge_current', error.message));
      }
      return;
    }

    if (Date.now() - this._cloudCurrentRefreshedAt < CLU_REFRESH_INTERVAL_MS) return;

    // Forsøkstidspunkt, ikke suksesstidspunkt — samme grunn som eco og CLU.
    this._cloudCurrentRefreshedAt = Date.now();

    let limits;
    try {
      limits = currentAlternatives(
        await this.client().getMaxCurrentAlternatives(this._connectorId),
      );
    } catch (error) {
      if (error.isUnsupported) {
        this._cloudCurrentSupported = false;
        this._cloudCurrent = null;
        await this.setStoreValue('cloudCurrentUnsupported', true).catch(() => {});
        this.log('Laderen kan ikke sette ladestrøm gjennom skyen — bruker lokal styring hvis den er satt opp');
        await this.syncCloudCurrent();
        return;
      }
      this.error('Kunne ikke lese ladestrømalternativer', error.message);
      return;
    }

    if (!limits) {
      this.error('Ladestrømalternativer kom tomme — hopper over');
      return;
    }

    this._cloudCurrent = limits;

    if (!this.hasCapability('defa_charge_current')) {
      this.log('Legger til defa_charge_current (styres gjennom skyen)');
      await this.addCapability('defa_charge_current')
        .catch((error) => this.error('Kunne ikke legge til defa_charge_current', error.message));
    }

    await this.setCapabilityOptions('defa_charge_current', { min: limits.min, max: limits.max })
      .catch(() => {});
    this.registerCurrentListener();

    // Gjeldende verdi ligger på ladepunktet, ikke i /operationaldata.
    const chargePointId = this.getStoreValue('chargePointId');
    if (!chargePointId) return;

    try {
      const amps = currentFromChargePoint(
        await this.client().getChargePoint(chargePointId), this._connectorId,
      );

      if (amps !== null && this.getCapabilityValue('defa_charge_current') !== amps) {
        await this.setCapabilityValue('defa_charge_current', amps)
          .catch((error) => this.error('Kunne ikke sette defa_charge_current', error.message));
      }
    } catch (error) {
      this.error('Kunne ikke lese gjeldende ladestrøm fra ladepunktet', error.message);
    }
  }

  // Lytteren registreres én gang, uansett hvilken kilde som eier verdien.
  registerCurrentListener() {
    if (this._currentListenerRegistered) return;
    try {
      this.registerCapabilityListener('defa_charge_current', (value) => this.setChargeCurrent(value));
      this._currentListenerRegistered = true;
    } catch (error) {
      this.error('Kunne ikke registrere lytter for defa_charge_current', error.message);
    }
  }

  async setChargeCurrentCloud(amps) {
    const limits = this._cloudCurrent;
    const requested = Math.round(Number(amps));

    if (!Number.isFinite(requested)) {
      throw new Error(this.homey.__('errors.current_not_integer'));
    }

    if (limits && (requested < limits.min || requested > limits.max)) {
      throw new Error(this.homey.__('errors.current_out_of_range', {
        min: limits.min, max: limits.max,
      }));
    }

    await this.client().setMaxCurrent(this._connectorId, requested);
    await this.setCapabilityValue('defa_charge_current', requested).catch(() => {});
    this.log(`Ladestrøm satt til ${requested} A gjennom skyen`);

    return { changed: true, amps: requested };
  }

  writeOptions() {
    return { expected: this.getStoreValue('cluBaseline') || null };
  }

  // Feilene fra lib/ er engelskfrie koder med detaljer; her får de en
  // lokalisert tekst brukeren forstår. Originalfeilen logges uendret, slik at
  // support fortsatt ser den faktiske årsaken.
  localizeCluError(error, context) {
    const code = error && error.code;
    this.error(`Lokal styring feilet (${context})`, code || '', error && error.message);

    const keys = {
      out_of_range: 'errors.current_out_of_range',
      not_integer: 'errors.current_not_integer',
      incomplete_config: 'errors.clu_incomplete_config',
      config_changed: 'errors.clu_config_changed',
      ambiguous_connector: 'errors.clu_ambiguous_connector',
      connector_not_found: 'errors.clu_ambiguous_connector',
      bad_pin: 'errors.clu_bad_pin',
      no_cookie: 'errors.clu_bad_pin',
      no_host: 'errors.clu_unreachable',
      invalid_json: 'errors.clu_unreachable',
      unreachable: 'errors.clu_unreachable',
      write_uncertain: 'errors.clu_write_uncertain',
      no_pin: 'errors.clu_bad_pin',
      // Ikke clu_unreachable: en HTTP-feil betyr at vi NÅDDE laderen og den
      // svarte. Å be brukeren sjekke IP-adressen ville vært direkte feilaktig.
      http_error: 'errors.clu_refused',
    };

    const key = keys[code];
    if (!key) return error;

    if (code === 'out_of_range') {
      const limits = this._cluLimits || {};
      return new Error(this.homey.__(key, {
        min: limits.min === undefined ? 7 : limits.min,
        max: limits.max === undefined ? 32 : limits.max,
      }));
    }

    return new Error(this.homey.__(key));
  }

  // Én inngang for både kapabiliteten og Flow-kortet. Hvilken vei den går,
  // avhenger av hva denne laderen faktisk støtter.
  async setChargeCurrent(amps) {
    if (this._clu) return this.setChargeCurrentLocal(amps);
    if (this._cloudCurrent) return this.setChargeCurrentCloud(amps);
    throw new Error(this.homey.__('errors.local_disabled'));
  }

  async setChargeCurrentLocal(amps) {
    if (!this._clu) throw new Error(this.homey.__('errors.local_disabled'));

    let result;
    try {
      result = await this._clu.setChargeCurrent(Math.round(Number(amps)), this.writeOptions());
    } catch (error) {
      throw this.localizeCluError(error, 'ladestrøm');
    }

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

    let result;
    try {
      result = await this._clu.setPlugAndCharge(
        this.cluAddress(), Boolean(enabled), this.writeOptions(),
      );
    } catch (error) {
      throw this.localizeCluError(error, 'Plug & Charge');
    }

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

    let result;
    try {
      result = await this._clu.setChargeOffline(Boolean(enabled), this.writeOptions());
    } catch (error) {
      throw this.localizeCluError(error, 'offline-lading');
    }

    this._cluWriteSeq += 1;
    this._cluRefreshedAt = Date.now();
    await this.setCapabilityValue('defa_charge_offline', result.enabled).catch(() => {});

    if (result.changed) this.log(`Offline-lading satt til ${result.enabled ? 'på' : 'av'}`);
    return result;
  }
}

module.exports = DefaChargerDevice;
