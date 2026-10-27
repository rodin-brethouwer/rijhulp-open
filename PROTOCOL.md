# Protocol rijhulp-open, versie 0.1

Status: concept, versie 0.1 (25 oktober 2026). Dit document staat onder CC BY 4.0 (zie LICENSE).

Dit protocol beschrijft hoe losse rijhulp-apps elkaars gemelde flitsers kunnen lezen. Er is geen
centrale server en geen beheerder. Elke app draait bij zijn eigen beheerder, biedt een eigen feed aan
en kiest zelf welke andere feeds hij leest. De deelnemerslijst (`deelnemers.json`) is alleen een
adresboek met publieke sleutels.

De woorden MOET, MAG NIET, HOORT en MAG hebben de betekenis van RFC 2119 (MUST, MUST NOT, SHOULD, MAY).

## 1. Begrippen

| Begrip | Betekenis | English |
|---|---|---|
| melding | een door een gebruiker gemelde flitser op een plek, met een rijrichting | report |
| vak | een rechthoek van 0,2 graad breedte bij 0,3 graad lengte (ca. 22 x 20 km) | tile |
| feed | de lijst actieve meldingen van één app in één vak, als JSON | feed |
| stem | een ja (staat er nog) of nee (staat er niet meer) op een melding | vote |
| deelnemer | een app met een regel in `deelnemers.json` | participant |
| beheerder | de persoon of organisatie die een app draait en ervoor verantwoordelijk is | operator |

## 2. Het kaartvak

Een vak heeft een sleutel `<i>_<j>` met

    i = floor(lat / 0.2)
    j = floor(lon / 0.3)

Voorbeeld: Bleiswijk (52.0262, 4.5349) ligt in vak `260_15`. Negatieve getallen mogen
(`-171_-2`). Zonder voorloopnullen: een server HOORT `0260_015` te lezen als `260_15` (en zo in
het antwoord te zetten), zodat elke schrijfwijze van een vak in dezelfde cache valt. Dit is dezelfde indeling als de kaartvakken van de referentie-implementatie (10 x 10
tegels van 0,02 x 0,03 graad). Een app die een vak vraagt, vraagt het vak onder de auto en de
buurvakken waar de auto binnen enkele kilometers in rijdt.

## 3. Een melding

```json
{
  "id": "4711",
  "soort": "mobiele_flitser",
  "lat": 52.0262,
  "lon": 4.5349,
  "koers": 10,
  "gemaakt": 1793091600000,
  "verloopt": 1793102400000,
  "ja": 2,
  "nee": 0,
  "laatste_ja": 1793095200000
}
```

| Veld | Type | Regel |
|---|---|---|
| `id` | string, 1 tot 64 tekens | uniek binnen de app; de sleutel over alle apps heen is `<app>:<id>` |
| `soort` | string | in 0.1 alleen `mobiele_flitser`; onbekende soorten MOET een lezer overslaan, niet de hele feed weigeren |
| `lat`, `lon` | getal, WGS84 | MOET afgerond zijn op 4 decimalen (ca. 11 m); meer precisie MAG NIET |
| `koers` | geheel getal 0 tot 359, of `null` | de rijrichting van de melder in graden (0 = noord, met de klok mee); `null` als onbekend |
| `gemaakt` | geheel getal | tijd van de melding in milliseconden sinds 1970 (UTC) |
| `verloopt` | geheel getal | tot wanneer de melding geldt, idem; MOET groter zijn dan `gemaakt` en hooguit 8 uur erna |
| `ja`, `nee` | geheel getal, 0 of meer | aantal stemmen bij de app zelf |
| `laatste_ja` | geheel getal of `null` | tijd van de laatste ja |

Er staat niets in een melding over de melder: geen toestel-id, geen hash, geen account, geen IP.
Zie hoofdstuk 9.

Vaste flitsers, roodlichtcamera's en trajectcontroles horen niet in de feed. Die komen uit
OpenStreetMap (`highway=speed_camera`, relaties `type=enforcement`); elke app bouwt ze zelf.

## 4. De feed

Elke deelnemer biedt aan:

    GET <feed-url>?vak=<i>_<j>

Antwoord `200`, `Content-Type: application/json; charset=utf-8`:

