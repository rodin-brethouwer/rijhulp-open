// Haalt de flitspalen en handhavingsrelaties uit Geofabrik-extracten (per land dat in landen.json aan staat)
// (in plaats van uit Overpass) en schrijft ze in dezelfde vorm als het Overpass-antwoord
// naar data-bron/osm-flitsers.json. Daarna maakt bouw-flitsers.mjs er site/data/flitsers.json van.
// Data: (c) OpenStreetMap-bijdragers, ODbL.
//
//   node scripts/flitsers-uit-pbf.mjs <werkmap> <land.osm.pbf> [<land.osm.pbf> ...]
//
// Nodig: osmium-tool. Er wordt niets uit de download uitgevoerd; osmium leest hem als data.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

const [werk, ...pbfs] = process.argv.slice(2);
if (!werk || !pbfs.length) { console.error("gebruik: node scripts/flitsers-uit-pbf.mjs <werkmap> <land.osm.pbf> ..."); process.exit(1); }
fs.mkdirSync(werk, { recursive: true });

// OPL: tekens buiten het gewone bereik staan als %hex%.
const ont = (s) => s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
function tags(s) {
  const t = {};
  if (!s) return t;
  for (const kv of s.split(",")) { const i = kv.indexOf("="); if (i > 0) t[ont(kv.slice(0, i))] = ont(kv.slice(i + 1)); }
  return t;
}
const knopen = new Map(), wegen = new Map(), relaties = new Map();
let stand = null;
for (const pbf of pbfs) {
  const naam = path.basename(pbf).replace(/\.osm\.pbf$/, "");
  const opl = path.join(werk, naam + "-flitsers.opl");
  execFileSync("osmium", ["tags-filter", pbf, "n/highway=speed_camera", "n/enforcement", "r/type=enforcement", "-f", "opl", "-o", opl, "--overwrite"], { stdio: "inherit" });
  const kop = execFileSync("osmium", ["fileinfo", "-g", "header.option.osmosis_replication_timestamp", pbf], { encoding: "utf8" }).trim();
  if (kop && (!stand || kop < stand)) stand = kop;
  const rl = readline.createInterface({ input: fs.createReadStream(opl), crlfDelay: Infinity });
  for await (const regel of rl) {
    if (!regel) continue;
    const delen = regel.split(" ");
    const soort = delen[0][0], id = Number(delen[0].slice(1));
    const v = {};
    for (const d of delen.slice(1)) v[d[0]] = d.slice(1);
    if (soort === "n") knopen.set(id, { type: "node", id, lat: Number(v.y), lon: Number(v.x), tags: tags(v.T) });
    else if (soort === "w") wegen.set(id, { id, nodes: v.N ? v.N.split(",").map((n) => Number(n.slice(1))) : [] });
    else if (soort === "r") relaties.set(id, { id, tags: tags(v.T), members: v.M ? v.M.split(",").map((m) => { const at = m.indexOf("@"); return { type: { n: "node", w: "way", r: "relation" }[m[0]], ref: Number(m.slice(1, at)), role: ont(m.slice(at + 1)) }; }) : [] });
  }
}
const elementen = [];
// Knopen zoals Overpass ze gaf: met een eigen tag highway=speed_camera of enforcement.
for (const k of knopen.values()) if (k.tags.highway === "speed_camera" || k.tags.enforcement) elementen.push(k);
// Relaties met de geometrie van hun leden, zoals "out geom".
for (const r of relaties.values()) {
  if (r.tags.type !== "enforcement") continue;
  const members = r.members.map((m) => {
    if (m.type === "node") { const k = knopen.get(m.ref); return k ? { ...m, lat: k.lat, lon: k.lon } : m; }
    if (m.type === "way") {
      const w = wegen.get(m.ref);
      const geometry = w ? w.nodes.map((n) => knopen.get(n)).filter(Boolean).map((k) => ({ lat: k.lat, lon: k.lon })) : null;
      return geometry && geometry.length >= 2 ? { ...m, geometry } : m;
    }
    return m;
  });
  elementen.push({ type: "relation", id: r.id, tags: r.tags, members });
}
const uit = new URL("../data-bron/osm-flitsers.json", import.meta.url);
fs.writeFileSync(uit, JSON.stringify({ osm3s: { timestamp_osm_base: stand }, elements: elementen }));
console.log("knopen", elementen.filter((e) => e.type === "node").length, "relaties", elementen.filter((e) => e.type === "relation").length, "stand", stand);
