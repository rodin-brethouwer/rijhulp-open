// De rijhulp op Node: serveert site/ en stuurt /api en /feed naar server/server.mjs, met de
// database op node:sqlite (server/adapters/sqlite.mjs). Lokaal om te proberen, en ook om echt te
// draaien op een eigen VPS of server met Node, of op Replit, Railway of Render met een schijf.
//
// node scripts/lokaal.mjs [poort] [databasebestand]      (of npm start in de wortel)
//
// De database: met DATABASE_URL Postgres (server/adapters/postgres.mjs, eerst npm install pg en
// eenmalig server/adapters/postgres-schema.sql), anders SQLite in het databasebestand of in
// RIJHULP_DB. Zonder bestand staat alles in het geheugen en is het weg na een herstart.
// Omgeving (allemaal optioneel):
//   PORT            de poort als je die niet als argument geeft (Replit, Railway en Render zetten hem)
//   RIJHULP_DB      het SQLite-bestand als je het niet als argument geeft
//   DATABASE_URL    een Postgres-adres; dan geen SQLite
//   APP_ID          je id uit deelnemers.json
//   FEED_SLEUTEL    de geheime sleutel voor de feed (uit scripts/maak-sleutel.mjs), als geheim bij je host
//   RIJHULP_PROXY=1 achter een reverse proxy (nginx, Caddy, het platform): het IP komt dan uit
//                   X-Forwarded-For in plaats van van de verbinding
//   RIJHULP_KLOK=1  zet POST /__klok {"plus_min": 200} aan om de klok te verschuiven, alleen voor een proef
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { maakServer } from "../server/server.mjs";
import { sqliteDb, migreer } from "../server/adapters/sqlite.mjs";
import { postgresDb } from "../server/adapters/postgres.mjs";

const poort = Number(process.argv[2] || process.env.PORT || 8787);
let DB;
if (process.env.DATABASE_URL) {
  const pg = (await import("pg")).default;
  DB = postgresDb(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 }));
} else {
  DB = sqliteDb(process.argv[3] || process.env.RIJHULP_DB || ":memory:");
  migreer(DB);
}
// HERKOMST: achter een proxy de echte origin van de site (komma's voor meer); zonder die geldt alleen
// http://localhost:<poort>, en weigert de server een POST van een andere herkomst met 403.
const env = { DB, APP_ID: process.env.APP_ID, FEED_SLEUTEL: process.env.FEED_SLEUTEL, HERKOMST: process.env.RIJHULP_HERKOMST };
const grenzen = JSON.parse(fs.readFileSync(new URL("../site/data/grenzen.json", import.meta.url))).landen;
let plus = 0; // de verschuiving van de klok voor een proef (RIJHULP_KLOK=1)
// Matrixborden (NL): alleen als scripts/bouw-msi.mjs server/msi-vakken.json heeft gemaakt.
const msiPad = new URL("../server/msi-vakken.json", import.meta.url);
const msiVakken = fs.existsSync(msiPad) ? JSON.parse(fs.readFileSync(msiPad)) : null;
const server = maakServer({ grenzen, nu: () => Date.now() + plus, msiVakken });
// Opruimen ook zonder nieuwe meldingen: elk uur, zoals OPRUIMEN_CRON bij een host met cron.
setInterval(() => { server.scheduled({}, env).catch((e) => console.error("opruimen", e && e.message)); }, 3600e3).unref();
const wortel = new URL("../site/", import.meta.url).pathname;
const TYPE = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".txt": "text/plain" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${poort}`);
  const delen = []; let grootte = 0;
  for await (const d of req) { grootte += d.length; if (grootte > 64 * 1024) { res.writeHead(413); res.end(); req.destroy(); return; } delen.push(d); }
  const body = Buffer.concat(delen);
  if (process.env.RIJHULP_KLOK === "1" && url.pathname === "/__klok" && req.method === "POST") { plus += (JSON.parse(body.toString() || "{}").plus_min || 0) * 60e3; res.end(JSON.stringify({ plus_min: plus / 60e3 })); return; }
  if (url.pathname.startsWith("/api/") || url.pathname === "/feed") {
    const kop = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") kop.set(k, v);
    const doorgegeven = process.env.RIJHULP_PROXY === "1" ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
    kop.set("x-real-ip", doorgegeven || req.socket.remoteAddress || "");
    kop.delete("cf-connecting-ip");
    const r = await server.fetch(new Request(url, { method: req.method, headers: kop, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env, null);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let p = path.join(wortel, decodeURIComponent(url.pathname));
  if (!p.startsWith(wortel)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!fs.existsSync(p)) { res.writeHead(404); res.end("niet gevonden"); return; }
  res.writeHead(200, { "Content-Type": TYPE[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(p).pipe(res);
}).listen(poort, () => console.log(`rijhulp op http://localhost:${poort}`));
