'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  TOTAL_MIN_AMPS,
  CONNECTOR_MIN_AMPS,
  CluConfigError,
  parseFuseSize,
  isUsableConfig,
  resolveCurrentLimits,
  currentFromConfig,
  applyCurrent,
  assertMatchesExpected,
} = require('../lib/clu-current');

// Faktisk svar fra /get-homeCLU på laderen, 2026-08-09.
const CONFIG = {
  connectors: [
    {
      address: 1,
      energyMeter: true,
      maxCurrent: '32',
      rfid: true,
      rfidGroup: 'None',
      evccType: 'Gen2',
      isFree: true,
      priority: true,
    },
  ],
  distNetType: 'IT',
  chargePointType: 'Single-phase only',
  homeFuseSize: '63A',
  connector1Phase: 'L1-L2',
  homeCluSensor: 'None',
  maxTotalChargeCurrent: '32',
  chargeOffline: false,
};

test('parseFuseSize reads the number out of the label', () => {
  assert.strictEqual(parseFuseSize('63A'), 63);
  assert.strictEqual(parseFuseSize('100A'), 100);
  assert.strictEqual(parseFuseSize(''), null);
  assert.strictEqual(parseFuseSize(null), null);
});

test('resolveCurrentLimits is capped by the connector, not just the fuse', () => {
  // Hovedsikringen er 63 A, men ladepunktet tåler 32 A. Å tilby 63 A i Homey
  // ville vært en løgn — det gir ingen effekt.
  const limits = resolveCurrentLimits(CONFIG, 32);
  // Gulvet er 6, ikke 7: under totalfeltets minimum styres connector-feltet.
  assert.strictEqual(limits.min, CONNECTOR_MIN_AMPS);
  assert.strictEqual(limits.max, 32);
  assert.strictEqual(limits.fuse, 63);
  assert.strictEqual(limits.connectorMax, 32);
});

test('resolveCurrentLimits follows a smaller fuse when that is the tighter bound', () => {
  const limits = resolveCurrentLimits({ ...CONFIG, homeFuseSize: '20A' });
  assert.strictEqual(limits.max, 20);
});

test('resolveCurrentLimits uses the lowest connector when several exist', () => {
  const limits = resolveCurrentLimits({
    ...CONFIG,
    connectors: [{ maxCurrent: '32' }, { maxCurrent: '16' }],
  });
  assert.strictEqual(limits.max, 16);
});

test('currentFromConfig reads the value the CLU reports as a string', () => {
  assert.strictEqual(currentFromConfig(CONFIG), 32);
  assert.strictEqual(currentFromConfig({}), null);
});

test('isUsableConfig demands the installation parameters', () => {
  assert.ok(isUsableConfig(CONFIG));
  assert.ok(!isUsableConfig(null));
  assert.ok(!isUsableConfig({}));
  assert.ok(!isUsableConfig({ ...CONFIG, connectors: [] }));
  assert.ok(!isUsableConfig({ ...CONFIG, distNetType: undefined }));
});

test('applyCurrent changes only the charging current', () => {
  // Installasjonsparameterne skal aldri røres. Fra og med 6 A-støtten skrives
  // connectors[].maxCurrent også — men KUN det feltet; resten av
  // connector-blokka må stå nøyaktig som den var.
  const next = applyCurrent(CONFIG, 10);

  assert.strictEqual(next.maxTotalChargeCurrent, 10);
  assert.strictEqual(next.distNetType, 'IT');
  assert.strictEqual(next.homeFuseSize, '63A');
  assert.strictEqual(next.connector1Phase, 'L1-L2');
  assert.strictEqual(next.chargePointType, 'Single-phase only');

  assert.strictEqual(next.connectors.length, CONFIG.connectors.length);
  next.connectors.forEach((connector, i) => {
    const { maxCurrent, ...resten } = connector;
    const { maxCurrent: _, ...forventet } = CONFIG.connectors[i];
    assert.deepStrictEqual(resten, forventet, 'kun maxCurrent skal endres');
  });
});

test('6 A is reached through the connector field, not the total', () => {
  // Totalfeltet nekter under 7 A. Connector-feltet gar til 6, og effektiv
  // strom er den laveste av de to — det er hele veien under 7.
  const next = applyCurrent(CONFIG, 6, 32);

  assert.strictEqual(next.maxTotalChargeCurrent, CONFIG.maxTotalChargeCurrent,
    'totalfeltet skal sta urort under 7 A');
  assert.strictEqual(next.connectors[0].maxCurrent, 6);
  assert.strictEqual(currentFromConfig(next), 6, 'effektiv strom');
});

