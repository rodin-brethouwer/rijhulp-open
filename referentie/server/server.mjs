// Referentieserver van rijhulp-open: gemelde mobiele flitsers. Draait als fetch-handler op elke
// runtime die een kleine database-interface geeft als env.DB: prepare(sql).bind(...).first/all/run
// en batch([...]). Kant-en-klare tussenstukken staan in server/adapters/ (sqlite.mjs voor Node,
// postgres.mjs voor Postgres); lokaal draaien met scripts/lokaal.mjs.
//
// Eén tik in de auto legt positie en rijrichting vast; andere gebruikers krijgen op die plek een
// melding en bij het langsrijden de vraag "Staat hij er nog?". De melder zelf krijgt die
// vraag ook, maar pas als zijn melding minstens REGELS.eigenNaMin oud is (mobiele flitsers staan
// niet vast, en soms is er maar één gebruiker); zijn nee haalt de melding meteen weg.
//
// Privacy: geen account, geen IP-adres en geen toestel-id bewaard. Alleen hashes met een zout
// dat elke dag (UTC) nieuw is en na die dag verdwijnt: daarmee zijn de limieten per dag te
// tellen, maar is niets over dagen heen aan elkaar te koppelen. "Eigen melding" is dus ook alleen
// binnen een dag (UTC) te herkennen: na de wissel van het zout is de melder een andere gebruiker.
//
// GET  /api/meldingen?vak=<lat>_<lon>       actieve meldingen in een kaartvak (0,2 x 0,3 graad), voor de eigen app
// POST /api/meldingen                       { toestel, lat, lon, koers, nauwkeurig }
// POST /api/meldingen/<id>/stem             { toestel, ja: true|false }
// POST /api/toestel                         {}  -> { toestel }: een ondertekend toestel-id van de server
// GET  /feed?vak=<lat>_<lon>                de feed voor andere apps volgens PROTOCOL.md (versie 0.1),
//                                           ondertekend met Ed25519 als env.FEED_SLEUTEL er is; ook als
//                                           /api/feed, voor hosts die alleen /api naar de server sturen
//
// Omgeving: env.DB (database), env.APP_ID (je id uit deelnemers.json), env.FEED_SLEUTEL (de
// geheime sleutel als PKCS8 in base64url, uit scripts/maak-sleutel.mjs; zet hem als geheim bij je
// host, nooit in de repo). De grenzen van de landen die aan staan (site/data/grenzen.json) zet je
// bij het bundelen als const GRENZEN boven deze code, of je geeft ze mee aan maakServer.
//
// Opruimen (oude meldingen, stemmen, de gehashte codes en het dagzout van gisteren) gebeurt bij
// elke nieuwe melding en via scheduled(): laat je host die elk uur aanroepen (OPRUIMEN_CRON, een
// cron trigger, of setInterval in Node zoals scripts/lokaal.mjs), anders blijven die gegevens
// staan zolang er geen nieuwe melding komt.

export const OPRUIMEN_CRON = "0 * * * *"; // elk uur, in UTC

export const VAK_LAT = 0.2, VAK_LON = 0.3; // gelijk aan de kaartvakken (10 x 10 tegels van 0,02 x 0,03)
export const REGELS = {
  basisMin: 180, // een nieuwe melding leeft drie uur
  jaMin: 120, // elke ja: nog minstens twee uur vanaf nu
  maxUur: 8, // nooit langer dan acht uur na de melding
  neeMin: 30, // een nee: hooguit nog een half uur
  neeWeg: 2, // twee nee en meer nee dan ja: meteen weg
  samenM: 200, // binnen 200 m en dezelfde richting: dezelfde flitser
  tussenMin: 5, // per toestel: niet twee meldingen binnen vijf minuten
  perToestelDag: 8,
  perVingerTienMin: 6, // een vingerafdruk (IP plus browser) deelt een auto met veel anderen achter hetzelfde mobiele IP
  perVingerDag: 60,
  stemmenPerToestelDag: 200,
  // Security-review 26 okt 2026 (H1, H2): ook per IP-hash en per net (/24 of /48), los van het
  // toestel-id en de browser, want die kiest de client zelf. Een gedeeld mobiel IP raakt dit
  // eerder; dat is de prijs.
  perIpUur: 10,
  perIpDag: 30,
  perNetUur: 30,
  perNetDag: 100,
  stemmenPerIpUur: 30,
  stemmenPerNetUur: 100,
  eigenNaMin: 20, // de melder stemt pas op zijn eigen melding als die minstens zo oud is
  eigenTussenMin: 20, // en daarna hooguit eens per zoveel minuten (een ja telt als elke ja, een nee haalt hem weg)
  cacheS: 15,
  toestellenPerIpDag: 5, // H1: de server geeft toestel-ids uit, hooguit zoveel per IP-hash per dag
  toestellenPerNetDag: 30,
  versPerDag: 2, // een toestel-id van vandaag meldt hooguit zo vaak, en zijn nee haalt niets meteen weg
  toestelDagen: 365, // daarna vraagt de app een nieuw id
  apiPerIpMin: 240, // M1: alle /api-verzoeken per IP per minuut, in deze isolate (een auto doet er ca. 6)
};

