// Haalt de flitspalen en handhavingsrelaties eenmalig op bij Overpass, voor de landen die in
// ../../landen.json op "aan" staan, en bewaart het ruwe antwoord in data-bron/. Daarna maakt bouw-flitsers.mjs er het
// compacte bestand voor de site van. Data: (c) OpenStreetMap-bijdragers, ODbL.
// Netjes: één verzoek, met een eigen User-Agent (zet RIJHULP_CONTACT); niet vaker dan nodig draaien.
// Voor grote landen is de route via een Geofabrik-extract (flitsers-uit-pbf.mjs) beter.
import fs from "node:fs";
const landen = JSON.parse(fs.readFileSync(new URL("../../landen.json", import.meta.url), "utf8")).landen;
const aan = Object.keys(landen).filter((cc) => landen[cc].flitsers === "aan");
const gebied = aan.map((cc, i) => `area["ISO3166-1"="${cc}"][admin_level=2]->.a${i};`).join("\n");
const camera = aan.map((_, i) => `node["highway"="speed_camera"](area.a${i});node["enforcement"](area.a${i});`).join("");
const rel = aan.map((_, i) => `rel["type"="enforcement"](area.a${i});`).join("");
const Q = `[out:json][timeout:600];
${gebied}
(${camera})->.c;
.c out body;
(${rel})->.r;
.r out geom;`;
fs.mkdirSync(new URL("../data-bron/", import.meta.url), { recursive: true });
const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "rijhulp-open/0.1 (" + (process.env.RIJHULP_CONTACT || "zet RIJHULP_CONTACT op je eigen site of e-mail") + ")" },
  body: "data=" + encodeURIComponent(Q),
});
if (!res.ok) { console.error("Overpass", res.status, (await res.text()).slice(0, 300)); process.exit(1); }
const json = await res.json();
fs.writeFileSync(new URL("../data-bron/osm-flitsers.json", import.meta.url), JSON.stringify(json));
console.log("elementen", json.elements.length, "stand", json.osm3s?.timestamp_osm_base);
