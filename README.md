# rijhulp-open

De draaiende versie van dit project is Blitzla, op [blitzla.hypamoon.app](https://blitzla.hypamoon.app).

<p><a href="https://hypamoon.com/connect?say=a%20free%20driving%20assistant%20for%20my%20car%27s%20browser%2C%20following%20RECEPT.md%20in%20github.com%2Frodin-brethouwer%2Frijhulp-open"><strong>Build it in your chat</strong></a></p>

[Nederlands](#nederlands) · [English](#english)

## Nederlands

Een open project voor een gratis rijhulp in de browser van de auto: je snelheid, de limiet van de
weg, een melding vooraf bij trajectcontroles en vaste flitsers, en flitsers die andere bestuurders
net gemeld hebben. Iedereen kan zijn eigen rijhulp bouwen, ook zonder programmeerervaring, door
een chat (Claude, ChatGPT, Cursor of een andere) het recept te laten volgen.

De apps praten met elkaar via een klein protocol: elke app biedt een ondertekende feed met de
meldingen van zijn eigen gebruikers, en leest de feeds van andere apps die hij vertrouwt. Zo krijgt
iedereen meer meldingen, zonder dat er één centrale dienst is.

### Snel beginnen

De kortste route: de knop hierboven. Je chat (Claude, ChatGPT of een andere die met Hypamoon is
gekoppeld) leest `RECEPT.md` en zet de rijhulp in één keer live, gratis:

1. de site uit `referentie/site/`, met de kaart, de flitsers en het geluid als bestanden erbij;
2. `referentie/server/server.mjs` als servercode onder `/api`, met een eigen database
   (`database: true`) en de tabellen uit `referentie/server/migraties/0001_meldingen.sql`;
3. de geheime sleutel voor je feed als geheim (`FEED_SLEUTEL`), die de chat zelf nooit ziet;
4. een eigen adres zoals `https://<naam>.hypamoon.app`, of je eigen domein. Je feed staat dan op
   `https://<naam>.hypamoon.app/api/feed`.

Zonder knop zeg je tegen je chat: "Bouw met RECEPT.md uit deze repo een rijhulp voor mij."

### Andere routes

De server is een gewone fetch-handler met een kleine database-interface
(`prepare().bind().first/all/run` en `batch`). In `referentie/server/adapters/` staan
tussenstukken voor SQLite en Postgres, zodat hij ook elders draait. Overal geldt: bouw eerst de
kaart en de flitsers (RECEPT.md, stap 3), en zorg voor HTTPS, want de browser geeft de positie
alleen over HTTPS.

**Een eigen VPS of server met Node.** Node 22.5 of nieuwer is genoeg, zonder pakketten. Start
`APP_ID=<id> FEED_SLEUTEL=<sleutel> RIJHULP_PROXY=1 node referentie/scripts/lokaal.mjs 8787 /var/lib/rijhulp/rijhulp.db`
achter nginx of Caddy met HTTPS. De database is SQLite in dat bestand (`adapters/sqlite.mjs`), de
tabellen maakt hij zelf aan. Zet de sleutel in de omgeving van de dienst (bijvoorbeeld systemd),
niet in de repo.

**Replit.** Importeer de repo als Node-project. Zet `APP_ID`, `FEED_SLEUTEL` en `RIJHULP_PROXY=1`
bij Secrets en `RIJHULP_DB=rijhulp.db`, en laat Run `npm start` doen (de poort komt uit `PORT`).
Een gepubliceerde Replit-app bewaart geen bestanden; gebruik daar de Postgres van Replit: zet
`DATABASE_URL`, doe `npm install pg` en draai eenmalig `referentie/server/adapters/postgres-schema.sql`.

**Lovable en Bolt (met Supabase).** De site gaat als statische frontend mee. De server draait als
Supabase Edge Function: importeer `maakServer` uit `server.mjs` en `postgresDb` uit
`adapters/postgres.mjs`, geef `postgresDb` een client van `npm:postgres` op `SUPABASE_DB_URL` (met
`prepare: false`), haal het voorvoegsel van de functie van het pad af en zet de JWT-controle voor
deze functie uit, want de app heeft geen accounts. Draai `adapters/postgres-schema.sql` eenmalig in
de SQL-editor van Supabase; die zet ook RLS aan, zodat de browser-API niet bij de tabellen kan.

**Railway of Render.** Een Node-dienst met `npm start` en `RIJHULP_PROXY=1`. Met hun Postgres:
`DATABASE_URL` zetten, `npm install pg`, en `adapters/postgres-schema.sql` eenmalig draaien. Met
een schijf: `RIJHULP_DB` op een pad op die schijf.

### Wat er in deze repo staat

| Bestand | Wat |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | het protocol, versie 0.1: melding, kaartvak, feed, stemmen, ondertekening, limieten, privacy |
| [`landen.json`](landen.json) | de standaard landregels voor de flitslaag, met bron en datum |
| [`RECEPT.md`](RECEPT.md) | de bouwinstructie die een chat stap voor stap kan volgen |
| [`deelnemers.json`](deelnemers.json) | de lijst van apps die meedoen, met hun feed en publieke sleutel |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | hoe je je app toevoegt of een wijziging voorstelt |
| [`protocol/`](protocol) | hulpmiddelen om een feed te controleren |
| [`referentie/`](referentie) | de code van een werkende rijhulp om van uit te gaan |

De referentie-implementatie is Blitzla, op https://blitzla.hypamoon.app. Dat is de eigen app
van de maker van dit project, niet meer dan een voorbeeld.

### Hoe het werkt

- **De browser in de auto.** Alles draait als gewone webpagina, gemaakt voor de browser van de
  Tesla (Chromium, zonder app-store) en bruikbaar op elke telefoon. Snelheid en koers komen uit de
  Geolocation API. De rit loopt op een eigen klok (de monotone klok van de pagina, nooit terug),
  omdat `pos.timestamp` in de auto soms terugloopt of uit een andere klok komt.
- **Offline met een service worker.** De site, de kaart en de flitsers staan na het eerste bezoek
  in de cache: de site met stale-while-revalidate, de kaartvakken cache-first per stand (een nieuwe
  bouw geeft nieuwe URL's). `/api/` gaat nooit via de cache.
- **Data.** Limieten, flitspalen, roodlichtcamera's en trajectcontroles komen uit OpenStreetMap
  (© OpenStreetMap-bijdragers, ODbL). Scripts in `referentie/scripts/` bouwen daaruit vooraf
  vakken van ca. 22 x 20 km (wegen als polyline, met `maxspeed`, `maxspeed:conditional` en
  richting); buiten die vakken vraagt de app de openbare Overpass-servers. Tijdvoorwaarden
  ("130 @ (19:00-06:00)") rekenen in de tijdzone van het land. Matrixborden boven de snelweg (NL)
  komen uit de open data van NDW (CC0 1.0), via de eigen server omdat die feed geen CORS heeft.
  De app noemt de bronnen in de voet en op `over.html`; wie de data verspreidt, houdt die
  vermelding en de ODbL aan.
- **Geluid.** De Tesla-browser heeft geen stemmen voor `speechSynthesis`. Daarom zijn de zinnen
  vooraf ingesproken en als één Ogg Opus per taal gebundeld; de app plant ze op de klok van Web
  Audio. Een wachtrij zorgt dat meldingen nooit door elkaar praten en dat een zin die door een
  hapering te laat zou komen, wegvalt in plaats van later alsnog te klinken.
- **Aankondigingen.** Een flitspaal of gemelde flitser wordt vooraf gemeld op 500, 300 of 150 m
  (afhankelijk van de snelheid), een trajectcontrole op 1000 of 500 m, alleen in de rijrichting. Elke aankondiging klinkt
  hooguit één keer per plek en richting, ook na herladen of in een tweede tabblad (bewaard in
  localStorage). Waar OSM meer trajecten op dezelfde plek heeft (hoofd- en parallelrijbaan) telt
  het als één.
- **Gemiddelde bij een trajectcontrole.** De app legt van begin tot einde een lijn over de wegdelen
  van het traject en projecteert de auto daarop. Het gemiddelde is de afstand langs die lijn sinds
  het begin, gedeeld door de tijd sinds het begin. Ruis opzij telt dus niet mee, GPS-sprongen
  worden genegeerd, en stilstand in de file telt mee zoals bij de echte meting. Een getal staat er
  pas na 15 s en 300 m. Gaat de app halverwege aan, dan meet hij vanaf daar ("gem. volgt") en noemt
  hij bij het einde geen getal.
- **Gemelde flitsers.** Eén tik legt plek en rijrichting vast; anderen krijgen daar een melding en
  na het langsrijden de vraag of hij er nog staat. Ja verlengt, nee verkort. Geen account: de
  server geeft een ondertekend toestel-id uit. In de database staan geen IP-adressen of
  toestel-ids, alleen hashes met een zout dat elke dag wisselt en daarna wordt gewist.
- **Tegen misbruik, in grote lijnen.** Schrijven kan alleen als JSON van de eigen site; toestel-ids
  komen van de server en worden per netwerk beperkt uitgegeven; melden en stemmen hebben limieten
  per toestel, per netwerkadres en per net, die los staan van wat de client meestuurt; een melding
  verdwijnt alleen meteen door nee van verschillende netwerken. De precieze regels staan in
  `PROTOCOL.md`, hoofdstuk 5 en 8, en in `REGELS` in `referentie/server/server.mjs`.

### Lokaal draaien en testen

Node 22.5 of nieuwer, geen pakketten nodig.

    npm test                                   # server, feed, limieten, afritten, adapters, matrixborden
    node referentie/test/geluid.mjs            # de wachtrij van het geluid tegen een nep-AudioContext

Voor de site zelf bouw je eerst de data (RECEPT.md, stap 3: kaart, flitsers en grenzen uit een
Geofabrik-extract met osmium, geluid met je eigen ingesproken zinnen). Daarna:

    npm run lokaal                             # http://localhost:8787, site plus /api op SQLite in het geheugen
    node referentie/test/rit.mjs n209          # een proefrit zonder browser (na maak-simroute.mjs)
    node referentie/test/traject.mjs           # trajectcontrole: één aankondiging, het gemiddelde
    node referentie/test/ruis.mjs              # hetzelfde met GPS-ruis, sprongen, stiltes en herladen

### Proefrit

`?sim=<naam>` speelt een nep-GPS-reeks af uit `site/sim/<naam>.json` (10 posities per seconde),
gemaakt met `referentie/scripts/maak-simroute.mjs` langs een echte weg. Opties: `&x=3` sneller,
`&kmh=100` een andere snelheid, `&uur=17:20` rijden op dat uur (voor tijdvoorwaarden), `&ruis=1`
GPS zoals in de auto (tijd heen en weer, herhaalde posities, sprongen), `&debug=1` de staat en het
log op het scherm. Op een echte site meldt en stemt een proefrit niet; alleen lokaal kun je met
`&toestel=<naam>` een tweede gebruiker naspelen.

### Gratis

De rijhulp is bedoeld als gratis hulpmiddel. De code staat onder MIT, het protocol en de
documentatie onder CC BY 4.0. Je mag alles gebruiken, aanpassen en zelf draaien.

### Wie is verantwoordelijk

Er is geen organisatie achter dit project die apps beheert, meldingen modereert of iets goedkeurt.

- Elke beheerder is verantwoordelijk voor zijn eigen app: wat die toont, wat die bewaart, en de
  wet in de landen waar die werkt.
- `landen.json` geeft een standaard die elke implementatie volgt (in landen waar waarschuwen voor
  flitsers niet mag, staat de laag uit). Het is geen juridisch advies; controleer zelf de regels.
- Dit project helpt niet bij het omzeilen van een wet: geen radardetectie, geen stoorzenders.
- De borden langs de weg gaan altijd voor. Kaartdata kan achterlopen of fout zijn.
- De host waar je app draait, is alleen de host. Hij beheert en modereert niets.

### Meedoen

1. Bouw je eigen rijhulp met [`RECEPT.md`](RECEPT.md), of begin bij [`referentie/`](referentie).
2. Maak een sleutelpaar en zet je feed aan (zie PROTOCOL.md, hoofdstuk 6).
3. Voeg je app toe aan `deelnemers.json` met een pull request (zie CONTRIBUTING.md).

Verbeteringen aan het protocol, de landregels of de referentie zijn welkom als issue of pull request.

### Licenties

Code onder MIT, protocol en documentatie onder CC BY 4.0, zie [`LICENSE`](LICENSE). Kaartdata
komt uit OpenStreetMap (© OpenStreetMap-bijdragers) en valt onder de ODbL. Die data staat niet in
deze repo: de scripts in `referentie/scripts/` bouwen hem zelf. De matrixborden (alleen Nederland)
komen uit de open data van NDW onder CC0 1.0; ook die bouwt een script (`bouw-msi.mjs`).

## English

An open project for a free driving assistant in the car's browser: your speed, the speed limit of
the road, an alert ahead of average speed checks and fixed speed cameras, and cameras that other
drivers have just reported. Anyone can build their own, even without coding experience, by letting
a chat assistant (Claude, ChatGPT, Cursor or another) follow the recipe.

The apps talk to each other through a small protocol: each app offers a signed feed with the
reports of its own users, and reads the feeds of other apps it trusts. Everyone gets more reports,
without a central service.

### Quickstart

The shortest route is the button at the top. Your chat (Claude, ChatGPT or another one connected
to Hypamoon) reads `RECEPT.md` and puts the driving assistant live in one go, for free:

1. the site from `referentie/site/`, with the map, the cameras and the audio as files;
2. `referentie/server/server.mjs` as server code under `/api`, with its own database
   (`database: true`) and the tables from `referentie/server/migraties/0001_meldingen.sql`;
3. the secret key for your feed as a secret (`FEED_SLEUTEL`), which the chat never sees;
4. an address like `https://<name>.hypamoon.app`, or your own domain. Your feed is then at
   `https://<name>.hypamoon.app/api/feed`.

Without the button, tell your chat: "Build me a driving assistant with RECEPT.md from this repo."

### Other routes

The server is a plain fetch handler with a small database interface
(`prepare().bind().first/all/run` and `batch`). `referentie/server/adapters/` has adapters for
SQLite and Postgres, so it runs elsewhere too. Everywhere: build the map and the cameras first
(RECEPT.md, step 3), and serve over HTTPS, because the browser only shares the position over HTTPS.

**Your own VPS or server with Node.** Node 22.5 or newer, no packages. Run
`APP_ID=<id> FEED_SLEUTEL=<key> RIJHULP_PROXY=1 node referentie/scripts/lokaal.mjs 8787 /var/lib/rijhulp/rijhulp.db`
behind nginx or Caddy with HTTPS. The database is SQLite in that file (`adapters/sqlite.mjs`); it
creates the tables itself. Put the key in the service environment (systemd, for example), never in
the repo.

**Replit.** Import the repo as a Node project. Set `APP_ID`, `FEED_SLEUTEL` and `RIJHULP_PROXY=1`
in Secrets plus `RIJHULP_DB=rijhulp.db`, and let Run do `npm start` (the port comes from `PORT`). A
published Replit app keeps no files; use Replit's Postgres there: set `DATABASE_URL`, run
`npm install pg` and run `referentie/server/adapters/postgres-schema.sql` once.

**Lovable and Bolt (with Supabase).** The site goes in as a static frontend. The server runs as a
Supabase Edge Function: import `maakServer` from `server.mjs` and `postgresDb` from
`adapters/postgres.mjs`, give `postgresDb` an `npm:postgres` client on `SUPABASE_DB_URL` (with
`prepare: false`), strip the function prefix from the path and switch off the JWT check for this
function, since the app has no accounts. Run `adapters/postgres-schema.sql` once in the Supabase
SQL editor; it also switches on RLS, so the browser API cannot reach the tables.

**Railway or Render.** A Node service with `npm start` and `RIJHULP_PROXY=1`. With their Postgres:
set `DATABASE_URL`, `npm install pg`, and run `adapters/postgres-schema.sql` once. With a disk:
point `RIJHULP_DB` at a path on that disk.

### What is in this repo

| File | What |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | the protocol, version 0.1: report, map tile, feed, votes, signing, limits, privacy (in Dutch, with an English column for the terms) |
| [`landen.json`](landen.json) | the default country rules for the camera layer, with source and date |
| [`RECEPT.md`](RECEPT.md) | the build recipe a chat assistant can follow step by step (in Dutch; any assistant can translate it) |
| [`deelnemers.json`](deelnemers.json) | the list of participating apps, with their feed and public key |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | how to add your app or propose a change |
| [`protocol/`](protocol) | tools to check a feed |
| [`referentie/`](referentie) | the code of a working driving assistant to start from |

The reference implementation is Blitzla, at https://blitzla.hypamoon.app. It is the project
maker's own app and nothing more than an example.

### How it works

- **The car's browser.** It is a plain web page, built for the Tesla browser (Chromium, no app
  store) and usable on any phone. Speed and heading come from the Geolocation API. A drive runs on
  its own clock (the page's monotonic clock, never backwards), because `pos.timestamp` in the car
  sometimes runs backwards or comes from another clock.
- **Offline via a service worker.** After the first visit the site, the map and the cameras are
  cached: the site stale-while-revalidate, map tiles cache-first per build (a new build gets new
  URLs). `/api/` never goes through the cache.
- **Data.** Limits, speed cameras, red light cameras and average speed checks come from
  OpenStreetMap (© OpenStreetMap contributors, ODbL). Scripts in `referentie/scripts/` prebuild
  tiles of about 22 x 20 km (roads as polylines with `maxspeed`, `maxspeed:conditional` and
  direction); outside those tiles the app asks the public Overpass servers. Time conditions
  ("130 @ (19:00-06:00)") use the country's time zone. Overhead motorway signs (NL) come from NDW
  open data (CC0 1.0), through the app's own server since that feed has no CORS. The app credits
  its sources in the footer and on `over.html`; if you redistribute the data, keep that credit and
  the ODbL.
- **Audio.** The Tesla browser has no `speechSynthesis` voices, so the phrases are prerecorded and
  bundled as one Ogg Opus per language, scheduled on the Web Audio clock. A queue makes sure
  alerts never talk over each other, and a phrase that a stall would make late is dropped instead
  of playing later.
- **Alerts.** A fixed or reported camera is announced at 500, 300 or 150 m (depending on speed),
  an average speed check at 1000 or 500 m, only in the driving direction. Each alert plays at most once per
  place and direction, also after a reload or in a second tab (kept in localStorage). Where OSM has
  several sections at the same spot (main and parallel carriageway) they count as one.
- **Average speed in a section check.** The app lays a line along the section's road segments from
  start to end and projects the car onto it. The average is the distance along that line since the
  start divided by the time since the start, so sideways noise does not count, GPS jumps are
  ignored, and standing still in a queue counts just as in the real measurement. A number shows
  after 15 s and 300 m. If the app starts halfway, it measures from there ("avg follows") and does
  not announce a number at the end.
- **Reported cameras.** One tap stores position and heading; others get an alert there and, after
  passing, the question whether it is still there. Yes extends, no shortens. No account: the server
  issues a signed device id. The database holds no IP addresses or device ids, only hashes with a
  salt that changes daily and is then deleted.
- **Abuse, in broad strokes.** Writes are accepted only as JSON from the app's own site; device
  ids come from the server and are issued sparingly per network; reports and votes are limited per
  device, per network address and per network range, independent of anything the client sends; a
  report only disappears at once on no votes from different networks. The exact rules are in
  `PROTOCOL.md`, chapters 5 and 8, and in `REGELS` in `referentie/server/server.mjs`.

### Running and testing locally

Node 22.5 or newer, no packages needed.

    npm test                                   # server, feed, limits, exits, adapters, overhead signs
    node referentie/test/geluid.mjs            # the audio queue against a fake AudioContext

For the site itself, build the data first (RECEPT.md, step 3: map, cameras and borders from a
Geofabrik extract with osmium, audio with your own recorded phrases). Then:

    npm run lokaal                             # http://localhost:8787, site plus /api on in-memory SQLite
    node referentie/test/rit.mjs n209          # a test drive without a browser (after maak-simroute.mjs)
    node referentie/test/traject.mjs           # section control: one announcement, the average
    node referentie/test/ruis.mjs              # the same with GPS noise, jumps, silences and reloads

### Test drive

`?sim=<name>` plays a fake GPS track from `site/sim/<name>.json` (10 positions per second), made
with `referentie/scripts/maak-simroute.mjs` along a real road. Options: `&x=3` faster, `&kmh=100`
another speed, `&uur=17:20` drive at that time of day (for time conditions), `&ruis=1` GPS as in
the car (time going back and forth, repeated positions, jumps), `&debug=1` state and log on screen.
On a real site a test drive does not report or vote; only locally can `&toestel=<name>` simulate a
second user.

### Free

The driving assistant is meant as a free tool. The code is MIT, the protocol and documentation are
CC BY 4.0. You may use, change and run all of it yourself.

### Who is responsible

There is no organisation behind this project that manages apps, moderates reports or approves
anything.

- Each operator is responsible for their own app: what it shows, what it stores, and the law in the
  countries where it runs.
- `landen.json` sets a default that every implementation follows (where warning for speed cameras
  is not allowed, the layer is off). It is not legal advice; check the rules yourself.
- This project does not help anyone get around a law: no radar detection, no jammers.
- Road signs always come first. Map data can be outdated or wrong.
- The host your app runs on is only the host. It manages and moderates nothing.

### Taking part

1. Build your own with [`RECEPT.md`](RECEPT.md), or start from [`referentie/`](referentie).
2. Create a key pair and switch on your feed (PROTOCOL.md, chapter 6).
3. Add your app to `deelnemers.json` with a pull request (see CONTRIBUTING.md).

Improvements to the protocol, the country rules or the reference are welcome as an issue or pull
request.

### Licences

Code under MIT, protocol and documentation under CC BY 4.0, see [`LICENSE`](LICENSE). Map data
comes from OpenStreetMap (© OpenStreetMap contributors) and is licensed under the ODbL. That data
is not in this repo: the scripts in `referentie/scripts/` build it. The overhead motorway signs
(Netherlands only) come from NDW open data under CC0 1.0, built by `bouw-msi.mjs`.

---

Built and running on Hypamoon: [Blitzla](https://blitzla.hypamoon.app), the reference app from
this repo.