```json
{
  "protocol": "0.1",
  "app": "voorbeeld-rijhulp",
  "vak": "260_15",
  "nu": 1793095500000,
  "meldingen": [ { "...": "zie hoofdstuk 3" } ],
  "stemmen": [
    { "melding": "andere-app:88", "ja": 1, "nee": 0, "laatste": 1793095400000 }
  ]
}
```

- `app` MOET gelijk zijn aan het `id` van de deelnemer in `deelnemers.json`.
- `vak` MOET gelijk zijn aan het gevraagde vak, en elke melding MOET in dat vak liggen.
- `nu` is de klok van de server. Een lezer HOORT een feed te weigeren waarvan `nu` meer dan 5
  minuten van zijn eigen klok afwijkt (zo is een oude, opnieuw afgespeelde feed niets waard).
- `meldingen` bevat alleen actieve meldingen (`verloopt` na `nu`), hooguit 300, nieuwste eerst.
- `stemmen` (MAG leeg zijn) bevat de stemmen die gebruikers van deze app gaven op meldingen van
  andere apps, opgeteld per melding. Zo gaat een stem nooit als schrijfactie naar een andere server:
  elke app publiceert alleen wat zijn eigen gebruikers deden.
- Een onbekend of fout vak geeft `400` met `{ "fout": "vak" }`.
- De server HOORT `Cache-Control: public, max-age=15` (of langer, hooguit 60) mee te sturen.
- `Access-Control-Allow-Origin: *` MAG. Zie wel hoofdstuk 9 over ophalen vanaf de server.

## 5. Stemmen en verlopen

Elke app beslist zelf hoe hij meldingen combineert. Dit zijn de aanbevolen regels (de referentie
gebruikt ze, `REGELS` in `referentie/server/server.mjs`):

- Een nieuwe melding leeft 3 uur.
- Elke ja: de melding geldt nog minstens 2 uur vanaf die ja, maar nooit langer dan 8 uur na `gemaakt`.
- Een nee: de melding geldt hooguit nog 30 minuten. Nee van twee of meer verschillende IP-hashes
  en meer nee dan ja: meteen weg. Tien nee van één IP tellen hiervoor als één.
- Een nieuwe melding binnen 200 m van een bestaande, met een koers die minder dan 60 graden afwijkt,
  is geen nieuwe melding maar een ja op de bestaande. Dat geldt ook over apps heen: een lezer HOORT
  meldingen van verschillende apps op die manier samen te voegen voordat hij waarschuwt.
- Eén stem per toestel per melding. Het toestel-id geeft de server uit (ondertekend), niet de
  client; een stem van een id dat vandaag is uitgegeven telt niet mee voor het meteen weghalen.
  De melder zelf stemt pas als zijn melding minstens 20 minuten
  oud is; zijn nee haalt zijn eigen melding meteen weg.
- Een lezer telt de stemmen van een melding op uit de eigen feed van de melder plus de `stemmen` uit
  de andere feeds die hij vertrouwt.

Een lezer MAG NIET waarschuwen voor een melding waarvan `verloopt` voorbij is, ook niet als hij
hem nog in een cache heeft.

## 6. Ondertekening

Elke feed MOET ondertekend zijn met Ed25519.

- De handtekening gaat over de ruwe bytes van de body, precies zoals ze over de lijn gaan.
- De server stuurt hem mee in de kop `Rijhulp-Handtekening: ed25519=<handtekening in base64url, zonder =>`.
- De publieke sleutel (32 bytes, base64url) staat bij de deelnemer in `deelnemers.json` als
  `publieke_sleutel`.
- Een lezer MOET een feed zonder geldige handtekening weigeren, en een feed waarvan `app` niet
  past bij de sleutel waarmee hij gecontroleerd is.
- Elke lezer kiest zelf welke deelnemers hij leest. Een app die rommel stuurt, laat je weg uit je
  eigen lijst. Daar is geen centrale beslissing voor nodig, en niemand kan je dwingen een feed te lezen.
- Een nieuwe sleutel gaat via een pull request op `deelnemers.json`. Een oude sleutel MAG een korte
  tijd naast de nieuwe staan (`publieke_sleutel_vorige`).

Hulpmiddelen: `protocol/feed.mjs` (controleren en keuren), `referentie/scripts/maak-sleutel.mjs`
(sleutelpaar maken; de geheime sleutel komt in een bestand buiten de repo en nooit op het scherm).

## 7. Landregels

`landen.json` bevat de standaard landregels voor de flitslaag: per land `aan` of `uit`, met bron en
datum. Een land dat er niet in staat, staat uit.