/** M1: een vak in één schrijfwijze ("0260_016" wordt "260_16"), of null. Alleen echte vakken op aarde. */
export function leesVak(s) {
  const m = /^(-?\d{1,4})_(-?\d{1,4})$/.exec(s || "");
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (a < -450 || a >= 450 || b < -600 || b >= 600) return null;
  return { a, b, vak: a + "_" + b };
}
/** De vakken waar meldingen kunnen staan: de omhullende van de grenzen, met een vak marge. */
export function vakBereik(grenzen) {
  if (!grenzen) return null;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const cc of Object.keys(grenzen)) for (const l of grenzen[cc]) for (let j = 0; j < l.length; j += 2) {
    a0 = Math.min(a0, Math.floor(l[j] / VAK_LAT)); a1 = Math.max(a1, Math.floor(l[j] / VAK_LAT));
    b0 = Math.min(b0, Math.floor(l[j + 1] / VAK_LON)); b1 = Math.max(b1, Math.floor(l[j + 1] / VAK_LON));
  }
  return Number.isFinite(a0) ? { a0, a1, b0, b1 } : null;
}

const R = 6371000, rad = Math.PI / 180;
export function afstand(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function verschil(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }
export function binnen(lat, lon, lijnen) {
  let telling = 0;
  for (const l of lijnen) {
    for (let j = 2; j < l.length; j += 2) {
      const y1 = l[j - 2], x1 = l[j - 1], y2 = l[j], x2 = l[j + 1];
      if ((y1 > lat) !== (y2 > lat) && x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1) > lon) telling++;
    }
  }
  return telling % 2 === 1;
}
/** Het net van een IP-adres: /24 bij IPv4, /48 bij IPv6 (ook ::ffff:a.b.c.d telt als IPv4). */
export function netVan(ip) {
  if (!ip) return "";
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return v4[1] + "." + v4[2] + "." + v4[3];
  const [kop, staart] = ip.toLowerCase().split("::");
  const a = kop ? kop.split(":") : [];
  const b = staart == null ? [] : staart ? staart.split(":") : [];
  const groepen = staart == null ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
  return groepen.slice(0, 3).map((g) => parseInt(g || "0", 16).toString(16)).join(":");
}
/** Het IP van de bezoeker: cf-connecting-ip achter Cloudflare, anders x-real-ip zoals
 *  scripts/lokaal.mjs het zelf zet (die wist wat de client meestuurt; achter een eigen proxy alleen
 *  met RIJHULP_PROXY=1). Zet je de server zelf achter een andere host, zorg dan dat de client deze
 *  headers niet zelf kan kiezen, anders werken de limieten per IP niet. */
export function ipVan(req) { return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || ""; }
export function vakVan(lat, lon) { return Math.floor(lat / VAK_LAT) + "_" + Math.floor(lon / VAK_LON); }

function antwoord(status, body, extra) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(extra || {}) } });
}
const fout = (status, code, extra) => antwoord(status, { fout: code }, extra);

async function sha(tekst) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tekst));
  return [...new Uint8Array(b)].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function willekeurig() { const b = new Uint8Array(32); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }

const TOESTEL = /^[A-Za-z0-9_-]{16,64}$/;
// H1: het toestel-id geeft de server uit (POST /api/toestel): "b", de dag van uitgifte (dagen sinds
// 1970, UTC), 16 hex willekeurig en 24 hex HMAC-SHA256 met een sleutel in de eigen database. Een id
// dat de client zelf verzint, wordt geweigerd. Het id zelf wordt nergens bewaard.
const TOESTEL_SERVER = /^b(\d{5})([0-9a-f]{16})([0-9a-f]{24})$/;
const dagNr = (t) => Math.floor(t / 86400e3);

// Security-review 26 okt 2026 (H3): een schrijfverzoek alleen als JSON en alleen van de eigen site.
// Een POST met text/plain is een "simple request" zonder preflight: zonder deze controle kan elke
// andere site zijn bezoekers onzichtbaar laten melden of stemmen.
// Zonder lijst geldt alleen de origin van het verzoek zelf. Achter een proxy (scripts/lokaal.mjs
// ziet http://localhost) geef je de echte herkomst op: env.HERKOMST="https://jouw.site" (komma's
// voor meer), of opties.herkomsten.
export const EIGEN_HERKOMST = [];
/** null als het verzoek mag, anders het antwoord (415 of 403). */
export function poortSchrijven(req, url, herkomsten = EIGEN_HERKOMST) {
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return fout(415, "type");
  const herkomst = req.headers.get("origin");
  if (herkomst != null && herkomst !== url.origin && !herkomsten.includes(herkomst)) return fout(403, "herkomst");
  const site = req.headers.get("sec-fetch-site");
  if (site != null && site !== "same-origin") return fout(403, "herkomst");
  return null;
}

