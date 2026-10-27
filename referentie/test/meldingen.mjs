// De server van de gemelde flitsers (server/server.mjs) tegen node:sqlite (of Postgres, zie
// db.mjs), met een eigen klok: melden, samenvoegen, stemmen, verlopen, de limieten en alleen in landen die aan staan.
// node test/meldingen.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { maakServer, REGELS, vakVan, netVan, leesVak } from "../server/server.mjs";
import { testDb } from "./db.mjs";

const { DB, soort, sluit } = await testDb();
const rijen = async (q) => (await DB.prepare(q).all()).results;
const tel = async (q, ...a) => Number((await DB.prepare(q).bind(...a).first()).n);
const grenzen = JSON.parse(fs.readFileSync(new URL("./grenzen-proef.json", import.meta.url))).landen;
let klok = Date.parse("2026-10-27T09:00:00Z");
const server = maakServer({ grenzen, nu: () => klok, zonderCache: true });
const env = { DB };
const MIN = 60e3;

// Toestel-ids geeft de server uit (H1). In de test staat een naam voor een toestel; echt() haalt er
// één keer een id voor op, van een eigen IP en twee dagen eerder (dus niet "van vandaag").
const ids = new Map();
let uitgifte = 0;
async function echt(naam) {
  if (typeof naam !== "string" || naam === "kort" || /^b\d{5}/.test(naam)) return naam;
  if (!ids.has(naam)) {
    const n = ++uitgifte, bewaar = klok;
    klok -= 2 * 86400e3;
    const zoutVoor = new Set((await rijen("SELECT dag FROM zout")).map((z) => z.dag));
    const x = await server.fetch(new Request("https://rijhulp.example/api/toestel", { method: "POST", body: "{}", headers: { "x-real-ip": `100.${n >> 8}.${n & 255}.1`, "content-type": "application/json" } }), env, null);
    klok = bewaar;
    // Het zout dat alleen voor deze uitgifte ontstond, weer weg (zoals opruimen dat de volgende dag doet).
    for (const z of await rijen("SELECT dag FROM zout")) if (!zoutVoor.has(z.dag)) await DB.prepare("DELETE FROM zout WHERE dag = ?").bind(z.dag).run();
    await DB.prepare("DELETE FROM acties WHERE soort = 'toestel' AND t < ?").bind(bewaar - 26 * 3600e3).run();
    assert.equal(x.status, 201, "uitgifte");
    ids.set(naam, (await x.json()).toestel);
  }
  return ids.get(naam);
}
async function vraag(pad, body, ip = "1.2.3.4") {
  if (body && body.toestel) body = { ...body, toestel: await echt(body.toestel) };
  const r = await server.fetch(new Request("https://rijhulp.example" + pad, body ? { method: "POST", body: JSON.stringify(body), headers: { "x-real-ip": ip, "user-agent": "Tesla", "content-type": "application/json", origin: "https://rijhulp.example", "sec-fetch-site": "same-origin" } } : { headers: { "x-real-ip": ip } }), env, null);
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
assert.ok(!alles.includes("1.2.3.4") && !alles.includes(await echt(A)), "IP of toestel-id staat in de database");
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
// D zit achter hetzelfde IP als C: twee nee van één IP halen hem niet weg (H2).
r = await vraag(`/api/meldingen/${tegen}/stem`, { toestel: D, ja: false });
assert.equal(r.status, 200); assert.ok(!r.j.melding.weg, "twee nee van één IP"); assert.equal(r.j.melding.nee, 2);
klok += MIN;
r = await vraag(`/api/meldingen/${tegen}/stem`, { toestel: "toestel-gggggggggggggggg", ja: false }, "2.2.2.2");
assert.equal(r.j.melding.weg, true);
r = await vraag("/api/meldingen?vak=" + vakVan(plek.lat, plek.lon));
assert.ok(!r.j.meldingen.some((m) => m.id === tegen));
r = await vraag(`/api/meldingen/${tegen}/stem`, { toestel: A, ja: true });
assert.equal(r.status, 404);
console.log("ok  nee kort in, nee van twee verschillende IP's en hij is weg, van één IP niet");

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
  assert.ok(!inhoud.includes(await echt(E)) && !inhoud.includes(ip), "toestel-id of IP bewaard");
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
// H1: per IP een limiet, ook met elke keer een nieuw toestel-id en een nieuwe browser.
{
  const post = async (pad, body, ip, ua) => server.fetch(new Request("https://rijhulp.example" + pad, { method: "POST", body: JSON.stringify({ ...body, toestel: await echt(body.toestel) }), headers: { "x-real-ip": ip, "user-agent": ua, "content-type": "application/json" } }), env, null);
  klok = Date.parse("2026-11-06T06:00:00Z");
  const st = [];
  for (let i = 0; i < REGELS.perIpUur + 2; i++) {
    const x = await post("/api/meldingen", { toestel: "script-" + i + "-xxxxxxxxxxxxxx", lat: 52.0 + i * 0.02, lon: 5.3, koers: 0 }, "66.66.66.66", "Bot/" + i);
    st.push(x.status); klok += 1000;
  }
  assert.deepEqual(st, [...Array(REGELS.perIpUur).fill(201), 429, 429], "limiet per IP");
  // Over de dag: na een uur weer, tot perIpDag.
  let n = REGELS.perIpUur;
  for (let uur = 1; uur < 6; uur++) {
    klok = Date.parse("2026-11-06T06:00:00Z") + uur * 3600e3 + 60e3;
    for (let i = 0; i < REGELS.perIpUur; i++) {
      const x = await post("/api/meldingen", { toestel: `script-${uur}-${i}-xxxxxxxxxxxx`, lat: 51.5 + i * 0.02, lon: 4.0 + uur * 0.1, koers: 0 }, "66.66.66.66", "Bot/" + uur + i);
      if (x.status === 201) n++; klok += 1000;
    }
  }
  assert.equal(n, REGELS.perIpDag, "limiet per IP per dag");
  // Per /24: veel adressen in één net.
  klok = Date.parse("2026-11-07T06:00:00Z");
  let ok = 0, laatsteFout = null;
  for (let i = 0; i < REGELS.perNetUur + 5; i++) {
    const x = await post("/api/meldingen", { toestel: "net-" + i + "-xxxxxxxxxxxxxxxx", lat: 52.0 + i * 0.01, lon: 6.0, koers: 0 }, "77.1.2." + (i + 1), "Bot");
    if (x.status === 201) ok++; else laatsteFout = x.status; klok += 1000;
  }
  assert.equal(ok, REGELS.perNetUur); assert.equal(laatsteFout, 429);
  console.log("ok  limiet per IP en per net, los van toestel-id en browser");

  // H2: stemlimiet per IP.
  klok = Date.parse("2026-11-08T06:00:00Z");
  const m = await post("/api/meldingen", { toestel: "stemdoel-xxxxxxxxxxxxxxxx", lat: 52.2, lon: 4.6, koers: 0 }, "55.5.5.5", "x");
  assert.equal(m.status, 201);
  const mid = (await m.json()).melding.id;
  const ss = [];
  for (let i = 0; i < REGELS.stemmenPerIpUur + 1; i++) { ss.push((await post(`/api/meldingen/${mid}/stem`, { toestel: "stemmer-" + i + "-xxxxxxxxxxxx", ja: true }, "44.4.4.4", "Bot/" + i)).status); }
  assert.deepEqual(ss, [...Array(REGELS.stemmenPerIpUur).fill(200), 429], "stemlimiet per IP");
  // Een nee-script achter één IP haalt hem niet weg, hoeveel toestel-ids het ook verzint.
  klok = Date.parse("2026-11-09T06:00:00Z");
  const m2 = await (await post("/api/meldingen", { toestel: "stemdoel2-xxxxxxxxxxxxxxx", lat: 52.25, lon: 4.65, koers: 0 }, "55.5.5.6", "x")).json();
  let laatst;
  for (let i = 0; i < 20; i++) laatst = await (await post(`/api/meldingen/${m2.melding.id}/stem`, { toestel: "nee-" + i + "-xxxxxxxxxxxxxxxx", ja: false }, "33.3.3.3", "Bot/" + i)).json();
  assert.ok(!laatst.melding.weg, "20 nee van één IP"); assert.equal(laatst.melding.nee, 20);
  console.log("ok  stemlimiet per IP, nee alleen van verschillende IP's");
}
assert.equal(netVan("1.2.3.4"), "1.2.3"); assert.equal(netVan("::ffff:10.0.0.7"), "10.0.0");
assert.equal(netVan("2a02:a46:1:2::5"), "2a02:a46:1"); assert.equal(netVan("2a02:a46::1"), "2a02:a46:0"); assert.equal(netVan("2A02:0A46:0001:ffff:0:0:0:1"), "2a02:a46:1");
console.log("ok  net van IPv4 (/24) en IPv6 (/48)");

// M1: één schrijfwijze per vak, buiten NL en BE geen query, msi alleen bekende vakken, limiet per IP.
{
  assert.equal(leesVak("0260_016").vak, "260_16"); assert.equal(leesVak("260_16").vak, "260_16"); assert.equal(leesVak("-0_-01").vak, "0_-1");
  for (const fout of ["abc", "260", "260_16_1", "9999_1", "1_9999", "", null, "26O_16"]) assert.equal(leesVak(fout), null, String(fout));
  let queries = 0;
  const telDB = { prepare: (q) => { queries++; return DB.prepare(q); }, batch: DB.batch };
  const s2 = maakServer({ grenzen, nu: () => klok, msiVakken: { idLengte: 8, vakken: { "260_16": "aaaaaaaa" } }, fetch: async () => { throw new Error("geen net"); } });
  const haal = async (pad, ip = "12.12.12.12") => { const x = await s2.fetch(new Request("https://rijhulp.example" + pad, { headers: { "x-real-ip": ip } }), { DB: telDB }, null); return { status: x.status, j: await x.json() }; };
  const a = await haal("/api/meldingen?vak=260_16"), b = await haal("/api/meldingen?vak=0260_016");
  assert.equal(a.j.vak, "260_16"); assert.equal(b.j.vak, "260_16");
  assert.equal(queries, 1, "0260_016 komt uit dezelfde cache als 260_16");
  queries = 0;
  for (const vak of ["0_0", "300_16", "260_100", "-5_-5"]) { const x = await haal("/api/meldingen?vak=" + vak); assert.equal(x.status, 200); assert.deepEqual(x.j.meldingen, []); }
  assert.equal(queries, 0, "buiten NL en BE geen query");
  assert.equal((await haal("/api/meldingen?vak=99999_1")).status, 400);
  // msi: een vak zonder borden geeft leeg, zonder de feed te halen of iets te onthouden.
  const leeg = await haal("/api/msi?vak=0123_045");
  assert.equal(leeg.status, 200); assert.equal(leeg.j.vak, "123_45"); assert.deepEqual(leeg.j.borden, {});
  assert.equal((await haal("/api/msi?vak=constructor_1")).status, 400);
  assert.equal((await haal("/api/msi?vak=0260_016")).status, 503, "bekend vak: feed nodig (hier geen net)");
  // Limiet per IP op alle /api-routes.
  const s3 = maakServer({ grenzen, nu: () => klok, apiPerIpMin: 5 });
  const st = [];
  for (let i = 0; i < 7; i++) st.push((await s3.fetch(new Request("https://rijhulp.example/api/meldingen?vak=" + (i % 2 ? "0_0" : "260_16"), { headers: { "x-real-ip": "13.13.13.13" } }), env, null)).status);
  assert.deepEqual(st, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await s3.fetch(new Request("https://rijhulp.example/api/gezond", { headers: { "x-real-ip": "14.14.14.14" } }), env, null)).status, 200, "ander IP heeft eigen teller");
  klok += 60e3;
  assert.equal((await s3.fetch(new Request("https://rijhulp.example/api/gezond", { headers: { "x-real-ip": "13.13.13.13" } }), env, null)).status, 200, "volgende minuut weer");
  console.log("ok  vak in één schrijfwijze, leeg buiten NL/BE zonder query, msi alleen bekende vakken, limiet per IP op /api");
}