test('going back above 7 A restores the connector ceiling', () => {
  // Uten dette ville en tidligere 6 A-skriving holdt strommen nede for alltid.
  const etter6 = applyCurrent(CONFIG, 6, 32);
  const tilbake = applyCurrent(etter6, 16, 32);

  assert.strictEqual(tilbake.maxTotalChargeCurrent, 16);
  assert.strictEqual(tilbake.connectors[0].maxCurrent, 32, 'taket gjenopprettes');
  assert.strictEqual(currentFromConfig(tilbake), 16);
});

test('the connector field is never raised above the installer ceiling', () => {
  // Star den pa 16 fordi kabelen taler 16, skal ingen flow kunne gjore den
  // til 32. Dette er den viktigste vakten i hele 6 A-stotten.
  const kabel = { ...CONFIG, connectors: [{ ...CONFIG.connectors[0], maxCurrent: 16 }] };

  assert.throws(() => applyCurrent(kabel, 32, 16), (e) => e.code === 'out_of_range');

  const satt = applyCurrent(kabel, 16, 16);
  assert.strictEqual(satt.connectors[0].maxCurrent, 16);

  // Og selv om taket leses fra en konfigurasjon som alt er senket til 6,
  // skal det lagrede taket vinne — ikke den senkede verdien.
  const senket = { ...CONFIG, connectors: [{ ...CONFIG.connectors[0], maxCurrent: 6 }] };
  assert.strictEqual(applyCurrent(senket, 16, 16).connectors[0].maxCurrent, 16);
});

test('applyCurrent sends a number, matching the configurator', () => {
  assert.strictEqual(typeof applyCurrent(CONFIG, 16).maxTotalChargeCurrent, 'number');
});

test('applyCurrent refuses to write an incomplete config', () => {
  // Dette er vakten som hindrer at en halvlest konfigurasjon skriver bort
  // nettype eller sikringsstørrelse.
  assert.throws(
    () => applyCurrent({ maxTotalChargeCurrent: '32' }, 10),
    (error) => error instanceof CluConfigError && error.code === 'incomplete_config',
  );
});

test('applyCurrent enforces the schema bounds', () => {
  assert.throws(() => applyCurrent(CONFIG, 5, 32), (e) => e.code === 'out_of_range');
  assert.throws(() => applyCurrent(CONFIG, 33), (e) => e.code === 'out_of_range');
  assert.throws(() => applyCurrent(CONFIG, 10.5), (e) => e.code === 'not_integer');
  assert.throws(() => applyCurrent(CONFIG, 'abc'), (e) => e.code === 'not_integer');
});

test('applyCurrent accepts both ends of the range', () => {
  assert.strictEqual(applyCurrent(CONFIG, 7).maxTotalChargeCurrent, 7);
  assert.strictEqual(applyCurrent(CONFIG, 32).maxTotalChargeCurrent, 32);
});

test('assertMatchesExpected blocks a write when the installation changed', () => {
  const expected = {
    distNetType: 'IT',
    chargePointType: 'Single-phase only',
    homeFuseSize: '63A',
    connector1Phase: 'L1-L2',
  };

  assert.doesNotThrow(() => assertMatchesExpected(CONFIG, expected));
  assert.throws(
    () => assertMatchesExpected({ ...CONFIG, homeFuseSize: '20A' }, expected),
    (error) => error.code === 'config_changed',
  );
  assert.throws(
    () => assertMatchesExpected({ ...CONFIG, distNetType: 'TN' }, expected),
    (error) => error.code === 'config_changed',
  );
});

test('assertMatchesExpected is a no-op without a baseline', () => {
  assert.doesNotThrow(() => assertMatchesExpected(CONFIG, null));
});

test('6 A is refused when the ceiling is unknown', () => {
  // Uten et lagret tak ville 6 A vaert en enveisdor: neste avlesning hadde
  // lest 6 som det nye taket. Da nekter vi heller, og gulvet er 7 som for.
  assert.strictEqual(resolveCurrentLimits(CONFIG).min, TOTAL_MIN_AMPS);
  assert.throws(() => applyCurrent(CONFIG, 6), (e) => e.code === 'out_of_range');
});
