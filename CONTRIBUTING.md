# Meedoen / Contributing

## Je app toevoegen aan deelnemers.json

1. Zorg dat je feed werkt volgens `PROTOCOL.md` (versie 0.1), ondertekend met Ed25519, en dat je
   app `landen.json` volgt.
2. Maak een fork van deze repo (https://github.com/rodin-brethouwer/rijhulp-open) en voeg één regel toe aan `deelnemers` in `deelnemers.json`:

   ```json
   {
     "id": "voorbeeld-rijhulp",
     "naam": "Voorbeeld Rijhulp",
     "feed": "https://rijhulp.example.org/feed",
     "publieke_sleutel": "<32 bytes Ed25519 in base64url>",
     "beheerder": "Naam of organisatie",
     "contact": "https://rijhulp.example.org/contact",
     "landen": ["NL", "BE"],
     "sinds": "2026-10-25"
   }
   ```

3. Controleer je feed: `node protocol/controleer-feed.mjs <id> <vak>`.
4. Open een pull request met in de beschrijving de URL van je app.

Wat een pull request niet is: een keuring. Opname in de lijst zegt niets over de kwaliteit van een
app. Elke lezer kiest zelf welke deelnemers hij leest. Een regel gaat uit de lijst als de feed lange
tijd niet werkt of als de beheerder erom vraagt.

Zet nooit een geheime sleutel, token of wachtwoord in een pull request.

## Landregels wijzigen

Een wijziging in `landen.json` heeft een bron nodig (een wettekst, een overheid of een
automobielclub) met datum. Een land strenger maken mag direct. Een land aan zetten alleen met een
bron die duidelijk zegt dat waarschuwen voor flitsers daar mag. Voorstellen die helpen een verbod
te omzeilen, worden niet opgenomen.

## Protocol en referentie

Voorstellen voor het protocol gaan eerst als issue. Wijzigingen in `referentie/` graag met een
test; `npm test` draait ze allemaal (`meldingen.mjs`, `feed.mjs`, `limiet.mjs`, `afrit.mjs`, `adapters.mjs`, `msi.mjs`).
Raakt je wijziging de SQL van de server, draai de servertest dan ook tegen Postgres:
`RIJHULP_TEST_PG=<postgres-url> node referentie/test/meldingen.mjs` (met het pakket `pg`). Een
tussenstuk voor een andere database hoort in `referentie/server/adapters/` en levert dezelfde
kleine database-interface (`prepare().bind().first/all/run` en `batch`).

## English

Add your app with a pull request that adds one entry to `deelnemers.json` (format above). Your feed
must follow `PROTOCOL.md` 0.1, be signed with Ed25519, and follow `landen.json`. Listing is not an
endorsement; every reader chooses which feeds to read. Changes to `landen.json` need a dated
source. Never put secrets in a pull request.
