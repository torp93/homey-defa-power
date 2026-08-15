# DEFA Power for Homey Pro

Overvåk og styr en DEFA Power- eller eRange-lader fra Homey, gjennom DEFA sin
CloudCharge-tjeneste.

> **Uoffisielt prosjekt.** Dette er ikke laget av, tilknyttet eller støttet av
> DEFA. «DEFA», «DEFA Power», «eRange» og «CloudCharge» er DEFAs varemerker og
> brukes her kun for å beskrive hva appen snakker med. API-et er
> reverse-engineert og udokumentert, og kan slutte å virke uten varsel hvis DEFA
> endrer noe. Bruk på eget ansvar. Ingen garanti — se `LICENSE`.

## Hvorfor sky og ikke lokalt nett

Laderens lokale webgrensesnitt (CLU Commissioning tool, Flask på port 80) er et
*idriftsettelsesverktøy*. Det eksponerer `/get-status`, `/get-homeCLU`,
`/set-homeCLU`, `/set-wan` og PIN-håndtering — altså nettype, sikringsstørrelse
og WiFi. Det finnes ingen effekt, energi, ladestatus eller start/stopp der.
Derfor går all styring via CloudCharge:

```
https://prod.cloudcharge.se/services/user
x-authorization: <token>
x-user: <user-id>
```

## Hva appen kan

| Kapabilitet | Kilde |
| --- | --- |
| `measure_power` | `powerConsumption` fra `/connector/{id}/operationaldata` (kW → W) |
| `meter_power` | `meterValue`, total kWh |
| `defa_session_energy` | `transactionMeterValue`, kWh denne økten |
| `evcharger_charging_state` | `ocpp.chargingState` + `ocpp.status` |
| `defa_status`, `defa_charging_state` | samme, men med full detaljgrad |
| Start / stopp | `POST /charging/start` og `/charging/stop` |
| Eco-modus | `GET`/`PUT /connector/{id}/ecomode/configuration` |
| Lad nå | `PUT /connector/{id}/schedule/override` |
| Restart | `POST /connector/{id}/reset?type=soft\|hard` |

## Ladestrøm — lokalt, ikke gjennom skyen

CloudCharge kan **ikke** sette strømgrense på denne laderen.
`/connector/{id}/maxcurrent/alternatives` svarer `404 CAPABILITY_NOT_FOUND`, og
laderen melder selv `capabilities.maxPower: false`. Det samme gjelder
lastbalansering og manuelle ladeskjemaer — `/schedule/active-settings`
rapporterer bare `capable: ["ECOMODE"]`.

Men laderens egen konfigurator kan. Slår du på **Styr ladestrømmen lokalt** i
enhetsinnstillingene og fyller inn laderens IP-adresse og PIN, dukker
kapabiliteten `defa_charge_current` opp, sammen med flow-kortet «Sett
ladestrømmen til X A».

Grensene kommer fra konfiguratorens eget skjema:

| Felt | Grenser |
| --- | --- |
| `maxTotalChargeCurrent` | heltall, min 7 A, `lessOrEqual` hovedsikringen |
| `connectors[].maxCurrent` | heltall, 6–32 A |

Effektiv grense er den laveste av de to, og skyveknappen settes deretter ved
oppstart. På et 63 A-anlegg med ett Gen2-ladepunkt blir det 7–32 A.

**Dette er et idriftsettelsesendepunkt, ikke en runtime-knapp.** `/set-homeCLU`
tar hele konfigurasjonen — nettype, sikringsstørrelse, fasekobling — så
appen leser alltid ferskt, endrer kun strømmen og skriver resten tilbake
uendret. I tillegg:

- skriving hoppes over hvis verdien allerede er den samme
- verdier utenfor skjemaets grenser avvises før noe nettverkskall skjer
- en ufullstendig lest konfigurasjon avbryter skrivingen
- installasjonsparameterne lagres ved første lesing, og en skriving avbrytes
  hvis de har endret seg siden