// ---------- Matrixborden (MSI) van NDW ----------
// De feed (open data van NDW, CC0 1.0) is één bestand voor heel Nederland, elke minuut nieuw,
// ca. 1 MB gz en 9 MB XML, zonder CORS en zonder coordinaten. Deze code haalt hem hooguit eens
// per MSI_REGELS.verversS op (bij een verzoek, dus zonder cron), leest alleen de beelden die niet leeg zijn, en geeft per kaartvak de borden die in
// server/msi-vakken.json bij dat vak staan. De plek van elk bord staat in site/msi/<vak>.json (de
// app rekent zelf welk portaal voor hem ligt). Een bord heet naar het begin van zijn uuid.
export const MSI_BRON = "https://opendata.ndw.nu/Matrixsignaalinformatie.xml.gz";
export const MSI_REGELS = {
  verversS: 60, // de feed hooguit eens per minuut ophalen
  oudS: 600, // een feed ouder dan tien minuten telt niet meer (NDW of de lijn ligt eruit)
  cacheS: 30, // per vak in de browser en de Cache API
};

/** Eén beeld als korte code: "80" (rode rand: geldt), "a70" (advies, zonder rode rand),
 *  "a70f" (advies met knipperlichten), "x" (rijstrook dicht), "<" of ">" (invoegen naar links of
 *  rechts), "!" (strook verderop dicht), "o" (groene pijl), "e" (einde), "?" (onbekend). Leeg: null. */
export function beeldCode(s) {
  const m = /^<speedlimit([^>]*)>\s*(\d{2,3})\s*</.exec(s);
  if (m) return (/red_ring="true"/.test(m[1]) ? "" : "a") + m[2] + (/flashing="true"/.test(m[1]) ? "f" : "");
  if (s.startsWith("<lane_closed_ahead")) return /merge_left/.test(s) ? "<" : /merge_right/.test(s) ? ">" : "!";
  if (s.startsWith("<lane_closed")) return "x";
  if (s.startsWith("<lane_open")) return "o";
  if (s.startsWith("<restriction_end")) return "e";
  if (s.startsWith("<unknown")) return "?";
  return null;
}

/** De feed lezen: { id: code } voor elk bord dat iets toont. Met indexOf in plaats van een
 *  XML-parser: 9 MB in ca. 6 ms, binnen de CPU-grens van een verzoek. */
export function leesMsi(xml, idLengte = 8) {
  const uit = {};
  let i = 0, n = 0;
  for (;;) {
    const d = xml.indexOf("<display>", i);
    if (d < 0) break;
    i = d + 9;
    n++;
    if (xml.startsWith("<blank", i)) continue;
    const u = xml.lastIndexOf("<uuid>", d);
    const e = xml.indexOf("</display>", i);
    if (u < 0 || d - u > 80 || e < 0) continue;
    const code = beeldCode(xml.slice(i, e));
    if (code) uit[xml.slice(u + 6, u + 42).replace(/-/g, "").slice(0, idLengte)] = code;
    i = e;
  }
  return { borden: uit, beelden: n };
}

/** Haalt de feed op en leest hem; geeft { t, bron, borden, etag } of gooit. */
async function haalMsiFeed(doeFetch, vorige, t) {
  const kop = { "User-Agent": "rijhulp-open/0.1 (+https://github.com/rodin-brethouwer/rijhulp-open)" };
  if (vorige && vorige.etag) kop["If-None-Match"] = vorige.etag;
  // De minuut in de query: zonder die gaf een fetch vanuit Cloudflare een kopie uit de cache
  // van een kwartier oud terug (.gz valt daar onder de standaardcache), gemeten 25 okt 2026.
  const r = await doeFetch(MSI_BRON + "?m=" + Math.floor(t / 60000), { headers: kop });
  if (r.status === 304 && vorige) return { ...vorige, t };
  if (!r.ok || !r.body) throw new Error("ndw " + r.status);
  const xml = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  const { borden, beelden } = leesMsi(xml, MSI_ID_LENGTE);
  if (beelden < 1000) throw new Error("ndw feed te klein: " + beelden);
  const lm = Date.parse(r.headers.get("last-modified") || "");
  return { t, bron: Number.isFinite(lm) ? lm : t, borden, etag: r.headers.get("etag") || null };
}
let MSI_ID_LENGTE = 8;

