// Maakt een nep-GPS-route voor de proefrit in de browser (?sim=<naam>): volgt een echte
// weg uit OSM (Overpass) vanaf een punt vóór het doel tot voorbij het doel.
// node scripts/maak-simroute.mjs <naam> <lat> <lon> <richting> <ref> <kmh> [voor_m] [na_m]
// Met ref "kaart:<highway>" (bijv. kaart:motorway) komt de weg uit de vooraf gemaakte kaart in
// site/kaart/ in plaats van Overpass: alle wegen met dat type, zonder ref (de kaart heeft geen ref).
import fs from "node:fs";
const [naam, lat, lon, dir, ref, kmh, voor = "1500", na = "500"] = process.argv.slice(2);
const doel = [Number(lat), Number(lon)], richting = Number(dir);
const R = 6371000, rad = Math.PI / 180;
const afstand = (a, b) => { const dl = (b[0] - a[0]) * rad, dn = (b[1] - a[1]) * rad; const s = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const peiling = (a, b) => { const y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad); const x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad); return (Math.atan2(y, x) / rad + 360) % 360; };
const verschil = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const straal = Number(voor) + Number(na) + 500;
let wegen;
if (ref.startsWith("kaart:")) {
  // Vooraf gemaakte kaart: vakken van 0,2 x 0,3 graad, lijnen als Google-polyline (1e-5 graad).
  const soort = ref.slice(6);
  const polyline = (s) => { const p = []; let i = 0, la = 0, lo = 0; while (i < s.length) { for (let k = 0; k < 2; k++) { let v = 0, sch = 0, b; do { b = s.charCodeAt(i++) - 63; v |= (b & 0x1f) << sch; sch += 5; } while (b >= 0x20 && i < s.length); const dd = v & 1 ? ~(v >> 1) : v >> 1; if (k === 0) la += dd; else lo += dd; } p.push({ lat: la / 1e5, lon: lo / 1e5 }); } return p; };
  const dl = straal / 110540, dn = straal / (111320 * Math.cos(doel[0] * rad));
  const vakken = new Set();
  for (const a of [doel[0] - dl, doel[0], doel[0] + dl]) for (const b of [doel[1] - dn, doel[1], doel[1] + dn]) vakken.add(Math.floor(a / 0.2) + "_" + Math.floor(b / 0.3));
  wegen = [];
  for (const v of vakken) {
    const bestand = new URL(`../site/kaart/${v}.json`, import.meta.url);
    if (!fs.existsSync(bestand)) continue;
    const j = JSON.parse(fs.readFileSync(bestand, "utf8"));
    for (let i = 0; i + 1 < j.w.length; i += 2) {
      const tg = j.t[j.w[i]] || [];
      if (tg[0] !== soort) continue;
      const g = polyline(j.w[i + 1]);
      if (g.some((q) => afstand([q.lat, q.lon], doel) < straal)) wegen.push({ tags: { highway: tg[0], oneway: tg[5] }, geometry: g });
    }
  }
} else {
  const Q = `[out:json][timeout:60];way(around:${straal},${lat},${lon})["ref"="${ref}"]["highway"];out geom;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "rijhulp-open/0.1 (" + (process.env.RIJHULP_CONTACT || "zet RIJHULP_CONTACT op je eigen site of e-mail") + ")" }, body: "data=" + encodeURIComponent(Q) });
  wegen = (await res.json()).elements.filter((w) => w.geometry);
}
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
  // Ook tussen twee punten door (de kaart heeft lange rechte stukken): het dichtste punt op het stuk.
  const f = Math.max(0, Math.min(1, ((doel[0] - huidig[0][0]) * (huidig[1][0] - huidig[0][0]) + (doel[1] - huidig[0][1]) * (huidig[1][1] - huidig[0][1]) * Math.cos(doel[0] * rad) ** 2) / Math.max(1e-12, (huidig[1][0] - huidig[0][0]) ** 2 + ((huidig[1][1] - huidig[0][1]) * Math.cos(doel[0] * rad)) ** 2)));
  if (!voorbij && afstand([huidig[0][0] + (huidig[1][0] - huidig[0][0]) * f, huidig[0][1] + (huidig[1][1] - huidig[0][1]) * f], doel) < 40) { voorbij = true; naDoel = -afstand(huidig[0], huidig[1]) * f; }
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
