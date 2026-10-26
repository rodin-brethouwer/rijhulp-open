# Referentie

Code van een werkende rijhulp (MIT), afgeleid van Blitzla op https://blitzla.hypamoon.app.

- `site/`: de statische site (`index.html`, `over.html` als sjabloon, `js/`, service worker).
- `server/`: de server voor gemelde flitsers en de feed uit PROTOCOL.md, met migraties. De server
  verwacht een kleine database-interface (`prepare().bind().first/all/run` en `batch`).
- `server/adapters/`: die interface op `node:sqlite` (`sqlite.mjs`) en op Postgres (`postgres.mjs`,
  met `postgres-schema.sql`), voor Node op een VPS, Replit, Railway, Render of Supabase.
- `scripts/`: kaart, flitsers en grenzen uit OpenStreetMap bouwen, geluid bundelen, een
  sleutelpaar maken, lokaal draaien, een proefrit maken.
- `test/`: `meldingen.mjs` (server), `feed.mjs` (feed en handtekening), `limiet.mjs` (maxspeed lezen en
  tijdvoorwaarden in de tijdzone van het land), `afrit.mjs` (links naast de snelweg, op een nepkaart),
  `adapters.mjs` (de tussenstukken), `msi.mjs` (matrixborden). Met `RIJHULP_TEST_PG=<postgres-url>` draait `meldingen.mjs`
  tegen Postgres.

Wat niet in de repo staat en wat je zelf bouwt (zie RECEPT.md): `site/kaart/`, `site/data/`
(OSM-data onder de ODbL), `site/geluid/` (je eigen ingesproken zinnen) en `site/sim/` (proefritten).

Snel proberen: `npm test` in de wortel, daarna `npm run lokaal` (na het bouwen van de data).
`scripts/lokaal.mjs` is ook de server voor Node in productie; zie de README, "Andere routes".
