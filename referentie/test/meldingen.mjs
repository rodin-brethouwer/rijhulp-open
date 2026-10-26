// De server van de gemelde flitsers (server/server.mjs) tegen node:sqlite (of Postgres, zie
// db.mjs), met een eigen klok: melden, samenvoegen, stemmen, verlopen, de limieten en alleen in landen die aan staan.
// node test/meldingen.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { maakServer, REGELS, vakVan } from "../server/server.mjs";
import { testDb } from "./db.mjs";

const { DB, soort, sluit } = await testDb();
const rijen = async (q) => (await DB.prepare(q).all()).results;
const tel = async (q, ...a) => Number((await DB.prepare(q).bind(...a).first()).n);
const grenzen = JSON.parse(fs.readFileSync(new URL("./grenzen-proef.json", import.meta.url))).landen;
let klok = Date.parse("2026-10-27T09:00:00Z");
const server = maakServer({ grenzen, nu: () => klok, zonderCache: true });
const env = { DB };
const MIN = 60e3;

async function vraag(pad, body, ip = "1.2.3.4") {
  const r = await server.fetch(new Request("https://rijhulp.example" + pad, body ? { method: "POST", body: JSON.stringify(body), headers: { "x-real-ip": ip, "user-agent": "Tesla" } } : { headers: { "x-real-ip": ip } }), env, null);
  return { status: r.status, j: await r.json() };
}
const A = "toestel-aaaaaaaaaaaaaaaa", B = "toestel-bbbbbbbbbbbbbbbb", C = "toestel-cccccccccccccccc", D = "toestel-dddddddddddddddd";
const plek = { lat: 52.0262, lon: 4.5349, koers: 10 }; // N209 bij Bleiswijk

// Melden en ophalen per vak.
let r = await vraag("/api/meldingen", { toestel: A, ...plek, nauwkeurig: 5 });
assert.equal(r.status, 201, JSON.stringify(r.j));
const id = r.j.melding.id;
assert.equal(r.j.melding.verloopt, klok + REGELS.basisMin * MIN);
r = await vraag("/api/meldingen?vak=" + vakVan(plek.lat, plek.lon));
assert.equal(r.j.meldingen.length, 1);
assert.equal(r.j.meldingen[0].koers, 10);
assert.ok(!("melder" in r.j.meldingen[0]), "de melder-hash gaat niet naar buiten");
console.log("ok  melden en ophalen per vak");

// Geen IP en geen toestel-id in de database.
const alles = JSON.stringify([await rijen("SELECT * FROM meldingen"), await rijen("SELECT * FROM acties"), await rijen("SELECT * FROM stemmen")]);
assert.ok(!alles.includes("1.2.3.4") && !alles.includes(A), "IP of toestel-id staat in de database");
console.log("ok  geen IP en geen toestel-id bewaard");

// Geen reeks: A meldt binnen vijf minuten nog een keer (ergens anders).
r = await vraag("/api/meldingen", { toestel: A, lat: 52.1, lon: 4.6, koers: 90 });
assert.equal(r.status, 429); assert.equal(r.j.fout, "te_snel");
console.log("ok  geen twee meldingen binnen vijf minuten per toestel");

// Buiten de landen die aan staan (Keulen, Parijs, de Noordzee); de test gebruikt rechthoeken.
for (const [lat, lon] of [[50.94, 6.96], [48.86, 2.35], [52.6, 3.5]]) {
  r = await vraag("/api/meldingen", { toestel: D, lat, lon, koers: 0 });
  assert.equal(r.status, 403, `${lat},${lon}`);
}
r = await vraag("/api/meldingen", { toestel: D, lat: 50.85, lon: 4.35, koers: 0, nauwkeurig: 8 }); // Brussel
assert.equal(r.status, 201);
console.log("ok  alleen binnen de landen die aan staan");

// Samenvoegen: B meldt 80 m verder in dezelfde richting: telt als een ja.
klok += 10 * MIN;
r = await vraag("/api/meldingen", { toestel: B, lat: plek.lat + 0.0007, lon: plek.lon, koers: 15 });
assert.equal(r.status, 200); assert.equal(r.j.samengevoegd, true); assert.equal(r.j.melding.id, id); assert.equal(r.j.melding.ja, 1);
// Andere kant op: een eigen melding.
klok += 6 * MIN;
r = await vraag("/api/meldingen", { toestel: B, lat: plek.lat + 0.0007, lon: plek.lon, koers: 190 });
assert.equal(r.status, 201);
const tegen = r.j.melding.id;
console.log("ok  zelfde plek en richting wordt samengevoegd, andere richting niet");

// Stemmen: de melder nog niet binnen twintig minuten (hier 16), een ander één keer.
r = await vraag(`/api/meldingen/${id}/stem`, { toestel: A, ja: true });
assert.equal(r.status, 409);
r = await vraag(`/api/meldingen/${id}/stem`, { toestel: C, ja: true });
assert.equal(r.status, 200); assert.equal(r.j.melding.ja, 2);
assert.equal(r.j.melding.verloopt, Math.max(Date.parse("2026-10-27T12:00:00Z"), klok + REGELS.jaMin * MIN));
r = await vraag(`/api/meldingen/${id}/stem`, { toestel: C, ja: false });
assert.equal(r.j.al, true); assert.equal(r.j.melding.nee, 0);
console.log("ok  één stem per toestel, de melder niet binnen twintig minuten");

