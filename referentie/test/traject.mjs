// Eén aankondiging per trajectcontrole, ook waar OSM er meer op dezelfde plek heeft
// (A12 bij Utrecht: hoofdrijbaan en parallelrijbaan; A20 bij Rotterdam: drie aansluitende delen).
// node test/traject.mjs
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const rit = (naam) => execFileSync("node", [new URL("rit.mjs", import.meta.url).pathname, naam], { encoding: "utf8" })
  .split("\n").filter((r) => r.includes(" ZEG ")).map((r) => r.split(" ZEG ")[1]);
const tel = (lijst, deel) => lijst.filter((z) => z.split("+").includes(deel)).length;

const utrecht = rit("a12-utrecht");
assert.equal(tel(utrecht, "traject_1000") + tel(utrecht, "traject_500"), 1, "A12 Utrecht: één aankondiging\n" + utrecht.join("\n"));
assert.equal(tel(utrecht, "traject_start"), 1);
assert.ok(utrecht.includes("gong+traject_start+limiet+n100"), "hoofdrijbaan (100), niet de parallelrijbaan (80)\n" + utrecht.join("\n"));
assert.equal(tel(utrecht, "traject_eind"), 1);
console.log("ok A12 Utrecht:", utrecht.join(", "));

const a20 = rit("a20");
assert.equal(tel(a20, "traject_start"), 1, a20.join("\n"));
assert.equal(tel(a20, "te_hoog"), 1, "te hoog één keer over de aansluitende delen\n" + a20.join("\n"));
assert.equal(tel(a20, "traject_eind"), 1);
console.log("ok A20:", a20.join(", "));

const a12 = rit("a12");
assert.deepEqual(a12, ["gong+traject_1000", "gong+traject_start+limiet+n80", "let+te_hoog", "gong+traject_eind+gemiddeld+n88"]);
console.log("ok A12 Den Haag ongewijzigd");

// ---------- A12 Zoetermeer richting Den Haag, 27 okt 2026 17:20 (melding uit de Tesla) ----------
// De app toonde "Trajectcontrole, max 130, nog 1,9 km, gem. 0" bij 81 km/h; de Tesla: limiet 100,
// gemiddeld 79, nog 1,9 km. Het traject (OSM, flitsers.json) is 2,4 km met maxspeed 100 en
// "130 @ (19:00-06:00)". Nog 1,9 km is dus 500 m gereden: de afstand klopte, de tijd niet
// (gem. 0 bij 500 m vraagt meer dan een uur), en de limiet hoorde bij een begin tussen 19:00 en 6:00.
// Hieronder de rit met de echte route (sim/a12-zn.json) en de echte trajectdata, in vijf vormen.
import fs from "node:fs";
import vm from "node:vm";
const site = new URL("../site/", import.meta.url);
const route = JSON.parse(fs.readFileSync(new URL("sim/a12-zn.json", site))).route;
function nieuweApp() {
  const zin = [];
  const window = { Geluid: { getal: (n) => (n >= 30 && n <= 140 ? "n" + Math.round(n) : null) } };
  window.window = window;
  const ctx = vm.createContext({ window, globalThis: window, Math, Date, JSON, Intl, fetch: async (p) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(new URL(p, site))) }), console });
  for (const f of ["js/geo.js", "js/kaart.js", "js/flitsers.js"]) vm.runInContext(fs.readFileSync(new URL(f, site), "utf8"), ctx, { filename: f });
  window.Flitsers.opZeg((d) => zin.push(d.join("+")));
  return { F: window.Flitsers, G: window.Geo, zin };
}
const { G } = nieuweApp();
const lengtes = [0];
for (let i = 1; i < route.length; i++) lengtes.push(lengtes[i - 1] + G.afstand(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]));
/** Punt op m meter langs de route, met de koers daar. */
function punt(m) {
  let k = 1; while (k < lengtes.length - 1 && lengtes[k] < m) k++;
  const a = route[k - 1], b = route[k], f = (m - lengtes[k - 1]) / (lengtes[k] - lengtes[k - 1]);
  return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, koers: G.peiling(a[0], a[1], b[0], b[1]) };
}
// Begin van het traject (52.05041, 4.44402) op de route.
let mA = 0, best = Infinity;
for (let m = 0; m < 6000; m += 1) { const p = punt(m); const d = G.afstand(p.lat, p.lon, 52.05041, 4.44402); if (d < best) { best = d; mA = m; } }
/**
 * Rijdt van m0 tot m1 (meter langs de route) met kmh, vanaf tijd t (ms), stappen van 0,2 s zoals
 * rijhulp.js. coordS: de positie verandert maar eens per zoveel s (de Tesla herhaalt coördinaten).
 * tijdVan(t): de timestamp die de app krijgt. Geeft de stappen en de eindtijd.
 */
async function rijd(app, { m0, m1, kmh, t, coordS = 0, tijdVan = (x) => x, stil = 0 }) {
  await (app.geladen ||= app.F.laad());
  const uit = [];
  let m = m0, laatsteCoord = -Infinity, p = punt(m);
  while (m <= m1) {
    if (stil > 0) { stil -= 0.2; } else m += (kmh / 3.6) * 0.2;
    if (!coordS || t - laatsteCoord >= coordS * 1000) { p = punt(m); laatsteCoord = t; }
    const v = stil > 0 ? 0 : kmh;
    const r = app.F.stap({ lat: p.lat, lon: p.lon, kmh: v, koers: p.koers, t: tijdVan(t, m - mA) }, true);
    uit.push({ m: m - mA, ...r.traject });
    t += 200;
  }
  return { uit, t };
}
const bij = (uit, m) => uit.find((s) => s.m >= m && s.naam != null && !s.komt) || {};
let fouten = 0;
const zie = (ok, ...tekst) => { if (!ok) fouten++; console.log(ok ? "ok  " : "FOUT", ...tekst); };
const tijd = (s) => Date.parse(s);