Bruk det til noen få endringer om dagen — dag/natt, eller når varmepumpa
drar mye — ikke til lastbalansering hvert minutt.

## To identifikatorer som er lette å blande

Hvert ladepunkt har begge, og de er ikke like:

- **`alias`** — nøkkelen i `aliasMap`, f.eks. `00.00.00.0000`. Brukes av
  `/charging/start` og `/charging/stop`.
- **`connector.id`** — en UUID. Brukes av alt under `/connector/{id}/…`.

Bytter man om, feiler begge kallene stille. `pickConnectors()` i
[`lib/connector-state.js`](lib/connector-state.js) holder dem adskilt, og det er
dekket av test.

## Innlogging

Paringen ber om mobilnummer og sender en SMS-kode.

Appen utgir seg for å være **DEFA Power**-appen (`devToken`
`XqP3sCFKdg4vrV8J`). Det er ikke et vilkårlig valg: med CloudCharge-appens token
svarer `/prelogin` `200 OK` og oppretter en gyldig loginAttempt — `/login` med
feil kode svarer da `Invalid login credentials.` i stedet for
`No loginAttempts found` — men SMS-en blir aldri levert.

CloudCharge tillater **én aktiv sesjon per app**, og det biter begge veier:
bruker Homey samme `devToken` som mobilappen din, logger de hverandre ut
kontinuerlig. Åpner du DEFA Power-appen, får Homey `401` på neste polling og
laderen blir utilgjengelig.

Derfor bør Homey okkupere plassen til den appen du *ikke* bruker. Under
appinnstillingene kan du velge hvilken app-plass innloggingen skal ta.
SMS-en bestilles alltid som DEFA Power — den eneste ruten som leverer kode —
men koden løses inn mot den plassen du velger.

Innloggingen ligger i **appinnstillingene**, ikke i en reparasjon av enheten.
Sesjonen er app-global og deles av alle ladere, og enhetene blir tilgjengelige
igjen av seg selv ved første vellykkede polling etter en ny innlogging.

En sidebemerkning for framtidige Homey-apper: repair-visninger hentes fra
`drivers/<id>/repair/`, ikke fra `pair/`. Peker `repair` i manifestet på en fil
som ikke finnes der, får du `unknown_error_getting_file` og en blank skjerm.

SMS-en ser slik ut, der de siste elleve tegnene er Android sin SMS
Retriever-hash og ikke noe du skal taste inn:

```
123456 er bekreftelseskoden din for å logge på DEFA Power.

AbCdEfGhIjK
```

## Rate limiting

CloudCharge rate-limiter per token, og kall som kommer tettere enn omtrent ett
sekund begynner å time ut. `CloudChargeClient` serialiserer derfor starten av
hvert kall med minst 1000 ms mellomrom, uansett hvor mange enheter eller flows
som spør samtidig.

Pollingen er adaptiv: hvert 60. sekund normalt, hvert 10. sekund mens en økt
pågår. Begge er justerbare per enhet. Ved overgang til lading kalles
`/startliveconsumption` — uten den står `powerConsumption` på 0 gjennom hele
økten.

## Utvikling

```bash
node --test
```

```bash
homey app validate --level publish
```

```bash
homey app run --remote
```

`--remote` laster opp til Homey-en. Uten flagget bygger CLI v4 i en lokal
Docker-container.

Merk at `env.json` ikke leveres på Homey Pro 13.4.0 — `this.homey.env` kommer
stille tomt. Sesjonen lagres derfor i appinnstillingene, med konstantene i
[`lib/cloudcharge-config.js`](lib/cloudcharge-config.js) som fallback.

## Takk

API-kartleggingen bygger på [Bebbssos/ha-defa-power](https://github.com/Bebbssos/ha-defa-power),
integrasjonen for Home Assistant. CloudCharge-API-et er uoffisielt og kan endres
uten varsel.

## Lisens

MIT — se [`LICENSE`](LICENSE). Varemerker og tredjepartsreferanser er listet i
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