// Ja houdt hem langer, maar nooit langer dan acht uur.
let gemaakt = Date.parse("2026-10-27T09:00:00Z");
for (let i = 0; i < 6; i++) {
  klok += 70 * MIN;
  r = await vraag(`/api/meldingen/${id}/stem`, { toestel: "ja-toestel-" + i + "-xxxxxxxx", ja: true }, "9.9.9." + i);
  assert.equal(r.status, 200, JSON.stringify(r.j));
}
assert.equal(r.j.melding.verloopt, gemaakt + REGELS.maxUur * 3600e3);
klok = gemaakt + REGELS.maxUur * 3600e3 + 1;
r = await vraag("/api/meldingen?vak=" + vakVan(plek.lat, plek.lon));
assert.ok(!r.j.meldingen.some((m) => m.id === id), "na acht uur weg");
console.log("ok  ja verlengt, hooguit acht uur");

// Nee: één nee kort hem in, twee nee (meer dan ja) en hij is weg.
klok = Date.parse("2026-10-27T09:16:00Z") + 30 * MIN;
r = await vraag(`/api/meldingen/${tegen}/stem`, { toestel: C, ja: false });
assert.equal(r.j.melding.verloopt, klok + REGELS.neeMin * MIN);
klok += MIN;
r = await vraag(`/api/meldingen/${tegen}/stem`, { toestel: D, ja: false });
assert.equal(r.j.melding.weg, true);
r = await vraag("/api/meldingen?vak=" + vakVan(plek.lat, plek.lon));
assert.ok(!r.j.meldingen.some((m) => m.id === tegen));
r = await vraag(`/api/meldingen/${tegen}/stem`, { toestel: A, ja: true });
assert.equal(r.status, 404);
console.log("ok  nee kort in, twee nee en hij is weg");

// Vanzelf verlopen na drie uur zonder stemmen.
klok = Date.parse("2026-10-28T08:00:00Z");
r = await vraag("/api/meldingen", { toestel: C, lat: 51.92, lon: 4.47, koers: 200 }, "5.5.5.5"); // Rotterdam
assert.equal(r.status, 201);
klok += REGELS.basisMin * MIN - 1;
assert.equal((await vraag("/api/meldingen?vak=" + vakVan(51.92, 4.47))).j.meldingen.length, 1);
klok += 2;
{ const x = (await vraag("/api/meldingen?vak=" + vakVan(51.92, 4.47))).j; assert.equal(x.meldingen.length, 0, JSON.stringify(x)); }
console.log("ok  zonder stemmen weg na drie uur");

// Limiet per dag per toestel, en per vingerafdruk binnen tien minuten.
klok = Date.parse("2026-10-29T06:00:00Z");
let n201 = 0, laatste;
for (let i = 0; i < REGELS.perToestelDag + 2; i++) {
  laatste = await vraag("/api/meldingen", { toestel: A, lat: 52 + i * 0.01, lon: 5 + i * 0.01, koers: 0 }, "7.7.7." + i);
  if (laatste.status === 201) n201++;
  klok += REGELS.tussenMin * MIN + 1000;
}
assert.equal(n201, REGELS.perToestelDag); assert.equal(laatste.j.fout, "dag_vol");
klok = Date.parse("2026-10-30T06:00:00Z");
const uitslagen = [];
for (let i = 0; i < REGELS.perVingerTienMin + 1; i++) uitslagen.push((await vraag("/api/meldingen", { toestel: "vinger-" + i + "-xxxxxxxxxxxx", lat: 52.3 + i * 0.01, lon: 5.2, koers: 0 }, "8.8.8.8")).status);
assert.deepEqual(uitslagen, [...Array(REGELS.perVingerTienMin).fill(201), 429]);
console.log("ok  limiet per toestel per dag en per vingerafdruk per tien minuten");

// Het zout van gisteren is weg, oude rijen ook.
assert.equal(await tel("SELECT COUNT(*) AS n FROM zout"), 1);
assert.equal(await tel("SELECT COUNT(*) AS n FROM acties WHERE t < ?", klok - 26 * 3600e3), 0);
console.log("ok  dagzout en oude acties opgeruimd");

// Rommel.
assert.equal((await vraag("/api/meldingen", { toestel: "kort", lat: 52, lon: 5 })).status, 400);
assert.equal((await vraag("/api/meldingen?vak=abc")).status, 400);
assert.equal((await vraag("/api/meldingen", { toestel: B, lat: 52.2, lon: 5.1, koers: 0, nauwkeurig: 400 })).status, 422);
console.log("ok  foute invoer geweigerd");