{ // 1. Gewoon overdag: van 1 km voor het begin tot het einde, 81 km/h om 17:20.
  const app = nieuweApp();
  const { uit } = await rijd(app, { m0: mA - 1000, m1: mA + 2500, kmh: 81, t: tijd("2026-10-27T17:19:00+01:00") });
  const s = bij(uit, 500);
  zie(s.limiet === 100 && Math.abs(s.gem - 81) <= 2 && s.rest === 1.9, "overdag 500 m in het traject: max 100, gem. 81, nog 1,9:", JSON.stringify(s));
  zie(app.zin.includes("gong+traject_start+limiet+n100"), "begin met limiet 100:", app.zin.join(", "));
}
{ // 2. De pagina bevroor gisteravond in hetzelfde traject (Tesla-browser dicht of de auto uit) en
  //    loopt vandaag om 17:20 verder, 470 m na het begin. Zo ontstaan beide fouten tegelijk.
  const app = nieuweApp();
  await rijd(app, { m0: mA - 1000, m1: mA + 100, kmh: 100, t: tijd("2026-10-26T21:30:00+01:00") });
  const { uit } = await rijd(app, { m0: mA + 470, m1: mA + 2500, kmh: 81, t: tijd("2026-10-27T17:20:00+01:00") });
  const s = bij(uit, 500), later = bij(uit, 1300);
  zie(s.limiet === 100, "bevroren sinds gisteravond: limiet 100, niet 130:", JSON.stringify(s));
  zie(s.rest === 1.9 && s.gem !== 0, "nog 1,9 km en geen gem. 0 (wel eerlijk leeg):", JSON.stringify(s));
  zie(Math.abs(later.gem - 81) <= 2, "na 800 m gemeten gem. 81:", JSON.stringify(later));
}
{ // 3. De posities rond het begin hebben een tijd uit een andere klok (12 uur terug, 5:20).
  const app = nieuweApp();
  // Tot 20 m na het begin geeft het toestel tijden van 5:20 (een oude of andere klok), daarna de goede.
  const { uit } = await rijd(app, { m0: mA - 1000, m1: mA + 2500, kmh: 81, t: tijd("2026-10-27T17:19:00+01:00"), tijdVan: (t, m) => (m < 20 ? t - 12 * 3600e3 : t) });
  const s = bij(uit, 500), later = bij(uit, 1300);
  zie(s.limiet === 100 && s.gem !== 0, "afwijkende klok bij het begin: max 100 en geen gem. 0:", JSON.stringify(s));
  zie(Math.abs(later.gem - 81) <= 2, "en daarna gem. 81:", JSON.stringify(later));
}
{ // 4. Coördinaten die de Tesla herhaalt: tien keer per seconde een positie, maar een nieuwe plek pas na 1 s.
  const app = nieuweApp();
  const { uit } = await rijd(app, { m0: mA - 1000, m1: mA + 2500, kmh: 81, t: tijd("2026-10-27T17:19:00+01:00"), coordS: 1 });
  const s = bij(uit, 1000);
  zie(Math.abs(s.gem - 81) <= 3 && Math.abs(s.rest - 1.4) <= 0.1, "herhaalde coördinaten: gem. 81, nog 1,4:", JSON.stringify(s));
}
{ // 5. Stilstand in de file (2 min) telt mee in het gemiddelde, zoals bij de echte meting.
  const app = nieuweApp();
  const a = await rijd(app, { m0: mA - 1000, m1: mA + 800, kmh: 81, t: tijd("2026-10-27T17:19:00+01:00") });
  const b = await rijd(app, { m0: mA + 800, m1: mA + 2500, kmh: 81, t: a.t, stil: 120 });
  const s = bij(b.uit, 1600), verwacht = (1600 / (1600 / (81 / 3.6) + 120)) * 3.6;
  zie(Math.abs(s.gem - verwacht) <= 3, "file van 2 min: gem. " + Math.round(verwacht) + ":", JSON.stringify(s));
}
{ // 6. De app gaat pas halverwege aan: sluit aan, eerlijk zonder gemiddelde tot er genoeg gemeten is.
  const app = nieuweApp();
  const { uit } = await rijd(app, { m0: mA + 450, m1: mA + 2500, kmh: 81, t: tijd("2026-10-27T17:20:00+01:00") });
  const s = bij(uit, 500), later = bij(uit, 1300);
  zie(s.limiet === 100 && s.rest === 1.9 && s.gem == null, "halverwege aan: max 100, nog 1,9, nog geen gem.:", JSON.stringify(s));
  zie(Math.abs(later.gem - 81) <= 2, "na 800 m gem. 81:", JSON.stringify(later));
  zie(!app.zin.some((z) => z.includes("traject_start")), "geen 'begin trajectcontrole' halverwege:", app.zin.join(", "));
}
console.log(fouten ? fouten + " fout in A12 Zoetermeer" : "ok A12 Zoetermeer 17:20");
process.exit(fouten ? 1 : 0);
