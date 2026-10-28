# Referentie

Code van een werkende rijhulp (MIT), afgeleid van Blitzla op https://blitzla.hypamoon.app.

- `site/`: de statische site (`index.html`, `over.html` als sjabloon, `js/`, service worker).
- `server/`: de server voor gemelde flitsers en de feed uit PROTOCOL.md, met migraties. De server
  verwacht een kleine database-interface (`prepare().bind().first/all/run` en `batch`).
- `server/adapters/`: die interface op `node:sqlite` (`sqlite.mjs`) en op Postgres (`postgres.mjs`,
  met `postgres-schema.sql`), voor Node op een VPS, Replit, Railway, Render of Supabase.
- `scripts/`: kaart, flitsers en grenzen uit OpenStreetMap bouwen, geluid bundelen, een
  sleutelpaar maken, lokaal draaien, een proefrit maken.
- `test/`: `meldingen.mjs` (server, met een aanvalsproef), `feed.mjs` (feed en handtekening),
  `limiet.mjs` (maxspeed lezen en tijdvoorwaarden in de tijdzone van het land), `afrit.mjs` (links
  naast de snelweg, op een nepkaart), `adapters.mjs` (de tussenstukken), `msi.mjs` (matrixborden),
  `geluid.mjs` (de wachtrij van het geluid). Met `RIJHULP_TEST_PG=<postgres-url>` draait
  `meldingen.mjs` tegen Postgres. Na het bouwen van de data en de proefritten (`n209`, en `a12-zn`
  met `node scripts/maak-simroute.mjs a12-zn 52.05075 4.4400 277 kaart:motorway 100 4500 3300`):
  `rit.mjs`, `traject.mjs` (trajectcontrole) en `ruis.mjs` (GPS-ruis, sprongen, herladen).

Wat niet in de repo staat en wat je zelf bouwt (zie RECEPT.md): `site/kaart/`, `site/data/`
(OSM-data onder de ODbL), `site/geluid/` (je eigen ingesproken zinnen) en `site/sim/` (proefritten).

Snel proberen: `npm test` in de wortel, daarna `npm run lokaal` (na het bouwen van de data).
`scripts/lokaal.mjs` is ook de server voor Node in productie; zie de README, "Andere routes".

Tegen misbruik (sinds 26 okt 2026): de server neemt alleen POST aan met `Content-Type:
application/json` en zonder vreemde `Origin`, geeft zelf de toestel-ids uit (`POST /api/toestel`,
ondertekend met een sleutel in de tabel `sleutel`), en telt limieten per IP-hash en per /24 of /48.
Draai je `scripts/lokaal.mjs` achter een proxy, zet dan `RIJHULP_PROXY=1` (anders hebben alle
bezoekers het IP van de proxy en raken ze samen de limiet) en `RIJHULP_HERKOMST=https://jouw.site`
(anders weigert de server elke POST van de echte site met 403). Met `RIJHULP_PROXY=1` telt het
laatste adres in `X-Forwarded-For`, het adres dat je eigen proxy toevoegt; de adressen ervoor kan
een bezoeker zelf meesturen. Staat er nog een laag voor (Cloudflare voor nginx), zet dan
`RIJHULP_IP_KOP=cf-connecting-ip`, of laat nginx `X-Real-IP` zetten en kies `RIJHULP_IP_KOP=x-real-ip`.
Doe dat alleen als elk verzoek langs die proxy moet. Sinds 28 okt 2026 boekt de server een actie
eerst en telt hij daarna (een burst van parallelle verzoeken glipt niet meer samen onder een
grens door), tellen nee-stemmen van verschillende IP's alleen binnen dezelfde UTC-dag, en meldt
of stemt een proefrit (`?sim=`) niet op een echte site.