/** De server; opties.nu en opties.grenzen voor de test. */
export function maakServer(opties = {}) {
  const nu = opties.nu || (() => Date.now());
  const grenzen = opties.grenzen;
  const msiVakken = opties.msiVakken || null; // { idLengte, vakken: { vak: "id,id,..." } }
  if (msiVakken && msiVakken.idLengte) MSI_ID_LENGTE = msiVakken.idLengte;
  const msiIds = new Map(); // vak -> [id, ...], pas bij de eerste vraag naar dat vak; alleen vakken uit msiVakken
  const bereik = vakBereik(grenzen);
  const perIp = new Map(); // ip -> { m: minuut, n }: de eenvoudige limiet op /api, alleen in het geheugen
  function teVeel(req) {
    const ip = ipVan(req);
    const m = Math.floor(nu() / 60e3);
    let r = perIp.get(ip);
    if (!r || r.m !== m) { if (perIp.size > 20000) perIp.clear(); r = { m, n: 0 }; perIp.set(ip, r); }
    return ++r.n > (opties.apiPerIpMin || REGELS.apiPerIpMin);
  }
  const msi = { data: null, bezig: null, fout: 0 };
  const doeFetch = opties.fetch || ((u, i) => fetch(u, i));
  const geheugen = new Map(); // vak -> { t, body }: in deze isolate, naast de Cache API

  // Alleen melden binnen de landen die in landen.json aan staan: grenzen bevat precies die landen.
  function inLandAan(lat, lon) {
    if (!grenzen) return false;
    for (const cc of Object.keys(grenzen)) if (binnen(lat, lon, grenzen[cc])) return cc;
    return false;
  }

  let hmacSleutel = null;
  async function idSleutel(db) {
    if (hmacSleutel) return hmacSleutel;
    await db.prepare("INSERT OR IGNORE INTO sleutel (naam, waarde) VALUES ('toestel', ?)").bind(willekeurig()).run();
    const rij = await db.prepare("SELECT waarde FROM sleutel WHERE naam = 'toestel'").first();
    const ruw = new Uint8Array(rij.waarde.match(/../g).map((h) => parseInt(h, 16)));
    hmacSleutel = await crypto.subtle.importKey("raw", ruw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hmacSleutel;
  }
  async function tekenId(db, tekst) {
    const b = await crypto.subtle.sign("HMAC", await idSleutel(db), new TextEncoder().encode(tekst));
    return [...new Uint8Array(b)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  /** { dag, vers } voor een geldig, door deze server uitgegeven id; anders null. */
  async function keurToestel(db, id, t) {
    const m = typeof id === "string" ? TOESTEL_SERVER.exec(id) : null;
    if (!m) return null;
    const dag = Number(m[1]), vandaag = dagNr(t);
    if (dag > vandaag || vandaag - dag > REGELS.toestelDagen) return null;
    const verwacht = await tekenId(db, m[1] + m[2]);
    let verschil = 0;
    for (let i = 0; i < 24; i++) verschil |= verwacht.charCodeAt(i) ^ m[3].charCodeAt(i);
    return verschil === 0 ? { dag, vers: dag === vandaag } : null;
  }
  async function geefToestel(req, env) {
    const b = await leesBody(req);
    if (!b) return fout(400, "body");
    const db = env.DB, t = nu();
    const w = await wie(req, db, "", t);
    const dag = String(dagNr(t)).padStart(5, "0"), r = willekeurig().slice(0, 16);
    const id = "b" + dag + r + (await tekenId(db, dag + r));
    const sinds = t - 24 * 3600e3;
    const nee = await boek(db, "toestel", { ...w, toestel: await sha("uitgifte|" + id) }, t, [
      ["ip", w.ip, sinds, REGELS.toestellenPerIpDag, "dag_vol"],
      ["net", w.net, sinds, REGELS.toestellenPerNetDag, "dag_vol"],
    ]);
    if (nee) return fout(429, nee);
    return antwoord(201, { toestel: id });
  }

  async function zout(db, t) {
    const dag = new Date(t).toISOString().slice(0, 10);
    await db.prepare("INSERT OR IGNORE INTO zout (dag, waarde) VALUES (?, ?)").bind(dag, willekeurig()).run();
    const rij = await db.prepare("SELECT waarde FROM zout WHERE dag = ?").bind(dag).first();
    return rij.waarde;
  }
  async function wie(req, db, toestel, t) {
    const z = await zout(db, t);
    const ip = ipVan(req);
    const ua = (req.headers.get("user-agent") || "").slice(0, 200);
    // Het IP gaat alleen door de hash en wordt nergens bewaard.
    return { toestel: await sha(z + "|t|" + toestel), vinger: await sha(z + "|v|" + ip + "|" + ua), ip: await sha(z + "|i|" + ip), net: await sha(z + "|n|" + netVan(ip)) };
  }
  async function opruimen(db, t) {
    const dag = new Date(t).toISOString().slice(0, 10);
    await db.batch([
      db.prepare("DELETE FROM stemmen WHERE melding IN (SELECT id FROM meldingen WHERE verloopt < ?)").bind(t - 24 * 3600e3),
      db.prepare("DELETE FROM meldingen WHERE verloopt < ?").bind(t - 24 * 3600e3),
      db.prepare("DELETE FROM acties WHERE t < ?").bind(t - 26 * 3600e3),
      db.prepare("DELETE FROM zout WHERE dag <> ?").bind(dag),
    ]);
  }
  /** L2 (review 26 okt): eerst de actie boeken en dan tellen, met de eigen rij erbij. Zo glipt een
   *  reeks parallelle verzoeken niet samen onder een grens door. grenzen: [kolom, waarde, sinds, max,
   *  code]. Te veel: de eigen rij weer weg en de code terug; anders null. */
  async function boek(db, soort, w, t, grenzen) {
    await db.prepare("INSERT INTO acties (soort, toestel, vinger, t, ip, net) VALUES (?, ?, ?, ?, ?, ?)").bind(soort, w.toestel, w.vinger, t, w.ip, w.net).run();
    for (const [kolom, waarde, sinds, max, code] of grenzen) {
      const n = Number((await db.prepare(`SELECT COUNT(*) AS n FROM acties WHERE soort = ? AND ${kolom} = ? AND t > ?`).bind(soort, waarde, sinds).first()).n);
      if (n > max) {
        // Zonder rowid, zodat het ook op Postgres werkt: een rij die in alles gelijk is, is dezelfde actie.
        await db.prepare("DELETE FROM acties WHERE soort = ? AND toestel = ? AND vinger = ? AND t = ? AND ip = ? AND net = ?").bind(soort, w.toestel, w.vinger, t, w.ip, w.net).run();
        return code;
      }
    }
    return null;
  }
  function vorm(r) {
    return { id: r.id, lat: r.lat, lon: r.lon, koers: r.koers, gemaakt: r.gemaakt, verloopt: r.verloopt, ja: r.ja, nee: r.nee, laatste_ja: r.laatste_ja };
  }
  function vergeetVak(lat, lon) { geheugen.delete(vakVan(lat, lon)); }

  async function lijst(req, env, ctx) {
    const url = new URL(req.url);
    const v = leesVak(url.searchParams.get("vak"));
    if (!v) return fout(400, "vak");
    const vak = v.vak, t = nu();
    // Buiten NL en BE kan niets staan: meteen leeg, zonder query.
    if (bereik && (v.a < bereik.a0 || v.a > bereik.a1 || v.b < bereik.b0 || v.b > bereik.b1)) return antwoord(200, { nu: t, vak, meldingen: [] }, { "Cache-Control": "public, max-age=3600" });
    const kort = geheugen.get(vak);
    if (kort && !opties.zonderCache && t - kort.t < REGELS.cacheS * 1000) return new Response(kort.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${REGELS.cacheS}` } });
    let cache = null;
    const sleutel = new Request(url.origin + "/api/meldingen?vak=" + vak);
    try { cache = typeof caches !== "undefined" ? caches.default : null; } catch { cache = null; }
    if (cache && !opties.zonderCache) {
      try { const c = await cache.match(sleutel); if (c) return c; } catch { /* zonder cache */ }
    }
    const lat0 = v.a * VAK_LAT, lon0 = v.b * VAK_LON;
    const { results } = await env.DB.prepare("SELECT * FROM meldingen WHERE verloopt > ? AND lat >= ? AND lat < ? AND lon >= ? AND lon < ? ORDER BY gemaakt DESC LIMIT 300")
      .bind(t, lat0, lat0 + VAK_LAT, lon0, lon0 + VAK_LON).all();
    const body = JSON.stringify({ nu: t, vak, meldingen: results.map(vorm) });
    geheugen.set(vak, { t, body });
    if (geheugen.size > 500) geheugen.clear();
    const r = new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${REGELS.cacheS}` } });
    if (cache && !opties.zonderCache) { try { const p = cache.put(sleutel, r.clone()); if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {})); else await p; } catch { /* zonder cache */ } }
    return r;
  }

  async function leesBody(req) {
    const tekst = await req.text();
    if (tekst.length > 2000) return null;
    try { const j = JSON.parse(tekst); return j && typeof j === "object" ? j : null; } catch { return null; }
  }

  async function meld(req, env) {
    const b = await leesBody(req);
    if (!b || typeof b.toestel !== "string" || !TOESTEL.test(b.toestel)) return fout(400, "toestel");
    const lat = Number(b.lat), lon = Number(b.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fout(400, "positie");
    if (b.nauwkeurig != null && !(Number(b.nauwkeurig) <= 100)) return fout(422, "onnauwkeurig");
    let koers = b.koers == null ? null : Number(b.koers);
    if (koers != null && !(koers >= 0 && koers < 360.5)) return fout(400, "koers");
    if (koers != null) koers = Math.round(koers) % 360;
    if (!inLandAan(lat, lon)) return fout(403, "buiten");
    const db = env.DB, t = nu();
    const id = await keurToestel(db, b.toestel, t);
    if (!id) return fout(400, "toestel");
    const w = { ...(await wie(req, db, b.toestel, t)), vers: id.vers };
    // Limieten: per toestel geen reeks en een maximum per dag; per vingerafdruk ruimer; per IP-hash
    // en per net los van toestel-id en browser (die kiest de client zelf).
    const laatste = await db.prepare("SELECT MAX(t) AS t FROM acties WHERE soort = 'meld' AND toestel = ?").bind(w.toestel).first();
    if (laatste && laatste.t && t - laatste.t < REGELS.tussenMin * 60e3) return fout(429, "te_snel", { "Retry-After": String(Math.ceil((REGELS.tussenMin * 60e3 - (t - laatste.t)) / 1000)) });
    const uur = t - 3600e3, dag = t - 24 * 3600e3;
    const nee = await boek(db, "meld", w, t, [
      ["toestel", w.toestel, t - REGELS.tussenMin * 60e3, 1, "te_snel"],
      ["toestel", w.toestel, dag, id.vers ? REGELS.versPerDag : REGELS.perToestelDag, "dag_vol"],
      ["vinger", w.vinger, t - 10 * 60e3, REGELS.perVingerTienMin, "te_snel"],
      ["vinger", w.vinger, dag, REGELS.perVingerDag, "dag_vol"],
      ["ip", w.ip, uur, REGELS.perIpUur, "te_snel"],
      ["ip", w.ip, dag, REGELS.perIpDag, "dag_vol"],
      ["net", w.net, uur, REGELS.perNetUur, "te_snel"],
      ["net", w.net, dag, REGELS.perNetDag, "dag_vol"],
    ]);
    if (nee) return fout(429, nee);
    await opruimen(db, t);
    vergeetVak(lat, lon);
    // Staat er al een vlakbij in dezelfde richting? Dan telt dit als een ja.
    const dLat = REGELS.samenM / 111000, dLon = REGELS.samenM / (111000 * Math.cos(lat * rad));
    const { results: buren } = await db.prepare("SELECT * FROM meldingen WHERE verloopt > ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?").bind(t, lat - dLat, lat + dLat, lon - dLon, lon + dLon).all();
    const zelfde = buren.filter((r) => afstand(lat, lon, r.lat, r.lon) <= REGELS.samenM && (r.koers == null || koers == null || verschil(r.koers, koers) < 60))
      .sort((a, c) => afstand(lat, lon, a.lat, a.lon) - afstand(lat, lon, c.lat, c.lon))[0];
    if (zelfde) {
      const r = await stemOp(db, zelfde, w, true, t);
      return antwoord(200, { samengevoegd: true, melding: vorm(r) });
    }
    const verloopt = t + REGELS.basisMin * 60e3;
    // M2: op 4 decimalen (ca. 11 m), zoals PROTOCOL.md voorschrijft; meer is niet nodig voor een melding.
    const rij = await db.prepare("INSERT INTO meldingen (lat, lon, koers, gemaakt, verloopt, ja, nee, laatste_ja, melder) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?) RETURNING *")
      .bind(Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, koers, t, verloopt, w.toestel).first();
    return antwoord(201, { melding: vorm(rij) });
  }

  /** Mag de melder nu op zijn eigen melding stemmen? vorige: tijd van zijn vorige stem of null. */
  function eigenMag(rij, vorige, t) {
    return t - rij.gemaakt >= REGELS.eigenNaMin * 60e3 && !(vorige != null && t - vorige < REGELS.eigenTussenMin * 60e3);
  }

  /** Een stem verwerken; geeft de bijgewerkte rij. Eén stem per toestel per melding, behalve de
   *  melder: die stemt na eigenNaMin, en daarna eens per eigenTussenMin (zelfde rij in stemmen). */
  async function stemOp(db, rij, w, ja, t) {
    const toestelHash = w.toestel;
    const eigen = rij.melder === toestelHash;
    if (eigen && t - rij.gemaakt < REGELS.eigenNaMin * 60e3) return rij;
    const gedaan = eigen
      ? await db.prepare("INSERT INTO stemmen (melding, toestel, ja, t, ip, vers) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (melding, toestel) DO UPDATE SET ja = excluded.ja, t = excluded.t, ip = excluded.ip WHERE stemmen.t <= ? RETURNING melding")
        .bind(rij.id, toestelHash, ja ? 1 : 0, t, w.ip || null, w.vers ? 1 : 0, t - REGELS.eigenTussenMin * 60e3).first()
      : await db.prepare("INSERT OR IGNORE INTO stemmen (melding, toestel, ja, t, ip, vers) VALUES (?, ?, ?, ?, ?, ?) RETURNING melding").bind(rij.id, toestelHash, ja ? 1 : 0, t, w.ip || null, w.vers ? 1 : 0).first();
    if (!gedaan) return rij;
    let { ja: nJa, nee: nNee, verloopt } = rij;
    const max = rij.gemaakt + REGELS.maxUur * 3600e3;
    if (ja) { nJa++; verloopt = Math.min(max, Math.max(verloopt, t + REGELS.jaMin * 60e3)); }
    else {
      nNee++;
      // Meteen weg alleen door nee van verschillende IP-hashes (H2): tien toestel-ids achter één IP
      // tellen als één. Stemmen van een toestel-id van vandaag tellen hier niet mee, en alleen nee
      // van dezelfde UTC-dag: na middernacht heeft hetzelfde IP met het nieuwe dagzout een andere
      // hash, en zou het anders twee keer tellen.
      const dagBegin = dagNr(t) * 86400e3;
      const andereIps = eigen ? 0 : Number((await db.prepare("SELECT COUNT(DISTINCT ip) AS n FROM stemmen WHERE melding = ? AND ja = 0 AND vers = 0 AND ip IS NOT NULL AND toestel <> ? AND t >= ?").bind(rij.id, rij.melder, dagBegin).first()).n);
      if (eigen || (andereIps >= REGELS.neeWeg && nNee > nJa)) verloopt = t; // de melder weet het het best
      else verloopt = Math.min(verloopt, t + (nNee > nJa ? REGELS.neeMin : REGELS.jaMin) * 60e3);
    }
    return db.prepare("UPDATE meldingen SET ja = ?, nee = ?, verloopt = ?, laatste_ja = CASE WHEN ? = 1 THEN ? ELSE laatste_ja END WHERE id = ? RETURNING *")
      .bind(nJa, nNee, verloopt, ja ? 1 : 0, t, rij.id).first();
  }

  async function stem(req, env, id) {
    const b = await leesBody(req);
    if (!b || typeof b.toestel !== "string" || !TOESTEL.test(b.toestel) || typeof b.ja !== "boolean") return fout(400, "stem");
    const db = env.DB, t = nu();
    const tid = await keurToestel(db, b.toestel, t);
    if (!tid) return fout(400, "toestel");
    const rij = await db.prepare("SELECT * FROM meldingen WHERE id = ? AND verloopt > ?").bind(id, t).first();
    if (!rij) return fout(404, "weg");
    const w = { ...(await wie(req, db, b.toestel, t)), vers: tid.vers };
    const eigen = rij.melder === w.toestel;
    if (eigen && t - rij.gemaakt < REGELS.eigenNaMin * 60e3) return fout(409, "eigen", { "Retry-After": String(Math.ceil((rij.gemaakt + REGELS.eigenNaMin * 60e3 - t) / 1000)) });
    const al = await db.prepare("SELECT t FROM stemmen WHERE melding = ? AND toestel = ?").bind(id, w.toestel).first();
    if (al && (!eigen || !eigenMag(rij, al.t, t))) return antwoord(200, { al: true, melding: vorm(rij) });
    // H2: per toestel per dag, en per IP-hash en per net per uur, los van toestel-id en browser.
    const nee = await boek(db, "stem", w, t, [
      ["toestel", w.toestel, t - 24 * 3600e3, REGELS.stemmenPerToestelDag, "dag_vol"],
      ["ip", w.ip, t - 3600e3, REGELS.stemmenPerIpUur, "te_snel"],
      ["net", w.net, t - 3600e3, REGELS.stemmenPerNetUur, "te_snel"],
    ]);
    if (nee) return fout(429, nee);
    const nieuw = await stemOp(db, rij, w, b.ja, t);
    vergeetVak(rij.lat, rij.lon);
    return antwoord(200, { melding: { ...vorm(nieuw), weg: nieuw.verloopt <= t } });
  }

  // ---------- De feed voor andere apps (PROTOCOL.md) ----------
  const r4 = (x) => Math.round(x * 1e4) / 1e4; // ca. 11 m: genoeg voor een waarschuwing, niet meer
  let sleutelCache = null;
  async function teken(env, bytes) {
    if (!env.FEED_SLEUTEL) return null;
    if (!sleutelCache) {
      const ruw = Uint8Array.from(atob(env.FEED_SLEUTEL.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      sleutelCache = await crypto.subtle.importKey("pkcs8", ruw, { name: "Ed25519" }, false, ["sign"]);
    }
    const h = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, sleutelCache, bytes));
    return btoa(String.fromCharCode(...h)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function feed(req, env) {
    const url = new URL(req.url);
    const v = leesVak(url.searchParams.get("vak"));
    if (!v) return fout(400, "vak");
    const vak = v.vak, t = nu();
    const lat0 = v.a * VAK_LAT, lon0 = v.b * VAK_LON;
    const { results } = await env.DB.prepare("SELECT * FROM meldingen WHERE verloopt > ? AND lat >= ? AND lat < ? AND lon >= ? AND lon < ? ORDER BY gemaakt DESC LIMIT 300")
      .bind(t, lat0, lat0 + VAK_LAT, lon0, lon0 + VAK_LON).all();
    const body = JSON.stringify({
      protocol: "0.1",
      app: env.APP_ID || "onbekend",
      vak,
      nu: t,
      meldingen: results.map((r) => ({ id: String(r.id), soort: "mobiele_flitser", lat: r4(r.lat), lon: r4(r.lon), koers: r.koers, gemaakt: r.gemaakt, verloopt: r.verloopt, ja: r.ja, nee: r.nee, laatste_ja: r.laatste_ja })),
      stemmen: [],
    });
    const bytes = new TextEncoder().encode(body);
    const kop = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${REGELS.cacheS}`, "Access-Control-Allow-Origin": "*" };
    const h = await teken(env, bytes);
    if (h) kop["Rijhulp-Handtekening"] = "ed25519=" + h;
    return new Response(bytes, { headers: kop });
  }

  // ---------- Matrixborden ----------
  async function msiFeed(url, ctx) {
    const t = nu();
    if (msi.data && t - msi.data.t < MSI_REGELS.verversS * 1000) return msi.data;
    if (msi.bezig) return msi.bezig;
    msi.bezig = (async () => {
      // Eerst de Cache API: zo haalt niet elke isolate in dit datacenter zelf de feed.
      let cache = null;
      const sleutel = new Request(url.origin + "/api/msi/__feed");
      try { cache = !opties.zonderCache && typeof caches !== "undefined" ? caches.default : null; } catch { cache = null; }
      if (cache) {
        try {
          const c = await cache.match(sleutel);
          if (c) { const j = await c.json(); if (j && t - j.t < MSI_REGELS.verversS * 1000) { msi.data = j; return j; } }
        } catch { /* zonder cache */ }
      }
      try {
        const j = await haalMsiFeed(doeFetch, msi.data, t);
        msi.data = j; msi.fout = 0;
        if (cache) {
          const p = cache.put(sleutel, new Response(JSON.stringify(j), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${MSI_REGELS.verversS}` } }));
          if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {})); else await p.catch(() => {});
        }
        return j;
      } catch (e) {
        msi.fout++;
        console.error("msi", e && e.message);
        // Even geen feed: de vorige nog tot hij te oud is; daarna een fout (de app valt terug op de vaste limiet).
        if (msi.data && t - msi.data.bron < MSI_REGELS.oudS * 1000) { msi.data = { ...msi.data, t: t - (MSI_REGELS.verversS - 15) * 1000 }; return msi.data; }
        throw e;
      }
    })().finally(() => { msi.bezig = null; });
    return msi.bezig;
  }

  async function msiVak(req, ctx) {
    const url = new URL(req.url);
    const v = leesVak(url.searchParams.get("vak"));
    if (!v) return fout(400, "vak");
    const vak = v.vak;
    if (!msiVakken) return fout(503, "msi");
    const t = nu();
    // Alleen vakken met borden komen in msiIds (M1: anders groeit de Map met elke verzonnen vakstring).
    if (!msiIds.has(vak) && Object.prototype.hasOwnProperty.call(msiVakken.vakken, vak)) msiIds.set(vak, msiVakken.vakken[vak].split(","));
    const ids = msiIds.get(vak) || [];
    if (!ids.length) return antwoord(200, { nu: t, vak, bron: null, borden: {} }, { "Cache-Control": "public, max-age=3600" });
    let feed;
    try { feed = await msiFeed(url, ctx); } catch { return fout(503, "msi", { "Retry-After": "30" }); }
    if (t - feed.bron > MSI_REGELS.oudS * 1000) return fout(503, "msi_oud", { "Retry-After": "30" });
    const extra = opties.msiNep ? opties.msiNep() : null; // alleen lokaal (scripts/lokaal.mjs)
    const borden = {};
    for (const id of ids) {
      const c = extra && id in extra ? extra[id] : feed.borden[id];
      if (c) borden[id] = c;
    }
    return new Response(JSON.stringify({ nu: t, vak, bron: feed.bron, borden }), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${MSI_REGELS.cacheS}` } });
  }

  return {
    /** Geplande run (OPRUIMEN_CRON): ruimt op ook als er geen nieuwe meldingen komen. */
    async scheduled(event, env) {
      if (!env || !env.DB) return;
      await opruimen(env.DB, nu());
    },
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      const p = url.pathname.replace(/\/+$/, "");
      try {
        if ((p.startsWith("/api/") || p === "/feed") && teVeel(req)) return fout(429, "te_veel", { "Retry-After": "60" });
        if (req.method !== "GET" && req.method !== "HEAD") {
          const nee = poortSchrijven(req, url, opties.herkomsten || (env && env.HERKOMST ? String(env.HERKOMST).split(",").map((x) => x.trim()) : EIGEN_HERKOMST));
          if (nee) return nee;
        }
        if (p === "/api/msi" && req.method === "GET") return await msiVak(req, ctx);
        if (!env.DB) return fout(503, "geen_database");
        if (p === "/api/meldingen" && req.method === "GET") return await lijst(req, env, ctx);
        if (p === "/api/meldingen" && req.method === "POST") return await meld(req, env);
        if (p === "/api/toestel" && req.method === "POST") return await geefToestel(req, env);
        const s = /^\/api\/meldingen\/(\d{1,12})\/stem$/.exec(p);
        if (s && req.method === "POST") return await stem(req, env, Number(s[1]));
        if ((p === "/feed" || p === "/api/feed") && req.method === "GET") return await feed(req, env);
        if (p === "/api/gezond") return antwoord(200, { ok: true });
        return fout(404, "niet_gevonden");
      } catch (e) {
        console.error("rijhulp", e && e.message);
        return fout(500, "fout");
      }
    },
  };
}

// In de bundel staan hierboven const GRENZEN (de inhoud van landen uit site/data/grenzen.json) en
// const MSI_VAKKEN (server/msi-vakken.json, alleen voor de matrixborden in NL).
const server = maakServer({ grenzen: typeof GRENZEN !== "undefined" ? GRENZEN : null, msiVakken: typeof MSI_VAKKEN !== "undefined" ? MSI_VAKKEN : null }); // eslint-disable-line no-undef
export default { fetch: (req, env, ctx) => server.fetch(req, env, ctx), scheduled: (event, env, ctx) => server.scheduled(event, env, ctx) };
