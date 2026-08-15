# DEFA Power for Homey Pro

Monitor and control a DEFA Power or eRange charger from Homey, through DEFA's
CloudCharge service.

> **Unofficial project.** This is not made by, affiliated with, or endorsed by
> DEFA. "DEFA", "DEFA Power", "eRange" and "CloudCharge" are trademarks of DEFA
> and are used here only to describe what the app talks to. The API is
> reverse-engineered and undocumented, and may stop working without notice if
> DEFA changes something. Use at your own risk. No warranty — see `LICENSE`.

## Why cloud and not the local network

The charger's local web interface (the CLU Commissioning tool, Flask on port 80)
is a *commissioning tool*. It exposes `/get-status`, `/get-homeCLU`,
`/set-homeCLU`, `/set-wan` and PIN handling — that is, distribution-network
type, fuse size and Wi-Fi. There is no power, energy, charging status or
start/stop there. So all control goes through CloudCharge:

```
https://prod.cloudcharge.se/services/user
x-authorization: <token>
x-user: <user-id>
```

## What the app can do

| Capability | Source |
| --- | --- |
| `measure_power` | `powerConsumption` from `/connector/{id}/operationaldata` (kW → W) |
| `meter_power` | `meterValue`, total kWh |
| `defa_session_energy` | `transactionMeterValue`, kWh this session |
| `evcharger_charging_state` | `ocpp.chargingState` + `ocpp.status` |
| `defa_status`, `defa_charging_state` | same, but at full detail |
| Start / stop | `POST /charging/start` and `/charging/stop` |
| Eco mode | `GET`/`PUT /connector/{id}/ecomode/configuration` |
| Charge now | `PUT /connector/{id}/schedule/override` |
| Restart | `POST /connector/{id}/reset?type=soft\|hard` |

## Charging current — local, not through the cloud

CloudCharge **cannot** set a current limit on this charger.
`/connector/{id}/maxcurrent/alternatives` answers `404 CAPABILITY_NOT_FOUND`, and
the charger itself reports `capabilities.maxPower: false`. The same holds for
load balancing and manual charging schedules — `/schedule/active-settings`
reports only `capable: ["ECOMODE"]`.

But the charger's own configurator can. Turn on **Control the charging current
locally** in the device settings and fill in the charger's IP address and PIN,
and the `defa_charge_current` capability appears, along with the flow card "Set
the charging current to X A".

The limits come from the configurator's own schema:

| Field | Limits |
| --- | --- |
| `maxTotalChargeCurrent` | integer, min 7 A, `lessOrEqual` the main fuse |
| `connectors[].maxCurrent` | integer, 6–32 A |

The effective limit is the lower of the two, and the slider is ranged
accordingly at startup. On a 63 A installation with one Gen2 charge point that
comes out to 7–32 A.

**This is a commissioning endpoint, not a runtime knob.** `/set-homeCLU` takes
the whole configuration — network type, fuse size, phase wiring — so the app
always reads fresh, changes only the current, and writes the rest back
unchanged. In addition:

- the write is skipped if the value is already the same
- values outside the schema's limits are rejected before any network call
- an incompletely read configuration aborts the write
- the installation parameters are stored on the first read, and a write aborts
  if they have changed since

Use it for a few changes a day — day/night, or when the heat pump draws a lot —
not for load balancing every minute.

## Two identifiers that are easy to mix up

Every charge point has both, and they are not the same:

- **`alias`** — the key in `aliasMap`, e.g. `00.00.00.0000`. Used by
  `/charging/start` and `/charging/stop`.
- **`connector.id`** — a UUID. Used by everything under `/connector/{id}/…`.

Swap them and both calls fail silently. `pickConnectors()` in
[`lib/connector-state.js`](lib/connector-state.js) keeps them apart, and that is
covered by tests.

## Login

Pairing asks for a mobile number and sends an SMS code.

The app identifies itself as the **DEFA Power** app (`devToken`
`XqP3sCFKdg4vrV8J`). That is not an arbitrary choice: with the CloudCharge app's
token, `/prelogin` answers `200 OK` and creates a valid login attempt — `/login`
with a wrong code then answers `Invalid login credentials.` instead of
`No loginAttempts found` — but the SMS is never delivered.

CloudCharge allows **one active session per app**, and it bites both ways: if
Homey uses the same `devToken` as your phone, they keep signing each other out.
Open the DEFA Power app and Homey gets `401` on the next poll and the charger
goes unavailable.

So Homey should occupy the slot of the app you *don't* use. In the app settings
you can pick which app slot the login takes. The SMS is always requested as DEFA
Power — the only route that delivers a code — but the code is redeemed against
the slot you choose.

The login lives in the **app settings**, not in a device repair. The session is
app-global and shared by all chargers, and devices become available again on
their own at the first successful poll after a new login.

A side note for future Homey apps: repair views are read from
`drivers/<id>/repair/`, not from `pair/`. If `repair` in the manifest points at
a file that isn't there, you get `unknown_error_getting_file` and a blank
screen.

The SMS looks like this, where the last eleven characters are Android's SMS
Retriever hash and not something you type in:

```
123456 is your confirmation code for signing in to DEFA Power.

AbCdEfGhIjK
```

## Rate limiting

CloudCharge rate-limits per token, and calls closer together than about one
second start to time out. `CloudChargeClient` therefore serializes the start of
each call with at least 1000 ms between them, no matter how many devices or
flows ask at once.

Polling is adaptive: every 60 seconds normally, every 10 seconds while a session
is running. Both are adjustable per device. On the transition to charging,
`/startliveconsumption` is called — without it `powerConsumption` stays at 0 for
the whole session.

## Development

```bash
node --test
```

```bash
homey app validate --level publish
```

```bash
homey app run --remote
```

`--remote` uploads to the Homey. Without the flag, CLI v4 builds into a local
Docker container.

Note that `env.json` is not delivered on Homey Pro 13.4.0 — `this.homey.env`
arrives silently empty. The session is therefore stored in the app settings,
with the constants in [`lib/cloudcharge-config.js`](lib/cloudcharge-config.js) as
a fallback.

## Credits

The API mapping builds on [Bebbssos/ha-defa-power](https://github.com/Bebbssos/ha-defa-power),
the Home Assistant integration. The CloudCharge API is unofficial and may change
without notice.

## License

MIT — see [`LICENSE`](LICENSE). Trademarks and third-party references are listed
in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