// H1: alleen ids van de server; een id van vandaag meldt hooguit versPerDag keer en weegt niet mee
// voor het meteen weghalen; per IP hooguit toestellenPerIpDag nieuwe ids per dag.
{
  klok = Date.parse("2026-11-10T08:00:00Z");
  const uitgeven = async (ip) => { const x = await server.fetch(new Request("https://rijhulp.example/api/toestel", { method: "POST", body: "{}", headers: { "x-real-ip": ip, "content-type": "application/json" } }), env, null); return { status: x.status, j: await x.json() }; };
  const meldMet = async (toestel, ip, lat = 52.4, lon = 4.9) => { const x = await server.fetch(new Request("https://rijhulp.example/api/meldingen", { method: "POST", body: JSON.stringify({ toestel, lat, lon, koers: 0 }), headers: { "x-real-ip": ip, "content-type": "application/json" } }), env, null); return { status: x.status, j: await x.json() }; };
  const u = [];
  for (let i = 0; i < REGELS.toestellenPerIpDag + 1; i++) u.push(await uitgeven("120.0.0.1"));
  assert.deepEqual(u.map((x) => x.status), [...Array(REGELS.toestellenPerIpDag).fill(201), 429], "uitgifte per IP per dag");
  const nieuw = u[0].j.toestel;
  assert.match(nieuw, /^b\d{5}[0-9a-f]{40}$/);
  // Zelf verzonnen, of met een vervalste handtekening, of te oud: geweigerd.
  assert.equal((await meldMet("zelf-verzonnen-toestel-id-1234", "121.0.0.1")).j.fout, "toestel");
  assert.equal((await meldMet(nieuw.slice(0, -1) + (nieuw.endsWith("0") ? "1" : "0"), "121.0.0.1")).j.fout, "toestel");
  assert.equal((await meldMet("b" + String(Math.floor(klok / 86400e3) + 1).padStart(5, "0") + nieuw.slice(6), "121.0.0.1")).j.fout, "toestel", "dag in de toekomst");
  // Een id van vandaag: twee meldingen, dan dag_vol.
  const st = [];
  for (let i = 0; i < 3; i++) { st.push((await meldMet(nieuw, "122.0." + i + ".1", 52.4 + i * 0.05)).status); klok += REGELS.tussenMin * 60e3 + 1000; }
  assert.deepEqual(st, [201, 201, 429]);
  // Morgen is hetzelfde id gewoon.
  klok += 86400e3;
  assert.equal((await meldMet(nieuw, "122.0.9.1", 52.6)).status, 201);
  // Te oud.
  klok += (REGELS.toestelDagen + 1) * 86400e3;
  assert.equal((await meldMet(nieuw, "122.0.9.2", 52.62)).j.fout, "toestel");
  // Nee van ids van vandaag (verschillende IP's) halen een melding niet meteen weg.
  klok = Date.parse("2028-01-05T08:00:00Z");
  const doel = await meldMet(await echt("doel-voor-verse-nee"), "123.0.0.1", 52.1, 5.1);
  assert.equal(doel.status, 201, JSON.stringify(doel.j));
  let x;
  for (let i = 0; i < 3; i++) {
    const vers = (await uitgeven("124.0." + i + ".1")).j.toestel;
    x = await (await server.fetch(new Request(`https://rijhulp.example/api/meldingen/${doel.j.melding.id}/stem`, { method: "POST", body: JSON.stringify({ toestel: vers, ja: false }), headers: { "x-real-ip": "124.0." + i + ".1", "content-type": "application/json" } }), env, null)).json();
  }
  assert.equal(x.melding.nee, 3); assert.ok(!x.melding.weg, "nee van verse ids");
  assert.equal(x.melding.verloopt, Date.parse("2028-01-05T08:00:00Z") + REGELS.neeMin * 60e3, "wel ingekort");
  console.log("ok  toestel-id van de server: verzonnen en vervalst geweigerd, uitgifte per IP, vers id meldt minder en haalt niets weg");
}

