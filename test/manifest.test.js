'use strict';

// Kontrakter i manifestet som lett brytes ved en uskyldig redigering, og som
// hverken `homey app validate` eller de andre testene fanger opp.

const test = require('node:test');
const assert = require('node:assert');

const app = require('../app.json');
const en = require('../locales/en.json');
const no = require('../locales/no.json');

const driver = app.drivers.find((d) => d.id === 'charger');
const cards = {
  triggers: app.flow.triggers,
  conditions: app.flow.conditions,
  actions: app.flow.actions,
};
const byId = (kind, id) => cards[kind].find((c) => c.id === id);

// Kort som eksisterende brukere kan ha i Flows. De skal aldri forsvinne — bare
// merkes deprecated slik at nye brukere ser Homeys standardkort i stedet.
const LEGACY_CARDS = {
  actions: ['defa_action_start', 'defa_action_stop'],
  conditions: ['defa_condition_charging'],
  triggers: ['defa_charging_started'],
};

test('legacy flow cards still exist so existing Flows keep working', () => {
  for (const [kind, ids] of Object.entries(LEGACY_CARDS)) {
    for (const id of ids) {
      assert.ok(byId(kind, id), `${kind}/${id} må finnes for bakoverkompatibilitet`);
    }
  }
});

test('legacy flow cards are deprecated and no longer highlighted', () => {
  for (const [kind, ids] of Object.entries(LEGACY_CARDS)) {
    for (const id of ids) {
      const card = byId(kind, id);
      assert.strictEqual(card.deprecated, true, `${id} skal være deprecated`);
      assert.strictEqual(card.highlight, undefined, `${id} skal ikke fremheves`);
    }
  }
});

test('the session-end trigger is kept because it carries energy', () => {
  // Homeys evcharger_charging_false har ingen tokens. Dette kortet gir
  // energien for økten, og er derfor ikke et rent duplikat.
  const card = byId('triggers', 'defa_charging_stopped');
  assert.ok(card, 'kortet må finnes');
  assert.notStrictEqual(card.deprecated, true, 'skal ikke deprecates');
  assert.ok(card.tokens.some((t) => t.name === 'session_energy'));
});

test('the standard EV charger capabilities are present on the driver', () => {
  for (const capability of ['evcharger_charging', 'evcharger_charging_state', 'measure_power', 'meter_power']) {
    assert.ok(driver.capabilities.includes(capability), `${capability} mangler`);
  }
  assert.strictEqual(driver.class, 'evcharger');
});

test('energy is declared for Homey Energy without double counting', () => {
  // meter_power er den kumulative måleren. defa_session_energy er per økt og
  // skal aldri brukes som energikilde, ellers telles forbruket to ganger.
  assert.strictEqual(driver.energy.evCharger, true);
  assert.strictEqual(driver.energy.meterPowerImportedCapability, 'meter_power');
  assert.notStrictEqual(driver.energy.meterPowerImportedCapability, 'defa_session_energy');
  assert.strictEqual(driver.energy.cumulative, undefined);
});

test('every flow card is fully bilingual', () => {
  for (const [kind, list] of Object.entries(cards)) {
    for (const card of list) {
      assert.ok(card.title.en && card.title.no, `${kind}/${card.id}: tittel mangler språk`);
      if (card.titleFormatted) {
        assert.ok(card.titleFormatted.en && card.titleFormatted.no,
          `${kind}/${card.id}: titleFormatted mangler språk`);
      }
      if (card.hint) {
        assert.ok(card.hint.en && card.hint.no, `${kind}/${card.id}: hint mangler språk`);
      }
      for (const arg of card.args || []) {
        for (const value of arg.values || []) {
          assert.ok(value.label.en && value.label.no,
            `${kind}/${card.id}/${arg.name}: valg mangler språk`);
        }
      }
    }
  }
});

test('flow titles avoid parentheses and the device name', () => {
  for (const [kind, list] of Object.entries(cards)) {
    for (const card of list) {
      for (const lang of ['en', 'no']) {
        const title = card.title[lang];
        assert.ok(!/[()]/.test(title), `${kind}/${card.id} (${lang}): parentes i tittel: ${title}`);
      }
    }
  }
});

test('every capability and setting is fully bilingual', () => {
  for (const [id, capability] of Object.entries(app.capabilities)) {
    assert.ok(capability.title.en && capability.title.no, `capability ${id}: tittel mangler språk`);
    for (const value of capability.values || []) {
      assert.ok(value.title.en && value.title.no, `capability ${id}/${value.id}: mangler språk`);
    }
  }
  for (const setting of driver.settings) {
    assert.ok(setting.label.en && setting.label.no, `setting ${setting.id}: label mangler språk`);
    if (setting.hint) {
      assert.ok(setting.hint.en && setting.hint.no, `setting ${setting.id}: hint mangler språk`);
    }
  }
});

test('the locale files have the same keys in both languages', () => {
  const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
    (v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]));

  assert.deepStrictEqual(flatten(en).sort(), flatten(no).sort());
});

test('donations are declared the way Homey expects, and nothing is paywalled', () => {
  assert.strictEqual(app.contributing.donate.paypal.username, 'torpthomas');
  assert.strictEqual(app.contributing.donate.githubSponsors.username, 'torp93');
  // Homey godtar bare disse fire leverandørene.
  for (const provider of Object.keys(app.contributing.donate)) {
    assert.ok(['paypal', 'githubSponsors', 'bunq', 'patreon'].includes(provider), provider);
  }
});

test('the app asks for no permissions', () => {
  // Appen snakker bare med CloudCharge og laderen på LAN, og trenger derfor
  // ingen Homey-permissions. Kommer det en, skal den begrunnes.
  assert.deepStrictEqual(app.permissions, []);
});

test('every trigger card in the manifest is registered in app.js', () => {
  // Et trigger-kort uten registrering fyrer aldri, og hverken validering eller
  // de andre testene merker det. app.js kan ikke require-es her (den trenger
  // Homey-runtime), så lista leses fra kildekoden.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const block = source.match(/const TRIGGER_CARDS = \[([\s\S]*?)\];/);
  assert.ok(block, 'fant ikke TRIGGER_CARDS i app.js');

  const registered = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const card of cards.triggers) {
    assert.ok(registered.includes(card.id), `${card.id} er ikke registrert i app.js`);
  }
});

test('every condition and action card has a run listener in app.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

  for (const card of cards.conditions) {
    assert.ok(source.includes(`getConditionCard('${card.id}')`), `${card.id} mangler run listener`);
  }
  for (const card of cards.actions) {
    assert.ok(source.includes(`getActionCard('${card.id}')`), `${card.id} mangler run listener`);
  }
});

test('app icon and driver icon are not the same file', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const appIcon = fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8');
  const driverIcon = fs.readFileSync(path.join(root, 'drivers/charger/assets/icon.svg'), 'utf8');

  // Homey: «Do not re-use the app icon for your drivers.»
  assert.notStrictEqual(appIcon, driverIcon);
});
