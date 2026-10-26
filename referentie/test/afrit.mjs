// Snelweg met links ernaast, op een kleine nepkaart (geen OSM nodig).
// Het geval uit de praktijk (A12 bij Zoetermeer, 26 okt 2026): de hoofdrijbaan heeft 100 en
// "130 @ (19:00-06:00)", een motorway_link vlak ernaast staat op 130 zonder voorwaarde, en een GPS
// een paar meter naast de as plakte de auto op die link. Dan zei de app om 9:00 130.
// Getest: een link nooit hoger dan zijn hoofdrijbaan, de hoofdrijbaan voorrang boven 80 km/h,
// een echte afrit bij lage snelheid, en de tijdvoorwaarde in Europe/Amsterdam.
// node referentie/test/afrit.mjs
import fs from "node:fs";
import vm from "node:vm";
const site = new URL("../site/", import.meta.url);

// ---------- De nepkaart: één vak (260_14), lijnen als Google-polyline ----------
function polyline(punten) {
  let s = "", pla = 0, plo = 0;
  const een = (v) => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } s += String.fromCharCode(v + 63); };
  for (const [lat, lon] of punten) { const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5); een(a - pla); een(b - plo); pla = a; plo = b; }
  return s;
}
const ZUID = 18 / 110540; // de link naast de hoofdrijbaan ligt 18 m rechts (zuid) bij rijden naar het oosten
// tags: [highway, maxspeed, forward, backward, conditional, oneway, zone:traffic, zone:maxspeed]
const t = [
  ["motorway", "100", "", "", "130 @ (19:00-06:00)", "yes", "", ""],
  ["motorway_link", "130", "", "", "", "yes", "", ""],
  ["motorway_link", "80", "", "", "", "yes", "", ""],
  ["motorway_link", "50", "", "", "", "yes", "", ""]
];
const w = [
  0, polyline([[52.05, 4.31], [52.05, 4.35], [52.05, 4.39]]), // hoofdrijbaan naar het oosten
  1, polyline([[52.05 - ZUID, 4.33], [52.05 - ZUID, 4.35]]), // link van 130 vlak ernaast
  2, polyline([[52.05, 4.37], [52.049, 4.38], [52.048, 4.385]]), // echte afrit van 80
  3, polyline([[52.06, 4.33], [52.06, 4.34]]) // link van 50, ruim 1 km van de snelweg
];
const bestanden = { "kaart/index.json": { stand: "test", g: ["260_14"] }, "kaart/260_14.json": { v: 2, t, w } };
const fetch = async (p) => {
  const s = String(p).split("?")[0];
  if (bestanden[s]) return { ok: true, status: 200, json: async () => bestanden[s] };
  return { ok: false, status: 404, json: async () => ({}) };
};

const window = {}; window.window = window;
const ctx = vm.createContext({ window, Math, Date, JSON, Promise, fetch, setTimeout, clearTimeout, console, Intl });
for (const f of ["js/geo.js", "js/kaart.js"]) vm.runInContext(fs.readFileSync(new URL(f, site), "utf8"), ctx, { filename: f });
const K = window.Kaart, G = window.Geo;
await K.start(() => {});
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const rad = Math.PI / 180;
let fout = 0;
const meld = (ok, ...x) => { if (!ok) fout++; console.log(ok ? "ok  " : "FOUT", ...x); };