// H3: alleen JSON, alleen van de eigen site (geen cross-site POST zonder preflight).
{
  klok = Date.parse("2026-11-05T10:00:00Z");
  const body = JSON.stringify({ toestel: await echt("toestel-hhhhhhhhhhhhhhhh"), lat: 52.37, lon: 4.89, koers: 0 });
  const post = (pad, kop, b = body) => server.fetch(new Request("https://rijhulp.example" + pad, { method: "POST", body: b, headers: { "x-real-ip": "4.4.4.4", ...kop } }), env, null);
  const voor = await tel("SELECT COUNT(*) AS n FROM acties");
  let x = await post("/api/meldingen", { "content-type": "text/plain" });
  assert.equal(x.status, 415); assert.equal((await x.json()).fout, "type");
  assert.equal((await post("/api/meldingen", {})).status, 415, "zonder Content-Type");
  assert.equal((await post("/api/meldingen", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await post("/api/meldingen/1/stem", { "content-type": "text/plain" }, JSON.stringify({ toestel: "toestel-hhhhhhhhhhhhhhhh", ja: false }))).status, 415);
  x = await post("/api/meldingen", { "content-type": "application/json", origin: "https://kwaad.example" });
  assert.equal(x.status, 403); assert.equal((await x.json()).fout, "herkomst");
  assert.equal((await post("/api/meldingen/1/stem", { "content-type": "application/json", origin: "https://andere.example" }, JSON.stringify({ toestel: "toestel-hhhhhhhhhhhhhhhh", ja: false }))).status, 403);
  assert.equal((await post("/api/meldingen", { "content-type": "application/json", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/api/meldingen", { "content-type": "application/json", origin: "null" })).status, 403);
  assert.equal(await tel("SELECT COUNT(*) AS n FROM acties"), voor, "geweigerd verzoek schrijft niets");
  x = await post("/api/meldingen", { "content-type": "application/json; charset=utf-8", origin: "https://rijhulp.example", "sec-fetch-site": "same-origin" });
  assert.equal(x.status, 201, "eigen site met JSON mag");
  console.log("ok  POST alleen als JSON en van de eigen site (415 en 403)");
}
// Het geplande opruimen (scheduled, elk uur) wist ook zonder nieuwe melding: later zijn
// meldingen, stemmen, codes en het oude dagzout weg (ook die uit 2028 hierboven).
{
  assert.ok((await tel("SELECT COUNT(*) AS n FROM meldingen")) > 0, "er staat iets om op te ruimen");
  klok = Date.parse("2028-02-01T03:00:00Z");
  await server.scheduled({ cron: "0 * * * *", scheduledTime: klok }, { DB });
  for (const tabel of ["meldingen", "stemmen", "acties"]) assert.equal(await tel(`SELECT COUNT(*) AS n FROM ${tabel}`), 0, tabel);
  assert.equal(await tel("SELECT COUNT(*) AS n FROM zout WHERE dag <> ?", new Date(klok).toISOString().slice(0, 10)), 0);
  await server.scheduled({}, {}); // zonder database: niets, geen fout
  console.log("ok  gepland opruimen zonder nieuwe melding");
}
await sluit();
console.log("alles goed (" + soort + ")");
