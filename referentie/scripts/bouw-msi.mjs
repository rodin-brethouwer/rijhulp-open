// Zet de locatietabel van de matrixborden (MSI) van NDW om naar kleine bestanden per kaartvak,
// zoals de kaart: site/msi/<vak>.json voor de app en server/msi-vakken.json voor de servercode
// (welke borden in welk vak staan). De live feed (Matrixsignaalinformatie.xml.gz) heeft geen
// coordinaten, alleen een uuid per bord; deze tabel koppelt die uuid aan een plek.
//
// Bron: https://opendata.ndw.nu/ndw_msi_shapefiles_latest.zip (NDW, open data onder CC0 1.0).
// Download en pak uit in een eigen lege map buiten de repo; er wordt niets uit uitgevoerd, dit
// script leest alleen MSI/shapes.shp en MSI/shapes.dbf (punten in WGS84).
//
//   node referentie/scripts/bouw-msi.mjs <map met het uitgepakte zip-bestand>
//
// Een bord heet in de app en de server naar het begin van zijn uuid (kortste unieke lengte,
// minstens 8 tekens), zodat de server per vak alleen die korte namen hoeft te sturen.
import fs from "node:fs";
import path from "node:path";

const VAK_LAT = 0.2, VAK_LON = 0.3; // gelijk aan de kaart, de meldingen en server/server.mjs
const map = process.argv[2];
if (!map) { console.error("gebruik: node scripts/bouw-msi.mjs <map met MSI/shapes.shp>"); process.exit(1); }
const shp = fs.readFileSync(path.join(map, "MSI/shapes.shp"));
const dbf = fs.readFileSync(path.join(map, "MSI/shapes.dbf"));
const prj = fs.readFileSync(path.join(map, "MSI/shapes.prj"), "utf8");
if (!/WGS_1984/.test(prj)) throw new Error("verwacht WGS84 in shapes.prj");
if (shp.readInt32LE(32) !== 1) throw new Error("verwacht punten in shapes.shp");

// DBF: kop, velden, dan rijen van vaste lengte.
const n = dbf.readUInt32LE(4), kopLengte = dbf.readUInt16LE(8), rijLengte = dbf.readUInt16LE(10);
const velden = [];
for (let o = 32; dbf[o] !== 0x0d; o += 32) velden.push({ naam: dbf.toString("latin1", o, o + 11).replace(/\0.*$/s, ""), lengte: dbf[o + 16] });
function rij(i) {
  let o = kopLengte + i * rijLengte + 1;
  const r = {};
  for (const v of velden) { r[v.naam] = dbf.toString("latin1", o, o + v.lengte).trim(); o += v.lengte; }
  return r;
}
// SHP: na de kop van 100 bytes per record 8 bytes kop, type (4), x en y (2 x 8).
const punten = [];
for (let o = 100; o < shp.length;) {
  const inhoud = shp.readInt32BE(o + 4) * 2;
  const type = shp.readInt32LE(o + 8);
  punten.push(type === 1 ? [shp.readDoubleLE(o + 12), shp.readDoubleLE(o + 20)] : null);
  o += 8 + inhoud;
}
if (punten.length !== n) throw new Error(`shp heeft ${punten.length} punten, dbf ${n} rijen`);

const borden = [];
for (let i = 0; i < n; i++) {
  const r = rij(i), p = punten[i];
  if (!p || !/^[0-9a-f-]{36}$/.test(r.uuid)) continue;
  const [lon, lat] = p;
  if (!(lat > 50 && lat < 54 && lon > 3 && lon < 8)) continue;
  borden.push({ uuid: r.uuid, lat, lon, peiling: Number(r.bearing), weg: r.road, baan: r.carriagew0, strook: Number(r.lane) || 0, km: Number(r.km) });
}
// Kortste unieke lengte van het begin van de uuid (zonder streepjes), minstens 8.
let lengte = 8;
for (;; lengte++) {
  const gezien = new Set(borden.map((b) => b.uuid.replace(/-/g, "").slice(0, lengte)));
  if (gezien.size === borden.length) break;
}
for (const b of borden) b.id = b.uuid.replace(/-/g, "").slice(0, lengte);

const stand = fs.statSync(path.join(map, "MSI/shapes.dbf")).mtime.toISOString().slice(0, 10);
const uit = new URL("../site/msi/", import.meta.url);
fs.rmSync(uit, { recursive: true, force: true });
fs.mkdirSync(uit, { recursive: true });
const perVak = new Map();
for (const b of borden) {
  const vak = Math.floor(b.lat / VAK_LAT) + "_" + Math.floor(b.lon / VAK_LON);
  if (!perVak.has(vak)) perVak.set(vak, []);
  perVak.get(vak).push(b);
}
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const serverVakken = {};
let bytes = 0;
for (const [vak, lijst] of [...perVak].sort()) {
  lijst.sort((a, b) => a.weg.localeCompare(b.weg) || a.baan.localeCompare(b.baan) || a.km - b.km || a.strook - b.strook);
  // Per bord: id, lat, lon, peiling, weg, baan, strook, km.
  const json = JSON.stringify({ v: 1, stand, vak, b: lijst.map((b) => [b.id, r5(b.lat), r5(b.lon), Math.round(b.peiling) % 360, b.weg, b.baan, b.strook, Math.round(b.km * 1000) / 1000]) });
  fs.writeFileSync(new URL(vak + ".json", uit), json);
  bytes += json.length;
  serverVakken[vak] = lijst.map((b) => b.id).join(",");
}
fs.writeFileSync(new URL("index.json", uit), JSON.stringify({ v: 1, stand, bron: "NDW, open data (CC0 1.0)", idLengte: lengte, vakken: [...perVak.keys()].sort() }));
fs.writeFileSync(new URL("../server/msi-vakken.json", import.meta.url), JSON.stringify({ stand, idLengte: lengte, vakken: serverVakken }));
console.log(`${borden.length} borden in ${perVak.size} vakken, id ${lengte} tekens, ${Math.round(bytes / 1024)} kB samen, stand ${stand}`);
