// Proefrit in Node: speelt sim/<naam>.json af door flitsers.js en print wat er gezegd en getoond wordt.
// node test/rit.mjs n209 [kmh]
import fs from "node:fs";
import vm from "node:vm";
const site = new URL("../site/", import.meta.url);
const naam = process.argv[2] ?? "n209";
const sim = JSON.parse(fs.readFileSync(new URL(`sim/${naam}.json`, site)));
const kmh = Number(process.argv[3] ?? sim.kmh);
const gezegd = [];
const window = { Geluid: { getal: (n) => (n >= 30 && n <= 140 ? "n" + Math.round(n) : null) } };
window.window = window;
const ctx = vm.createContext({ window, globalThis: window, Math, Date, JSON, fetch: async (p) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(new URL(p, site))) }), console });
for (const f of ["js/geo.js", "js/kaart.js", "js/flitsers.js"]) vm.runInContext(fs.readFileSync(new URL(f, site), "utf8"), ctx, { filename: f });
// kaart.js wil indexedDB en fetch voor Overpass; alleen _metVoorwaarde wordt hier gebruikt.
const { Geo: G, Flitsers } = window;
await Flitsers.laad();
Flitsers.opZeg((d) => gezegd.push(d.join("+")));
const r = sim.route;
let t = Date.parse("2026-10-27T11:00:00+01:00"), vorigeUit = "";
const stap = 0.2; // s
for (let i = 1; i < r.length; i++) {
  const lengte = G.afstand(r[i - 1][0], r[i - 1][1], r[i][0], r[i][1]);
  const koers = G.peiling(r[i - 1][0], r[i - 1][1], r[i][0], r[i][1]);
  const n = Math.max(1, Math.ceil(lengte / ((kmh / 3.6) * stap)));
  for (let k = 0; k < n; k++) {
    const f = k / n;
    const p = { lat: r[i - 1][0] + (r[i][0] - r[i - 1][0]) * f, lon: r[i - 1][1] + (r[i][1] - r[i - 1][1]) * f, kmh, koers, t };
    const voor = gezegd.length;
    const uit = Flitsers.stap(p, true);
    const tekst = JSON.stringify(uit);
    if (gezegd.length > voor) console.log(new Date(t).toISOString().slice(11, 19), "ZEG", gezegd.at(-1));
    if (tekst !== vorigeUit && (process.env.ALLES || gezegd.length > voor || !uit.camera !== !JSON.parse(vorigeUit || "{}").camera)) console.log(new Date(t).toISOString().slice(11, 19), "koers", Math.round(koers), tekst);
    vorigeUit = tekst;
    t += stap * 1000;
  }
}
console.log("gezegd:", gezegd);
