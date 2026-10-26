// Maakt site/data/flitsers.json uit het ruwe Overpass-antwoord (data-bron/osm-flitsers.json).
// Data: (c) OpenStreetMap-bijdragers, beschikbaar onder de ODbL (opendatacommons.org/licenses/odbl).
// Het resultaat is een afgeleide database; die staat onder dezelfde licentie (zie de voet van de site).
//
// Vorm, compact voor een trage verbinding in de auto:
//   c: [[lat, lon, soort, max, richting], ...]   soort 0 snelheid, 1 roodlicht, 2 beide; max 0 = onbekend;
//                                                richting in graden (rijrichting die gecontroleerd wordt), -1 = onbekend
//   t: [{ n, m, mc, a: [lat, lon], b: [lat, lon], r: 0|1, s: [[lat, lon, lat, lon, ...], ...], km }]
//      a = begin, b = eind; r = 1 als de richting onbekend is (dan geldt ook b -> a)
import fs from "node:fs";

const bron = JSON.parse(fs.readFileSync(new URL("../data-bron/osm-flitsers.json", import.meta.url), "utf8"));
const R = 6371000, rad = Math.PI / 180;
const afstand = (a, b) => {
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};
const peiling = (a, b) => {
  const y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad);
  const x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
};
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const KOMPAS = { N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157, S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337 };
function richting(tag) {
  if (tag == null) return -1;
  const t = String(tag).trim().split(/[;,]/)[0].trim().toUpperCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t)) % 360;
  return t in KOMPAS ? KOMPAS[t] : -1;
}
function maxVan(tag) {
  const m = /^(\d{2,3})/.exec(String(tag ?? "").trim());
  return m ? Number(m[1]) : 0;
}
function soortVan(enf) {
  const e = String(enf ?? "").toLowerCase();
  const rood = /traffic_signals|red_light|redlight/.test(e), snel = /maxspeed/.test(e);
  if (rood && snel) return 2;
  if (rood) return 1;
  return 0;
}

const knopen = new Map();
for (const e of bron.elements) if (e.type === "node") knopen.set(e.id, e);

const camera = new Map(); // node-id -> [lat, lon, soort, max, richting]
// 1. Losse flitspalen
for (const k of knopen.values()) {
  const t = k.tags ?? {};
  if (t.highway !== "speed_camera" && !t.enforcement) continue;
  if (t.enforcement && !/maxspeed|traffic_signals|red_light|average_speed/.test(t.enforcement) && t.highway !== "speed_camera") continue;
  if (/average_speed/.test(t.enforcement ?? "")) continue; // hoort bij een traject
  camera.set(k.id, [r5(k.lat), r5(k.lon), soortVan(t.enforcement ?? "maxspeed"), maxVan(t.maxspeed), richting(t.direction ?? t["camera:direction"])]);
}
// 2. Handhavingsrelaties met snelheid of rood licht
const trajecten = [];
for (const e of bron.elements) {
  if (e.type !== "relation") continue;
  const t = e.tags ?? {};
  const enf = String(t.enforcement ?? "");
  const leden = e.members ?? [];
  const pt = (rol) => leden.filter((m) => m.role === rol && m.type === "node" && m.lat != null).map((m) => [m.lat, m.lon]);
  const weg = (rol) => leden.filter((m) => m.role === rol && m.type === "way" && m.geometry);
  if (/average_speed/.test(enf)) {
    const secties = weg("section").concat(weg(""));
    let a = pt("from")[0], b = pt("to")[0];
    if (!a) { const w = weg("from")[0]; if (w) a = [w.geometry.at(-1).lat, w.geometry.at(-1).lon]; }
    if (!b) { const w = weg("to")[0]; if (w) b = [w.geometry[0].lat, w.geometry[0].lon]; }
    let onbekend = 0;
    if ((!a || !b) && secties.length) {
      // Eindpunten van de keten: punten die maar één keer voorkomen.
      const tel = new Map();
      for (const w of secties) for (const p of [w.geometry[0], w.geometry.at(-1)]) { const k = p.lat.toFixed(6) + "," + p.lon.toFixed(6); tel.set(k, (tel.get(k) ?? 0) + 1); }
      const eind = [...tel].filter(([, n]) => n === 1).map(([k]) => k.split(",").map(Number));
      if (!a && !b) { a = eind[0]; b = eind[1]; onbekend = 1; }
      else if (!a) { a = eind.sort((x, y) => afstand(y, b) - afstand(x, b))[0]; }
      else if (!b) { b = eind.sort((x, y) => afstand(y, a) - afstand(x, a))[0]; }
    }
    const dev = pt("device");
    if (!a && dev.length) a = dev[0];
    if (!b && dev.length > 1) b = dev.at(-1);
    if (!a || !b || afstand(a, b) < 300) continue;
    const s = secties.map((w) => w.geometry.flatMap((p) => [r5(p.lat), r5(p.lon)]));
    let km = 0;
    for (const w of secties) for (let i = 1; i < w.geometry.length; i++) km += afstand([w.geometry[i - 1].lat, w.geometry[i - 1].lon], [w.geometry[i].lat, w.geometry[i].lon]);
    if (!s.length) s.push([r5(a[0]), r5(a[1]), r5(b[0]), r5(b[1])]);
    trajecten.push({ n: t.name ?? t.ref ?? "", m: maxVan(t.maxspeed), mc: t["maxspeed:conditional"] ?? undefined, a: [r5(a[0]), r5(a[1])], b: [r5(b[0]), r5(b[1])], r: onbekend, s, km: Math.round((km || afstand(a, b)) / 100) / 10 });
    continue;
  }
  const soort = soortVan(enf);
  if (!/maxspeed|traffic_signals|red_light/.test(enf)) continue;
  const van = pt("from")[0], naar = pt("to")[0];
  for (const m of leden) {
    if (m.role !== "device" || m.type !== "node" || m.lat == null) continue;
    const k = knopen.get(m.ref);
    const plek = [m.lat, m.lon];
    let dir = -1;
    if (van && naar) dir = Math.round(peiling(van, naar));
    else if (van) dir = Math.round(peiling(van, plek));
    else if (naar) dir = Math.round(peiling(plek, naar));
    else if (k?.tags) dir = richting(k.tags.direction ?? k.tags["camera:direction"]);
    const max = maxVan(t.maxspeed) || maxVan(k?.tags?.maxspeed);
    camera.set(m.ref, [r5(m.lat), r5(m.lon), soort, max, dir]);
  }
}

