// Maakt een Ed25519-sleutelpaar voor je feed (PROTOCOL.md, ondertekening).
//   node scripts/maak-sleutel.mjs <pad-voor-de-geheime-sleutel>
// De geheime sleutel (PKCS8, base64url) gaat naar het bestand dat je opgeeft, met rechten 600, en
// nooit naar het scherm. Kies een pad buiten deze repo. Zet hem daarna als geheim FEED_SLEUTEL bij je
// host. De publieke sleutel wordt geprint: die zet je in je regel in deelnemers.json.
import fs from "node:fs";
import path from "node:path";

const doel = process.argv[2];
if (!doel) { console.error("gebruik: node scripts/maak-sleutel.mjs <pad-buiten-de-repo>"); process.exit(1); }
const repo = path.resolve(new URL("../../", import.meta.url).pathname);
const pad = path.resolve(doel);
if (pad.startsWith(repo + path.sep)) { console.error("kies een pad buiten de repo, zodat de sleutel nooit mee gecommit wordt"); process.exit(1); }
if (fs.existsSync(pad)) { console.error("bestaat al, ik overschrijf niets:", pad); process.exit(1); }
const paar = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const b64 = (b) => Buffer.from(b).toString("base64url");
fs.writeFileSync(pad, b64(await crypto.subtle.exportKey("pkcs8", paar.privateKey)) + "\n", { mode: 0o600 });
console.log("geheime sleutel geschreven naar", pad);
console.log("publieke_sleutel:", b64(await crypto.subtle.exportKey("raw", paar.publicKey)));
