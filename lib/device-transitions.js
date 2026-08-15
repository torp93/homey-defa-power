'use strict';

// Overgangene mellom to pollinger: hvilke flow-kort som skal utløses, hvor mye
// energi økten endte på, og om live-forbruk må startes.
//
// Dette bodde tidligere inne i device.js, der det ikke lot seg teste. Det er
// akkurat her de subtile feilene sitter — rekkefølge, første kjøring etter
// oppstart, og verdier som nullstilles av laderen.

const { isCharging, isPluggedIn, hasError } = require('./connector-state');

// Etter så mange mislykkede pollinger på rad regnes laderen som utilgjengelig.
// Ett enkelt blink mot et rate-limitet sky-API skal ikke gråne flisen.
const UNAVAILABLE_AFTER_FAILURES = 3;
const MAX_BACKOFF_SECONDS = 300;

function detectTransitions(previous, current) {
  // Første henting etter oppstart er ingen endring — vi har ingenting å
  // sammenligne med, og skal ikke utløse noe.
  if (!previous || !current) return [];

  const events = [];

  if (!isCharging(previous) && isCharging(current)) {
    events.push({ id: 'defa_charging_started', tokens: {} });
  }

  if (isCharging(previous) && !isCharging(current)) {
    events.push({ id: 'defa_charging_stopped', tokens: {} });
  }

  if (!isPluggedIn(previous) && isPluggedIn(current)) {
    events.push({ id: 'defa_car_connected', tokens: {} });
  }

  if (isPluggedIn(previous) && !isPluggedIn(current)) {
    events.push({ id: 'defa_car_disconnected', tokens: {} });
  }

  if (previous.defa_status !== current.defa_status) {
    events.push({ id: 'defa_status_changed', tokens: { status: current.defa_status } });
  }

  if (!hasError(previous) && hasError(current)) {
    events.push({ id: 'defa_error_occurred', tokens: { error_code: current.defa_error_code } });
  }

  // Fallende flanke: en flow som varsler ved feil må også kunne rydde opp
  // etter seg når feilen forsvinner.
  if (hasError(previous) && !hasError(current)) {
    events.push({ id: 'defa_error_cleared', tokens: {} });
  }

  return events;
}

// transactionMeterValue nullstilles av laderen når økten avsluttes, så tallet
// til flow-tokenet må holdes fast underveis.
function nextSessionEnergy(tracked, previous, current) {
  const reading = current && typeof current.defa_session_energy === 'number'
    ? current.defa_session_energy
    : null;

  // Ny økt: start på det laderen melder nå, ikke på null — den første
  // avlesningen kan allerede være over null.
  if (previous && !isCharging(previous) && isCharging(current)) {
    return reading === null ? 0 : reading;
  }

  if (reading !== null && reading > 0) return Math.max(tracked || 0, reading);
  return tracked || 0;
}

// Live-forbruk må vekkes for hver ladeøkt, ellers rapporterer laderen 0 W.
// Kan ikke henge på overgangen alene: restarter appen midt i en økt, finnes
// det ingen overgang å henge den på.
function needsLiveConsumption(alreadyStarted, current) {
  return isCharging(current) && !alreadyStarted;
}

function nextLiveConsumptionState(alreadyStarted, current, startSucceeded) {
  if (!isCharging(current)) return false;
  if (alreadyStarted) return true;
  return Boolean(startSucceeded);
}

// Eksponentiell backoff, men aldri lenger enn MAX_BACKOFF_SECONDS.
function backoffSeconds(baseSeconds, consecutiveFailures) {
  const base = Number(baseSeconds) > 0 ? Number(baseSeconds) : 60;
  const failures = Math.max(1, Number(consecutiveFailures) || 1);
  return Math.min(base * 2 ** (failures - 1), MAX_BACKOFF_SECONDS);
}

const shouldMarkUnavailable = (consecutiveFailures) =>
  Number(consecutiveFailures) >= UNAVAILABLE_AFTER_FAILURES;

module.exports = {
  UNAVAILABLE_AFTER_FAILURES,
  MAX_BACKOFF_SECONDS,
  detectTransitions,
  nextSessionEnergy,
  needsLiveConsumption,
  nextLiveConsumptionState,
  backoffSeconds,
  shouldMarkUnavailable,
};
