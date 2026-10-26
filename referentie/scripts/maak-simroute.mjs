// Maakt een nep-GPS-route voor de proefrit in de browser (?sim=<naam>): volgt een echte
// weg uit OSM (Overpass) vanaf een punt vóór het doel tot voorbij het doel.
// node scripts/maak-simroute.mjs <naam> <lat> <lon> <richting> <ref> <kmh> [voor_m] [na_m]
import fs from "node:fs";
const [naam, lat, lon, dir, ref, kmh, voor = "1500", na = "500"] = process.argv.slice(2);
const doel = [Number(lat), Number(lon)], richting = Number(dir);
const R = 6371000, rad = Math.PI / 180;
const afstand = (a, b) => { const dl = (b[0] - a[0]) * rad, dn = (b[1] - a[1]) * rad; const s = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const peiling = (a, b) => { const y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad); const x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad); return (Math.atan2(y, x) / rad + 360) % 360; };
const verschil = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const straal = Number(voor) + Number(na) + 500;
const Q = `[out:json][timeout:60];way(around:${straal},${lat},${lon})["ref"="${ref}"]["highway"];out geom;`;
const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "rijhulp-open/0.1 (" + (process.env.RIJHULP_CONTACT || "zet RIJHULP_CONTACT op je eigen site of e-mail") + ")" }, body: "data=" + encodeURIComponent(Q) });
const wegen = (await res.json()).elements.filter((w) => w.geometry);
// Gerichte stukken: elk wegdeel in de toegestane richting(en).
const stukken = [];
for (const w of wegen) {
  const p = w.geometry.map((g) => [g.lat, g.lon]);
  const eenrichting = w.tags.oneway === "yes" || /motorway/.test(w.tags.highway);
  for (let i = 1; i < p.length; i++) {
    stukken.push([p[i - 1], p[i]]);
    if (!eenrichting) stukken.push([p[i], p[i - 1]]);
  }
}
const sleutel = (p) => p[0].toFixed(7) + "," + p[1].toFixed(7);
const vanuit = new Map();
for (const s of stukken) { const k = sleutel(s[0]); if (!vanuit.has(k)) vanuit.set(k, []); vanuit.get(k).push(s); }
// Begin: het stuk in de goede richting dat het dichtst ligt bij het punt `voor` meter vóór het doel.
const terug = (richting + 180) * rad, d = Number(voor) / R;
const startPunt = [doel[0] + (d * Math.cos(terug)) / rad, doel[1] + (d * Math.sin(terug)) / rad / Math.cos(doel[0] * rad)];
let huidig = stukken.filter((s) => verschil(peiling(s[0], s[1]), richting) < 60).sort((a, b) => afstand(a[0], startPunt) - afstand(b[0], startPunt))[0];
const route = [huidig[0]];
let voorbij = false, naDoel = 0, gezien = new Set();
for (let stap = 0; stap < 5000 && huidig; stap++) {
  route.push(huidig[1]);
  if (afstand(huidig[1], doel) < 40) voorbij = true;
  if (voorbij) naDoel += afstand(huidig[0], huidig[1]);
  if (voorbij && naDoel > Number(na)) break;
  gezien.add(sleutel(huidig[0]) + ">" + sleutel(huidig[1]));
  const b = peiling(huidig[0], huidig[1]);
  const volgende = (vanuit.get(sleutel(huidig[1])) ?? []).filter((s) => !gezien.has(sleutel(s[0]) + ">" + sleutel(s[1])) && verschil(peiling(s[0], s[1]), b) < 100);
  huidig = volgende.sort((x, y) => verschil(peiling(x[0], x[1]), b) - verschil(peiling(y[0], y[1]), b))[0];
}
let lengte = 0; for (let i = 1; i < route.length; i++) lengte += afstand(route[i - 1], route[i]);
const minAfstand = Math.min(...route.map((p) => afstand(p, doel)));
fs.writeFileSync(new URL(`../site/sim/${naam}.json`, import.meta.url), JSON.stringify({ naam, kmh: Number(kmh), route: route.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]), bron: "© OpenStreetMap-bijdragers, ODbL" }));
console.log(naam, route.length, "punten", Math.round(lengte), "m, dichtst bij doel", Math.round(minAfstand), "m, voorbij doel:", voorbij);
