// Controleert de feed van een deelnemer: handtekening, vorm en inhoud.
//   node protocol/controleer-feed.mjs <app-id> <vak>
// Leest de deelnemer uit deelnemers.json. Voorbeeld van een vak: 260_15 (rond Rotterdam).
import fs from "node:fs";
import { haal } from "./feed.mjs";

const [id, vak] = process.argv.slice(2);
if (!id || !/^-?\d{1,4}_-?\d{1,4}$/.test(vak || "")) { console.error("gebruik: node protocol/controleer-feed.mjs <app-id> <vak>"); process.exit(1); }
const lijst = JSON.parse(fs.readFileSync(new URL("../deelnemers.json", import.meta.url), "utf8")).deelnemers;
const d = lijst.find((x) => x.id === id);
if (!d) { console.error("niet in deelnemers.json:", id); process.exit(1); }
const uit = await haal(d, vak);
console.log(uit.ok ? "ok" : "FOUT", uit.fouten.join(", "), uit.meldingen.length, "meldingen");
process.exit(uit.ok ? 0 : 1);