// Eén gebruiker: meldt, passeert na 25 minuten en zegt ja, later nee.
{
  const E = "toestel-eeeeeeeeeeeeeeee", ip = "6.6.6.6";
  const p = { lat: 51.44, lon: 5.48, koers: 270 }; // Eindhoven
  const t0 = Date.parse("2026-11-02T10:00:00Z");
  klok = t0;
  r = await vraag("/api/meldingen", { toestel: E, ...p, nauwkeurig: 6 }, ip);
  assert.equal(r.status, 201);
  const eid = r.j.melding.id;
  klok = t0 + 5 * MIN; // direct na het melden langs: nog geen vraag, de server weigert ook
  r = await vraag(`/api/meldingen/${eid}/stem`, { toestel: E, ja: true }, ip);
  assert.equal(r.status, 409); assert.equal(r.j.fout, "eigen");
  klok = t0 + (REGELS.eigenNaMin - 1) * MIN;
  assert.equal((await vraag(`/api/meldingen/${eid}/stem`, { toestel: E, ja: false }, ip)).status, 409);
  klok = t0 + 25 * MIN; // na 25 minuten: ja telt als elke ja
  r = await vraag(`/api/meldingen/${eid}/stem`, { toestel: E, ja: true }, ip);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.melding.ja, 1); assert.equal(r.j.melding.laatste_ja, klok);
  assert.equal(r.j.melding.verloopt, Math.max(t0 + REGELS.basisMin * MIN, klok + REGELS.jaMin * MIN));
  klok = t0 + 30 * MIN; // dezelfde passage of vlak erna: niet nog een stem
  r = await vraag(`/api/meldingen/${eid}/stem`, { toestel: E, ja: false }, ip);
  assert.equal(r.j.al, true); assert.equal(r.j.melding.nee, 0);
  klok = t0 + (25 + REGELS.eigenTussenMin) * MIN - 1;
  assert.equal((await vraag(`/api/meldingen/${eid}/stem`, { toestel: E, ja: true }, ip)).j.al, true);
  klok = t0 + 160 * MIN; // later weer ja: houdt hem nog twee uur
  r = await vraag(`/api/meldingen/${eid}/stem`, { toestel: E, ja: true }, ip);
  assert.equal(r.j.melding.ja, 2); assert.equal(r.j.melding.verloopt, klok + REGELS.jaMin * MIN);
  assert.equal(await tel("SELECT COUNT(*) AS n FROM stemmen WHERE melding = ?", eid), 1, "de melder heeft één rij in stemmen");
  klok = t0 + 200 * MIN; // en nog later nee: meteen weg
  r = await vraag(`/api/meldingen/${eid}/stem`, { toestel: E, ja: false }, ip);
  assert.equal(r.status, 200); assert.equal(r.j.melding.weg, true); assert.equal(r.j.melding.nee, 1);
  assert.ok(!(await vraag("/api/meldingen?vak=" + vakVan(p.lat, p.lon))).j.meldingen.some((m) => m.id === eid));
  const inhoud = JSON.stringify([await rijen("SELECT * FROM meldingen"), await rijen("SELECT * FROM acties"), await rijen("SELECT * FROM stemmen")]);
  assert.ok(!inhoud.includes(E) && !inhoud.includes(ip), "toestel-id of IP bewaard");
  console.log("ok  melder: geen stem binnen twintig minuten, daarna ja zoals elke ja, eens per twintig minuten, nee meteen weg");

  // Opnieuw melden op dezelfde plek na 25 minuten telt ook als zijn ja; binnen 20 minuten niet.
  klok = Date.parse("2026-11-02T15:00:00Z");
  r = await vraag("/api/meldingen", { toestel: E, ...p }, ip);
  const fid = r.j.melding.id;
  klok += 10 * MIN;
  r = await vraag("/api/meldingen", { toestel: E, ...p }, ip);
  assert.equal(r.j.samengevoegd, true); assert.equal(r.j.melding.ja, 0);
  klok += 15 * MIN;
  r = await vraag("/api/meldingen", { toestel: E, ...p }, ip);
  assert.equal(r.j.melding.id, fid); assert.equal(r.j.melding.ja, 1);
  console.log("ok  melder meldt opnieuw: pas na twintig minuten een ja");

  // Na de wissel van het dagzout is de melder een andere gebruiker: één gewone stem.
  klok = Date.parse("2026-11-02T23:50:00Z");
  r = await vraag("/api/meldingen", { toestel: E, lat: 51.45, lon: 5.6, koers: 90 }, ip);
  const gid = r.j.melding.id;
  klok = Date.parse("2026-11-03T00:05:00Z"); // 15 minuten later, maar een nieuwe dag
  r = await vraag(`/api/meldingen/${gid}/stem`, { toestel: E, ja: false }, ip);
  assert.equal(r.status, 200); assert.ok(!r.j.melding.weg); assert.equal(r.j.melding.verloopt, klok + REGELS.neeMin * MIN);
  klok += 30 * MIN - 1;
  assert.equal((await vraag(`/api/meldingen/${gid}/stem`, { toestel: E, ja: true }, ip)).j.al, true);
  console.log("ok  na middernacht (UTC) telt de melder als een ander");
}
await sluit();
console.log("alles goed (" + soort + ")");