- Een implementatie MOET deze standaard volgen: in een land dat uit staat, toont en zegt de app geen
  vaste en geen gemelde flitsers, neemt hij daar geen meldingen aan, en zet hij er geen in zijn feed.
- Een lezer MOET ook meldingen van andere apps weggooien die in een land liggen dat uit staat.
- Een beheerder MAG strenger zijn dan de standaard (een land uit zetten dat aan staat). Ruimer zijn
  MAG NIET binnen dit protocol; wie vindt dat een land aan kan, stelt een wijziging van
  `landen.json` voor met een bron (zie CONTRIBUTING.md).
- Dit protocol helpt niet bij het omzeilen van een wet. Geen detectie van radar of laser, geen
  stoorzenders, geen trucs om een verbod te ontlopen (zoals een "gevarenzone" die in feite de plek
  van een flitser is in een land waar dat verboden is). Zulke voorstellen worden niet opgenomen.
- `landen.json` is geen juridisch advies. Elke beheerder is zelf verantwoordelijk voor de wet in de
  landen waar zijn app werkt.

## 8. Limieten

Voor wie een feed aanbiedt:

- hooguit 300 meldingen per vak, body hooguit 256 kB;
- bij te veel verzoeken `429` met `Retry-After`.

Voor wie een feed leest:

- hooguit één verzoek per vak per minuut per deelnemer;
- een time-out van hooguit 5 seconden, en bij een fout terugvallen op de laatste goede stand;
- een eigen `User-Agent` met een contactadres.

Voor wie meldingen aanneemt van eigen gebruikers (aanbevolen, zoals de referentie):

- alleen POST met `Content-Type: application/json` (anders `415`) en zonder vreemde `Origin` of
  `Sec-Fetch-Site` (anders `403`): een POST met `text/plain` gaat zonder preflight, en dan kan elke
  andere site zijn bezoekers voor je laten melden of stemmen;
- toestel-ids alleen van de server (ondertekend, met de dag van uitgifte), hooguit 5 per IP per
  dag; een id van vandaag meldt hooguit 2 keer;
- per toestel niet twee meldingen binnen 5 minuten en hooguit 8 per dag;
- per vingerafdruk (gehasht IP plus browser) hooguit 6 per 10 minuten en 60 per dag;
- per IP (gehasht, zonder browser) hooguit 10 meldingen per uur en 30 per dag, en per /24 (IPv4)
  of /48 (IPv6) 30 per uur en 100 per dag: toestel-id en browser kiest de client zelf;
- per IP hooguit 30 stemmen per uur, per /24 of /48 hooguit 100;
- een melding alleen met een GPS-nauwkeurigheid van 100 m of beter;
- alleen in landen die aan staan.

## 9. Privacy

- In de feed staan geen toestel-, account- of persoonsgegevens. Ook geen hashes daarvan.
- Posities in de feed zijn afgerond op 4 decimalen.
- Een app bewaart het IP-adres en het toestel-id van een melder alleen als hash met een dagzout aan
  eigen kant: een willekeurig zout per dag (UTC) dat na die dag gewist wordt. Zo zijn limieten per
  dag te tellen, maar is niets over dagen heen aan elkaar te koppelen. Het IP-adres zelf komt niet in
  de database.
- Meldingen en stemmen worden uiterlijk een dag na het verlopen gewist.
- Haal feeds van andere apps op vanaf je eigen server, niet vanuit de browser van de bestuurder.
  Anders ziet de andere app het IP-adres van jouw gebruiker en het vak waar hij rijdt.
- De app vraagt meldingen per vak op, niet per exacte positie.

## 10. Versies

Dit is versie 0.1. Een lezer HOORT elke `protocol` die met `0.` begint te accepteren en velden die
hij niet kent te negeren. Een wijziging die bestaande lezers breekt, krijgt een nieuwe hoofdversie.
Voorstellen gaan via een issue of pull request op https://github.com/rodin-brethouwer/rijhulp-open.

## Bijlage: regel in deelnemers.json

```json
{
  "versie": "0.1",
  "deelnemers": [
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
  ]
}
```

`id`: kleine letters, cijfers en `-`, 3 tot 40 tekens, uniek in de lijst.
`landen`: de landen waarin de app meldingen aanneemt; altijd een deel van de landen die in
`landen.json` aan staan.