/** Punt o meter rechts (o > 0) of links van p, haaks op koers. */
function opzij(lat, lon, koers, o) {
  const r = (koers + 90) * rad;
  return [lat + (o * Math.cos(r)) / 110540, lon + (o * Math.sin(r)) / (111320 * Math.cos(lat * rad))];
}
async function laad(route) {
  for (const [lat, lon] of route) {
    K.vraagRond(lat, lon, null, 0);
    const begin = Date.now();
    while (!K.status(lat, lon).klaar && Date.now() - begin < 5000) await wacht(5);
  }
}
/** Rijdt een route af in stappen van 5 m; kmh mag een functie van de afgelegde meters zijn. */
function rijd(route, tijd, kmh, o = 0) {
  const uit = [];
  let tm = Date.parse(tijd), m = 0;
  for (let i = 1; i < route.length; i++) {
    const [aLat, aLon] = route[i - 1], [bLat, bLon] = route[i];
    const lengte = G.afstand(aLat, aLon, bLat, bLon), koers = G.peiling(aLat, aLon, bLat, bLon);
    const n = Math.max(1, Math.ceil(lengte / 5));
    for (let k = 0; k < n; k++) {
      const f = k / n, v = typeof kmh === "function" ? kmh(m) : kmh;
      const [lat, lon] = opzij(aLat + (bLat - aLat) * f, aLon + (bLon - aLon) * f, koers, o);
      const r = K.weg(lat, lon, koers, new Date(tm), v);
      uit.push({ lat, lon, m, limiet: r && r.limiet ? r.limiet.v : null, h: r && r.h });
      m += lengte / n;
      tm += (lengte / n / (v / 3.6)) * 1000;
    }
  }
  return uit;
}
const samen = (stappen) => { const c = {}; stappen.forEach((s) => { const k = s.limiet + " " + s.h; c[k] = (c[k] || 0) + 1; }); return JSON.stringify(c); };

// ---------- Over de hoofdrijbaan langs de link: 9:00 overal 100, 21:00 overal 130 ----------
{
  const route = [[52.05, 4.32], [52.05, 4.36]];
  await laad(route);
  for (const [tijd, verwacht] of [["2026-10-26T09:00:00+01:00", 100], ["2026-10-26T21:00:00+01:00", 130]]) {
    for (const o of [-8, -4, 0, 4, 8, 12]) {
      const stappen = rijd(route, tijd, 100, o);
      const mis = stappen.filter((s) => s.limiet !== verwacht);
      meld(!mis.length, "hoofdrijbaan", tijd.slice(11, 16), "opzij " + o + " m:", mis.length ? mis.length + " van " + stappen.length + " anders, " + samen(mis) : "overal " + verwacht);
    }
  }
}

// ---------- Een echte afrit bij lage snelheid: de auto remt van 100 naar 60 en volgt de link ----------
{
  const route = [[52.05, 4.355], [52.05, 4.37], [52.049, 4.38], [52.048, 4.385]];
  await laad(route);
  const kmh = (m) => Math.max(60, 100 - Math.max(0, m - 1000) * 0.1);
  for (const tijd of ["2026-10-26T09:00:00+01:00", "2026-10-26T21:00:00+01:00"]) {
    const eind = rijd(route, tijd, kmh).filter((s) => s.lon >= 4.38);
    meld(eind.length && eind.every((s) => s.limiet === 80 && /link/.test(s.h)), "afrit", tijd.slice(11, 16), "einde afrit (80):", samen(eind));
  }
}

// ---------- Een link zonder hoofdrijbaan in de buurt blijft zoals hij is ----------
{
  const r = K.weg(52.06, 4.335, 90, new Date("2026-10-26T09:00:00+01:00"), 40);
  meld(r && r.limiet && r.limiet.v === 50, "link 50 ver van de snelweg blijft 50:", r && r.limiet && r.limiet.v, r && r.h);
}

// ---------- Op de link van 130 bij lage snelheid: hooguit de hoofdrijbaan ----------
for (const [tijd, verwacht] of [["2026-10-26T09:00:00+01:00", 100], ["2026-10-26T21:00:00+01:00", 130]]) {
  const r = K.weg(52.05 - ZUID, 4.34, 90, new Date(tijd), 40);
  meld(r && /link/.test(r.h) && r.limiet && r.limiet.v === verwacht, "link 130", tijd.slice(11, 16), "hooguit de hoofdrijbaan:", r && r.h, r && r.limiet && r.limiet.v);
}

console.log(fout ? `${fout} fout` : "alles goed");
process.exit(fout ? 1 : 0);