// Camera's van een trajectcontrole (portalen, vaak als losse speed_camera getekend) horen
// niet als losse flitser: weg als ze binnen 40 m van een trajectapparaat of 20 m van een
// trajectlijn staan.
const trajectApparaten = [];
for (const e of bron.elements) {
  if (e.type !== "relation" || !/average_speed/.test(e.tags?.enforcement ?? "")) continue;
  for (const m of e.members ?? []) if (m.type === "node" && m.lat != null) trajectApparaten.push([m.lat, m.lon]);
}
function bijTraject(c) {
  if (trajectApparaten.some((a) => Math.abs(a[0] - c[0]) < 0.001 && afstand(a, c) < 40)) return true;
  for (const t of trajecten) for (const l of t.s) for (let i = 2; i < l.length; i += 2) {
    if (Math.abs(l[i] - c[0]) > 0.01 || Math.abs(l[i + 1] - c[1]) > 0.015) continue;
    if (lijnAfstand(c, [l[i - 2], l[i - 1]], [l[i], l[i + 1]]) < 20) return true;
  }
  return false;
}
function lijnAfstand(p, a, b) {
  const kx = Math.cos(p[0] * rad) * 111320, ky = 110540;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
let weg = 0;
for (const [id, c] of camera) if (bijTraject(c)) { camera.delete(id); weg++; }
console.log("camera's bij een traject weggelaten:", weg);

// Dubbele weghalen: binnen 40 m en dezelfde (of een onbekende) richting.
const lijst = [...camera.values()];
const uit = [];
for (const c of lijst) {
  const dubbel = uit.find((d) => afstand(d, c) < 40 && (d[4] < 0 || c[4] < 0 || Math.abs(((d[4] - c[4] + 540) % 360) - 180) < 30));
  if (dubbel) {
    if (dubbel[4] < 0 && c[4] >= 0) dubbel[4] = c[4];
    if (!dubbel[3] && c[3]) dubbel[3] = c[3];
    if (dubbel[2] !== c[2]) dubbel[2] = 2;
    continue;
  }
  uit.push(c);
}
uit.sort((x, y) => x[0] - y[0]);
const json = { v: 1, stand: bron.osm3s?.timestamp_osm_base ?? null, bron: "© OpenStreetMap-bijdragers, ODbL", landen: Object.entries(JSON.parse(fs.readFileSync(new URL("../../landen.json", import.meta.url), "utf8")).landen).filter(([, l]) => l.flitsers === "aan").map(([cc]) => cc), c: uit, t: trajecten };
const pad = new URL("../site/data/flitsers.json", import.meta.url);
fs.mkdirSync(new URL("../site/data/", import.meta.url), { recursive: true });
fs.writeFileSync(pad, JSON.stringify(json));
const st = { camera: uit.length, metRichting: uit.filter((c) => c[4] >= 0).length, rood: uit.filter((c) => c[2] === 1).length, trajecten: trajecten.length, trajectZonderRichting: trajecten.filter((t) => t.r).length, bytes: fs.statSync(pad).size };
console.log(st);
