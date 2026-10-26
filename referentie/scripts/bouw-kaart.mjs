// Maakt de kaart van de rijhulp vooraf: de maximumsnelheden van de landen uit je extracten als statische
// bestanden per vak, zodat de app niet op Overpass hoeft te wachten.
// Data: (c) OpenStreetMap-bijdragers, ODbL. Het resultaat is een afgeleide database onder
// dezelfde licentie (noem dat in de voet van je site en op over.html).
//
//   node scripts/bouw-kaart.mjs <werkmap> <land.osm.pbf> [<land.osm.pbf> ...]
//
// Nodig: osmium-tool (brew install osmium-tool). Het script draait alleen osmium op de
// extracten en leest de uitvoer als data; er wordt niets uit de download uitgevoerd.
//
// Rooster: dezelfde tegels als de app (0,02 graad breedte x 0,03 graad lengte, sleutel
// "i_j" met i = floor(lat / 0,02), j = floor(lon / 0,03)). Een bestand bevat een vak van
// 10 x 10 tegels (ca. 22 x 20 km): site/kaart/<gi>_<gj>.json met gi = floor(i / 10).
// site/kaart/index.json zegt welke vakken er zijn, zodat de app weet waar hij kan
// terugvallen op Overpass (buiten de extracten) en waar niet.
//
// Vorm van een vak, compact:
//   { v: 2, t: [[highway, maxspeed, forward, backward, conditional, oneway, zone:traffic, zone:maxspeed], ...],
//     w: [tagIndex, "lijn", tagIndex, "lijn", ...] }
// Een lijn is gecodeerd als een Google-polyline (precisie 1e-5 graad, ca. 1 m): elk getal
// een verschil met het vorige punt, in tekens van 5 bits. Lijnen vereenvoudigd
// (Douglas-Peucker, 3 m): voor het zoeken van de weg binnen 30 m ruim genoeg.
//
// Klein houden is nodig: elke deploy van de site leest en keurt alle bestanden opnieuw, en
// met 66 MB aan kaart (de eerste versie, 25 okt 2026) liep elke deploy vast op een 504.
// Daarom ook alleen wegen die iets zeggen over de limiet: alles van motorway tot tertiary,
// en kleinere wegen alleen met een limiet- of zonetag (living_street altijd, die is 15).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

const [werk, ...pbfs] = process.argv.slice(2);
if (!werk || !pbfs.length) { console.error("gebruik: node scripts/bouw-kaart.mjs <werkmap> <land.osm.pbf> ..."); process.exit(1); }
fs.mkdirSync(werk, { recursive: true });
const UIT = new URL("../site/kaart/", import.meta.url).pathname;

const WEGEN = "motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,unclassified,residential,living_street,road";
const TAGS = ["highway", "maxspeed", "maxspeed:forward", "maxspeed:backward", "maxspeed:conditional", "oneway", "zone:traffic", "zone:maxspeed", "maxspeed:type", "source:maxspeed"];
const TLAT = 0.02, TLON = 0.03, GROEP = 10, Q = 1e5, TOL = 3;
const KLEIN = new Set(["unclassified", "residential", "road"]);
function polyline(getallen) {
  let uit = "";
  for (const g of getallen) {
    let v = g < 0 ? ~(g << 1) : g << 1;
    while (v >= 0x20) { uit += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>>= 5; }
    uit += String.fromCharCode(v + 63);
  }
  return uit;
}

// ---------- 1. osmium: alleen de wegen, als GeoJSON-regels ----------
const config = path.join(werk, "export.json");
fs.writeFileSync(config, JSON.stringify({ attributes: { type: false, id: "@id" }, linear_tags: true, area_tags: false, include_tags: TAGS }));
const regels = [];
let stand = null;
for (const pbf of pbfs) {
  const naam = path.basename(pbf).replace(/\.osm\.pbf$/, "");
  const wegen = path.join(werk, naam + "-wegen.pbf"), geo = path.join(werk, naam + "-wegen.geojsonseq");
  execFileSync("osmium", ["tags-filter", pbf, "w/highway=" + WEGEN, "-o", wegen, "--overwrite"], { stdio: "inherit" });
  execFileSync("osmium", ["export", wegen, "-c", config, "-f", "geojsonseq", "-x", "print_record_separator=false", "--geometry-types=linestring", "-o", geo, "--overwrite"], { stdio: "inherit" });
  regels.push(geo);
  const kop = execFileSync("osmium", ["fileinfo", "-g", "header.option.osmosis_replication_timestamp", pbf], { encoding: "utf8" }).trim();
  if (kop && (!stand || kop < stand)) stand = kop;
}

