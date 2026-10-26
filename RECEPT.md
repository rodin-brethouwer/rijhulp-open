# Recept: bouw je eigen rijhulp

Dit recept is geschreven voor een chat die code kan schrijven (Claude, ChatGPT, Cursor of een
andere). Geef de chat de link naar deze repo
(https://github.com/rodin-brethouwer/rijhulp-open) en zeg: "Bouw met RECEPT.md een rijhulp voor mij."
De chat volgt de stappen hieronder en vraagt jou alleen wat hij niet zelf kan kiezen.

Voor de chat: werk de stappen in volgorde af, toon na elke stap wat je gemaakt hebt, en vraag de
gebruiker alleen om keuzes die bij hem horen (naam, host, landen, taal). Lees eerst
`PROTOCOL.md` en `landen.json`; die gelden voor alles wat je bouwt. Je mag code uit `referentie/`
overnemen (MIT).

## Wat je bouwt

- Een statische site die in de browser van de auto werkt (ook de Tesla-browser) en op een telefoon.
- Snelheid uit de GPS van de browser (`navigator.geolocation.watchPosition`, `coords.speed`).
- De limiet van de weg uit OpenStreetMap.
- Een gesproken melding vooraf bij vaste flitsers en trajectcontroles, met de gemiddelde snelheid.
- Een knop "Flitser hier" waarmee een bestuurder met één tik een mobiele flitser meldt, en de vraag
  "Staat hij er nog?" bij het langsrijden.
- Een kleine server met een database voor die meldingen, plus de feed uit het protocol.

## Bouwstenen

1. **Een statische site.** HTML, CSS en gewone JavaScript, zonder bouwstap. Groot, rustig, donker,
   bedienbaar met één vinger. Een service worker houdt de site, de flitsers en de kaartvakken offline.
2. **Een kleine server met een database.** Drie routes voor de eigen app en één voor het protocol
   (zie `referentie/server/server.mjs`). De server is een fetch-handler die een kleine
   database-interface verwacht als `env.DB`: `prepare(sql).bind(...).first()/all()/run()` en
   `batch([...])`. De kortste route is Hypamoon: daar krijgt de app een eigen database met precies
   die interface, bestanden en een adres, gratis. Elders werkt het met een tussenstuk uit
   `referentie/server/adapters/`: `sqlite.mjs` (node:sqlite, voor Node op een eigen VPS of server,
   Replit, Railway of Render met een schijf) of `postgres.mjs` (voor platforms die Postgres geven,
   zoals Supabase achter Lovable en Bolt, Railway en Render). Kies wat de gebruiker al gebruikt; zie
   de README, "Andere routes", voor hoe je per route start.
3. **Vooraf ingesproken audio.** De browser van de Tesla heeft geen spraak (`speechSynthesis` geeft
   geen stemmen). Maak de zinnen dus vooraf als audio met een tekst-naar-spraakdienst naar keuze, en
   bundel ze tot één bestand per taal (zie stap 5).
4. **De kaart uit OpenStreetMap.** Wegen met `maxspeed`, flitsers (`highway=speed_camera`) en
   trajectcontroles (relaties `type=enforcement`). Vooraf gebouwd in vakken, omdat een live
   Overpass-vraag in de auto vaak te traag is. Altijd met de naamsvermelding
   "© OpenStreetMap-bijdragers, ODbL" in de voet van de site en op een infopagina.

## Stappen

### Stap 1. Keuzes van de gebruiker

Vraag:

- de naam van de app en een `id` (kleine letters, cijfers en `-`);
- de host (zie bouwsteen 2);
- de talen (de referentie heeft Nederlands en Engels);
- de landen waar de app meldingen aanneemt. Alleen landen die in `landen.json` op `aan` staan
  komen in aanmerking. Een land laten uitstaan mag altijd.

### Stap 2. De site

Neem `referentie/site/` als basis. Pas de naam en de teksten aan. Laat staan:

- de voet met de naamsvermelding van OpenStreetMap;
- het laden van `data/landen.json` en `data/grenzen.json`, zodat de flitslaag uit staat in elk land
  dat niet aan staat;
- de tekst dat de borden langs de weg altijd voorgaan.

Schrijf een `over.html` met: wie de beheerder is, de bronnen en licenties, de landen, en wat er met
de positie gebeurt (zie `referentie/site/over.html` als sjabloon).

### Stap 3. De kaart en de flitsers

Nodig: Node 22 of nieuwer en `osmium-tool`. Download per land een extract van Geofabrik in een eigen
lege map buiten de repo. Er wordt niets uit de download uitgevoerd; osmium leest hem als data.

    node --max-old-space-size=8000 referentie/scripts/bouw-kaart.mjs <werkmap> <land.osm.pbf> ...
    node referentie/scripts/flitsers-uit-pbf.mjs <werkmap> <land.osm.pbf> ...
    node referentie/scripts/bouw-flitsers.mjs
    node referentie/scripts/haal-grenzen.mjs

Zet `RIJHULP_CONTACT` op je eigen site of e-mail, zodat de beheerders van Overpass weten wie vraagt.
De uitvoer (`site/kaart/`, `site/data/`) is een afgeleide database van OpenStreetMap onder de ODbL.
Zet hem niet in een openbare repo zonder die licentie; de scripts bouwen hem opnieuw. Herhaal dit
eens per maand.

### Stap 3b. Matrixborden (alleen Nederland, mag je overslaan)

De open feed van NDW (`https://opendata.ndw.nu/Matrixsignaalinformatie.xml.gz`, CC0 1.0, zonder
sleutel, elke minuut nieuw) zegt wat de matrixborden boven de snelweg nu tonen, maar heeft geen
coordinaten en geen CORS. Download daarom eenmalig de locatietabel
`https://opendata.ndw.nu/ndw_msi_shapefiles_latest.zip` in een eigen lege map buiten de repo, pak
hem uit en draai:

    node referentie/scripts/bouw-msi.mjs <map met MSI/shapes.shp>

Dat maakt `site/msi/<vak>.json` (de plek van elk bord, per kaartvak) en `server/msi-vakken.json`
(welke borden in welk vak). De server haalt de feed dan hooguit eens per minuut op bij een
verzoek op `/api/msi?vak=`; de app toont de limiet met rode rand in plaats van de vaste limiet,
een advies (zonder rode rand) klein onder het bord, de stroken met rode kruizen, en zegt alleen
iets bij een lagere limiet. Vermeld NDW in de voet en in `over.html`. Herhaal de tabel eens per
maand.

### Stap 4. De server

Neem `referentie/server/` over. De migraties staan in `server/migraties/` (SQLite); voor Postgres
is het `server/adapters/postgres-schema.sql`. Zet bij je host:

- de database (`env.DB`): de database van de host als die de kleine database-interface al geeft,
  anders `sqliteDb(...)` uit `adapters/sqlite.mjs` of `postgresDb(client)` uit
  `adapters/postgres.mjs`;
- `APP_ID`: je `id`;
- `FEED_SLEUTEL`: de geheime sleutel uit `node referentie/scripts/maak-sleutel.mjs <pad-buiten-de-repo>`.
  Zet hem als geheim bij de host, nooit in code of in de repo.

Bundel de grenzen (`site/data/grenzen.json`, het veld `landen`) mee als `const GRENZEN`, of geef ze
mee aan `maakServer`. Met matrixborden (stap 3b) ook `server/msi-vakken.json` als
`const MSI_VAKKEN` (of `maakServer({ msiVakken })`), en sta bij je host uitgaand verkeer naar
`opendata.ndw.nu` toe (op Hypamoon: `allowed_hosts: ["opendata.ndw.nu"]` in deploy_app). Lokaal proberen kan met `node referentie/scripts/lokaal.mjs 8787`; datzelfde
script is ook de server voor Node op een VPS, Replit, Railway of Render (zie de README). Stuurt je
host alleen `/api` naar de server, gebruik dan `/api/feed` als adres van je feed.

Controleer: `npm test` (de server, de feed, de limieten en de tussenstukken).

### Stap 5. Het geluid

De zinnen staan in `referentie/scripts/zinnen.mjs`. Maak per zin een mp3 met een
tekst-naar-spraakdienst naar keuze (let op de voorwaarden: het geluid moet je mogen publiceren), in
`data-bron/stem/<taal>/<naam>.mp3`. Daarna bundelt `bouw-geluid.mjs` ze tot één Ogg Opus per taal
in `site/geluid/<taal>.json` (dat script gebruikt `afconvert` van macOS; op een ander systeem doet
`ffmpeg` hetzelfde). Luister alles één keer na, ook de getallen. De zin `matrix_limiet` ("Matrixbord. De
limiet is") gaat voor een getal, alleen nodig met matrixborden.

### Stap 6. Andere feeds lezen

Lees de feeds uit `deelnemers.json` vanaf je eigen server, niet vanuit de browser van de bestuurder
(privacy, zie PROTOCOL.md hoofdstuk 9). Gebruik `protocol/feed.mjs`: die controleert de
handtekening, de vorm en de landregels. Voeg meldingen samen zoals PROTOCOL.md hoofdstuk 5
beschrijft en geef ze via je eigen `/api/meldingen` door aan je app. Kies zelf welke deelnemers je
leest, en laat een feed weg die rommel stuurt.

### Stap 7. Proefrit

Maak een nep-rit langs een flitser met `referentie/scripts/maak-simroute.mjs` en speel hem af in
de browser met `?sim=<naam>`. Rij pas echt als alles klopt, en laat de bestuurder de app nooit
tijdens het rijden instellen.

### Stap 8. Meedoen

Volg `CONTRIBUTING.md` om je app in `deelnemers.json` te zetten.

## Grenzen

- Bouw geen radar- of laserdetectie, geen stoorzender en niets om een verbod te omzeilen.
- Volg `landen.json`. Strenger mag, ruimer niet.
- Bewaar geen IP-adres, toestel-id of account bij een melding; alleen hashes met een dagzout.
- De beheerder van de app, dat is de gebruiker van dit recept, is verantwoordelijk voor zijn app.
