Overvåk og styr DEFA Power- eller eRange-laderen din fra Homey.

Appen kobler seg til DEFA sin CloudCharge-tjeneste, så den virker uansett hvor
laderen står — du trenger ikke sette opp noe lokalt for å komme i gang.

DETTE FÅR DU

- Ladeeffekt, energi denne økten og total energi
- Ladestatus: frakoblet, tilkoblet, lader, pauset av bilen eller av laderen
- Start og stopp lading
- Eco-modus av/på, og «lad nå» som overstyrer smartlading
- Restart laderen
- Laderen dukker opp som elbillader i Homey Energy

FLOWS

Triggere for at lading starter og stopper, bil kobles til og fra,
statusendringer, og at feil oppstår og forsvinner. Betingelser for lading,
tilkoblet bil, eco-modus og feiltilstand. Handlinger for å starte og stoppe
lading, sette eco-modus, overstyre smartlading, restarte og oppdatere.

LADESTRØM

CloudCharge kan ikke sette strømgrense på disse laderne. Laderens egen
konfigurator kan, så appen snakker direkte med den over det lokale nettverket.

Slå på «Styr ladestrømmen lokalt» i enhetsinnstillingene og fyll inn laderens
IP-adresse og PIN-koden du bruker til konfiguratoren. Da dukker det opp en
skyveknapp for ladestrøm, brytere for Plug & Charge og offline-lading, og et
flow-kort for å sette strømmen fra en automasjon.

Skyveknappen får området anlegget ditt faktisk tillater, lest fra laderen. Kun
strømmen endres — alle andre installasjonsparametere leses og skrives tilbake
urørt, og appen nekter å skrive hvis noe ser feil ut. Dette skriver til
laderens idriftsettelsesinnstillinger, så bruk det til noen få endringer om
dagen, ikke til lastbalansering hvert minutt.

DETTE TRENGER DU

- En DEFA Power- eller eRange-lader koblet til CloudCharge
- Mobilnummeret DEFA Power-kontoen din bruker
- For strømstyring: laderen tilgjengelig på det lokale nettverket, samt
  PIN-koden til konfiguratoren

INNLOGGING

Paringen ber om mobilnummeret ditt og sender en kode på SMS.

CloudCharge tillater én aktiv sesjon per app. Bruker Homey samme app-sesjon som
mobilen din, logger de hverandre ut om og om igjen. I appinnstillingene kan du
velge hvilken app-sesjon Homey skal okkupere — velg den du ikke bruker på
mobilen, så lever de side om side. SMS-en sier alltid DEFA Power; det er som
forventet.

Innloggingen ligger i appinnstillingene og deles av alle laderne dine. Etter en
ny innlogging kommer enhetene tilbake av seg selv i løpet av noen minutter.

MERK

Dette er en uoffisiell app laget av en entusiast. Den er ikke laget av,
tilknyttet eller støttet av DEFA. Den bruker et udokumentert grensesnitt og kan
slutte å virke uten varsel hvis DEFA endrer tjenesten sin.

Kildekode og feilrapportering: https://github.com/torp93/homey-defa-power