// ---------- 2. vereenvoudigen en per vak verdelen ----------
function dp(p, tol) {
  // p = [[lat, lon], ...]; Douglas-Peucker in meters rond het eerste punt.
  if (p.length <= 2) return p;
  const kx = Math.cos(p[0][0] * Math.PI / 180) * 111320, ky = 110540;
  const xy = p.map(([la, lo]) => [lo * kx, la * ky]);
  const houd = new Uint8Array(p.length); houd[0] = houd[p.length - 1] = 1;
  const stapel = [[0, p.length - 1]];
  while (stapel.length) {
    const [a, b] = stapel.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let ver = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      let t = l2 ? ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
      if (d > ver) { ver = d; idx = i; }
    }
    if (ver > tol) { houd[idx] = 1; stapel.push([a, idx], [idx, b]); }
  }
  return p.filter((_, i) => houd[i]);
}
const groepVan = (lat, lon) => Math.floor(Math.floor(lat / TLAT) / GROEP) + "_" + Math.floor(Math.floor(lon / TLON) / GROEP);
const vakken = new Map(); // groep -> { t: Map(tagSleutel -> index), tl: [], w: [] }
const gezien = new Set();
let aantal = 0, punten = 0, puntenVoor = 0, metLimiet = 0;
for (const geo of regels) {
  const rl = readline.createInterface({ input: fs.createReadStream(geo), crlfDelay: Infinity });
  for await (const regel of rl) {
    if (!regel) continue;
    const f = JSON.parse(regel);
    const id = f.properties["@id"];
    if (gezien.has(id)) continue; // een weg over de grens staat in beide extracten
    gezien.add(id);
    const c = f.geometry.coordinates;
    if (!c || c.length < 2) continue;
    const t = f.properties;
    // maxspeed:type of source:maxspeed ("NL:urban") als zone:maxspeed ontbreekt.
    let zm = t["zone:maxspeed"] || "";
    if (!zm) for (const k of ["maxspeed:type", "source:maxspeed"]) if (/^[A-Z]{2}(-[A-Z]+)?:[a-z0-9:]+$/.test(t[k] || "")) { zm = t[k]; break; }
    const tup = [t.highway || "", t.maxspeed || "", t["maxspeed:forward"] || "", t["maxspeed:backward"] || "", t["maxspeed:conditional"] || "", t.oneway || "", t["zone:traffic"] || "", zm];
    const heeftLimiet = !!(tup[1] || tup[2] || tup[3] || tup[4] || tup[6] || tup[7]);
    if (heeftLimiet) metLimiet++;
    if (!heeftLimiet && KLEIN.has(tup[0])) continue;
    const sleutel = tup.join("\u0001");
    puntenVoor += c.length;
    const p = dp(c.map(([lo, la]) => [la, lo]), TOL);
    punten += p.length;
    aantal++;
    // In elk vak dat de lijn raakt (ook tussen de punten, elke ca. 500 m een proef).
    const gs = new Set();
    for (let i = 0; i < p.length; i++) {
      gs.add(groepVan(p[i][0], p[i][1]));
      if (i) { const n = Math.ceil(Math.hypot((p[i][0] - p[i - 1][0]) * 110540, (p[i][1] - p[i - 1][1]) * 70000) / 500); for (let s = 1; s < n; s++) gs.add(groepVan(p[i - 1][0] + (p[i][0] - p[i - 1][0]) * s / n, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * s / n)); }
    }
    const ints = [];
    let vla = 0, vlo = 0;
    for (const [la, lo] of p) { const a = Math.round(la * Q), b = Math.round(lo * Q); ints.push(a - vla, b - vlo); vla = a; vlo = b; }
    const lijn = polyline(ints);
    for (const g of gs) {
      let v = vakken.get(g);
      if (!v) vakken.set(g, (v = { t: new Map(), tl: [], w: [] }));
      let ti = v.t.get(sleutel);
      if (ti == null) { ti = v.tl.length; v.t.set(sleutel, ti); v.tl.push(tup); }
      v.w.push(ti, lijn);
    }
  }
}

// ---------- 3. schrijven ----------
fs.rmSync(UIT, { recursive: true, force: true });
fs.mkdirSync(UIT, { recursive: true });
let totaal = 0, grootste = 0, grootsteNaam = "";
const lijst = [...vakken.keys()].sort();
for (const g of lijst) {
  const v = vakken.get(g);
  const tekst = JSON.stringify({ v: 2, t: v.tl, w: v.w });
  fs.writeFileSync(path.join(UIT, g + ".json"), tekst);
  totaal += tekst.length;
  if (tekst.length > grootste) { grootste = tekst.length; grootsteNaam = g; }
}
const index = { v: 2, stand, bron: "© OpenStreetMap-bijdragers, ODbL", tlat: TLAT, tlon: TLON, groep: GROEP, g: lijst };
fs.writeFileSync(path.join(UIT, "index.json"), JSON.stringify(index));
console.log({ stand, wegen: aantal, metLimiet, puntenVoor, punten, vakken: lijst.length, totaalMB: Math.round(totaal / 1e5) / 10, grootsteKB: Math.round(grootste / 1024), grootsteNaam });
