// Haalt de landsgrenzen eenmalig op (Overpass, (c) OpenStreetMap-bijdragers, ODbL) van de landen
// die in ../../landen.json op "aan" staan, vereenvoudigt ze tot ~100 m en schrijft
// site/data/grenzen.json, plus een kopie van landen.json als site/data/landen.json.
// De rijhulp zet de flitserlaag alleen aan binnen deze grenzen; overal anders staat hij uit.
// Een punt-in-veelhoek met een straal over losse lijnstukken: de ringen hoeven niet aan elkaar.
import fs from "node:fs";
const landenTekst = fs.readFileSync(new URL("../../landen.json", import.meta.url), "utf8");
const landen = JSON.parse(landenTekst).landen;
const aan = Object.keys(landen).filter((cc) => landen[cc].flitsers === "aan");
const Q = `[out:json][timeout:600];rel["ISO3166-1"~"^(${aan.join("|")})$"]["admin_level"="2"]["type"="boundary"];out geom;`;
const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "rijhulp-open/0.1 (" + (process.env.RIJHULP_CONTACT || "zet RIJHULP_CONTACT op je eigen site of e-mail") + ")" }, body: "data=" + encodeURIComponent(Q) });
if (!res.ok) { console.error(res.status); process.exit(1); }
const j = await res.json();
const R = 6371000, rad = Math.PI / 180;
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const lat0 = pts[0][0] * rad, kx = Math.cos(lat0) * 111320, ky = 110540;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const ax = pts[a][1] * kx, ay = pts[a][0] * ky, bx = pts[b][1] * kx, by = pts[b][0] * ky;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][1] * kx, py = pts[i][0] * ky;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const uit = { bron: "© OpenStreetMap-bijdragers, ODbL", landen: {} };
for (const r of j.elements) {
  const cc = r.tags["ISO3166-1"];
  const lijnen = [];
  for (const m of r.members) {
    if (m.type !== "way" || !m.geometry || (m.role !== "outer" && m.role !== "inner")) continue;
    // geom(bbox) knipt: stukken buiten het kader komen als null terug, die splitsen de lijn.
    let stuk = [];
    for (const g of m.geometry) {
      if (!g) { if (stuk.length > 1) lijnen.push(stuk); stuk = []; continue; }
      stuk.push([g.lat, g.lon]);
    }
    if (stuk.length > 1) lijnen.push(stuk);
  }
  const vlak = lijnen.map((l) => dp(l, 100).flatMap((p) => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]));
  uit.landen[cc] = vlak;
  console.log(cc, lijnen.length, "lijnen,", vlak.reduce((s, v) => s + v.length / 2, 0), "punten");
}
fs.mkdirSync(new URL("../site/data/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../site/data/grenzen.json", import.meta.url), JSON.stringify(uit));
fs.writeFileSync(new URL("../site/data/landen.json", import.meta.url), landenTekst);
console.log("bytes", fs.statSync(new URL("../site/data/grenzen.json", import.meta.url)).size);
