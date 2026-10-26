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
// GET  /feed?vak=<lat>_<lon>                de feed voor andere apps volgens PROTOCOL.md (versie 0.1),
//                                           ondertekend met Ed25519 als env.FEED_SLEUTEL er is; ook als
//                                           /api/feed, voor hosts die alleen /api naar de server sturen
//
// Omgeving: env.DB (database), env.APP_ID (je id uit deelnemers.json), env.FEED_SLEUTEL (de
// geheime sleutel als PKCS8 in base64url, uit scripts/maak-sleutel.mjs; zet hem als geheim bij je
// host, nooit in de repo). De grenzen van de landen die aan staan (site/data/grenzen.json) zet je
// bij het bundelen als const GRENZEN boven deze code, of je geeft ze mee aan maakServer.

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
  eigenNaMin: 20, // de melder stemt pas op zijn eigen melding als die minstens zo oud is
  eigenTussenMin: 20, // en daarna hooguit eens per zoveel minuten (een ja telt als elke ja, een nee haalt hem weg)
  cacheS: 15,
};

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
  const kop = { "User-Agent": "blitzla/1.0 (blitzla.hypamoon.app)" };
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
  const msiIds = new Map(); // vak -> [id, ...], pas bij de eerste vraag naar dat vak
  const msi = { data: null, bezig: null, fout: 0 };
  const doeFetch = opties.fetch || ((u, i) => fetch(u, i));
  const geheugen = new Map(); // vak -> { t, body }: in deze isolate, naast de Cache API

  // Alleen melden binnen de landen die in landen.json aan staan: grenzen bevat precies die landen.
  function inLandAan(lat, lon) {
    if (!grenzen) return false;
    for (const cc of Object.keys(grenzen)) if (binnen(lat, lon, grenzen[cc])) return cc;
    return false;
  }

  async function zout(db, t) {
    const dag = new Date(t).toISOString().slice(0, 10);
    await db.prepare("INSERT OR IGNORE INTO zout (dag, waarde) VALUES (?, ?)").bind(dag, willekeurig()).run();
    const rij = await db.prepare("SELECT waarde FROM zout WHERE dag = ?").bind(dag).first();
    return rij.waarde;
  }
  async function wie(req, db, toestel, t) {
    const z = await zout(db, t);
    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
    const ua = (req.headers.get("user-agent") || "").slice(0, 200);
    // Het IP gaat alleen door de hash en wordt nergens bewaard.
    return { toestel: await sha(z + "|t|" + toestel), vinger: await sha(z + "|v|" + ip + "|" + ua) };
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
  function vorm(r) {
    return { id: r.id, lat: r.lat, lon: r.lon, koers: r.koers, gemaakt: r.gemaakt, verloopt: r.verloopt, ja: r.ja, nee: r.nee, laatste_ja: r.laatste_ja };
  }
  function vergeetVak(lat, lon) { geheugen.delete(vakVan(lat, lon)); }

  async function lijst(req, env, ctx) {
    const url = new URL(req.url);
    const vak = url.searchParams.get("vak") || "";
    const m = /^(-?\d{1,4})_(-?\d{1,4})$/.exec(vak);
    if (!m) return fout(400, "vak");
    const t = nu();
    const kort = geheugen.get(vak);
    if (kort && !opties.zonderCache && t - kort.t < REGELS.cacheS * 1000) return new Response(kort.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${REGELS.cacheS}` } });
    let cache = null;
    const sleutel = new Request(url.origin + "/api/meldingen?vak=" + vak);
    try { cache = typeof caches !== "undefined" ? caches.default : null; } catch { cache = null; }
    if (cache && !opties.zonderCache) {
      try { const c = await cache.match(sleutel); if (c) return c; } catch { /* zonder cache */ }
    }
    const lat0 = +m[1] * VAK_LAT, lon0 = +m[2] * VAK_LON;
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
    const w = await wie(req, db, b.toestel, t);
    // Limieten: per toestel geen reeks en een maximum per dag; per vingerafdruk ruimer.
    const tel = async (kolom, waarde, sinds) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM acties WHERE soort = 'meld' AND ${kolom} = ? AND t > ?`).bind(waarde, sinds).first()).n);
    const laatste = await db.prepare("SELECT MAX(t) AS t FROM acties WHERE soort = 'meld' AND toestel = ?").bind(w.toestel).first();
    if (laatste && laatste.t && t - laatste.t < REGELS.tussenMin * 60e3) return fout(429, "te_snel", { "Retry-After": String(Math.ceil((REGELS.tussenMin * 60e3 - (t - laatste.t)) / 1000)) });
    if ((await tel("toestel", w.toestel, t - 24 * 3600e3)) >= REGELS.perToestelDag) return fout(429, "dag_vol");
    if ((await tel("vinger", w.vinger, t - 10 * 60e3)) >= REGELS.perVingerTienMin) return fout(429, "te_snel");
    if ((await tel("vinger", w.vinger, t - 24 * 3600e3)) >= REGELS.perVingerDag) return fout(429, "dag_vol");
    await opruimen(db, t);
    await db.prepare("INSERT INTO acties (soort, toestel, vinger, t) VALUES ('meld', ?, ?, ?)").bind(w.toestel, w.vinger, t).run();
    vergeetVak(lat, lon);
    // Staat er al een vlakbij in dezelfde richting? Dan telt dit als een ja.
    const dLat = REGELS.samenM / 111000, dLon = REGELS.samenM / (111000 * Math.cos(lat * rad));
    const { results: buren } = await db.prepare("SELECT * FROM meldingen WHERE verloopt > ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?").bind(t, lat - dLat, lat + dLat, lon - dLon, lon + dLon).all();
    const zelfde = buren.filter((r) => afstand(lat, lon, r.lat, r.lon) <= REGELS.samenM && (r.koers == null || koers == null || verschil(r.koers, koers) < 60))
      .sort((a, c) => afstand(lat, lon, a.lat, a.lon) - afstand(lat, lon, c.lat, c.lon))[0];
    if (zelfde) {
      const r = await stemOp(db, zelfde, w.toestel, true, t);
      return antwoord(200, { samengevoegd: true, melding: vorm(r) });
    }
    const verloopt = t + REGELS.basisMin * 60e3;
    const rij = await db.prepare("INSERT INTO meldingen (lat, lon, koers, gemaakt, verloopt, ja, nee, laatste_ja, melder) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?) RETURNING *")
      .bind(Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, koers, t, verloopt, w.toestel).first();
    return antwoord(201, { melding: vorm(rij) });
  }

  /** Mag de melder nu op zijn eigen melding stemmen? vorige: tijd van zijn vorige stem of null. */
  function eigenMag(rij, vorige, t) {
    return t - rij.gemaakt >= REGELS.eigenNaMin * 60e3 && !(vorige != null && t - vorige < REGELS.eigenTussenMin * 60e3);
  }

  /** Een stem verwerken; geeft de bijgewerkte rij. Eén stem per toestel per melding, behalve de
   *  melder: die stemt na eigenNaMin, en daarna eens per eigenTussenMin (zelfde rij in stemmen). */
  async function stemOp(db, rij, toestelHash, ja, t) {
    const eigen = rij.melder === toestelHash;
    if (eigen && t - rij.gemaakt < REGELS.eigenNaMin * 60e3) return rij;
    const gedaan = eigen
      ? await db.prepare("INSERT INTO stemmen (melding, toestel, ja, t) VALUES (?, ?, ?, ?) ON CONFLICT (melding, toestel) DO UPDATE SET ja = excluded.ja, t = excluded.t WHERE stemmen.t <= ? RETURNING melding")
        .bind(rij.id, toestelHash, ja ? 1 : 0, t, t - REGELS.eigenTussenMin * 60e3).first()
      : await db.prepare("INSERT OR IGNORE INTO stemmen (melding, toestel, ja, t) VALUES (?, ?, ?, ?) RETURNING melding").bind(rij.id, toestelHash, ja ? 1 : 0, t).first();
    if (!gedaan) return rij;
    let { ja: nJa, nee: nNee, verloopt } = rij;
    const max = rij.gemaakt + REGELS.maxUur * 3600e3;
    if (ja) { nJa++; verloopt = Math.min(max, Math.max(verloopt, t + REGELS.jaMin * 60e3)); }
    else {
      nNee++;
      if (eigen || (nNee >= REGELS.neeWeg && nNee > nJa)) verloopt = t; // de melder weet het het best
      else verloopt = Math.min(verloopt, t + (nNee > nJa ? REGELS.neeMin : REGELS.jaMin) * 60e3);
    }
    return db.prepare("UPDATE meldingen SET ja = ?, nee = ?, verloopt = ?, laatste_ja = CASE WHEN ? = 1 THEN ? ELSE laatste_ja END WHERE id = ? RETURNING *")
      .bind(nJa, nNee, verloopt, ja ? 1 : 0, t, rij.id).first();
  }

  async function stem(req, env, id) {
    const b = await leesBody(req);
    if (!b || typeof b.toestel !== "string" || !TOESTEL.test(b.toestel) || typeof b.ja !== "boolean") return fout(400, "stem");
    const db = env.DB, t = nu();
    const rij = await db.prepare("SELECT * FROM meldingen WHERE id = ? AND verloopt > ?").bind(id, t).first();
    if (!rij) return fout(404, "weg");
    const w = await wie(req, db, b.toestel, t);
    const eigen = rij.melder === w.toestel;
    if (eigen && t - rij.gemaakt < REGELS.eigenNaMin * 60e3) return fout(409, "eigen", { "Retry-After": String(Math.ceil((rij.gemaakt + REGELS.eigenNaMin * 60e3 - t) / 1000)) });
    const n = Number((await db.prepare("SELECT COUNT(*) AS n FROM acties WHERE soort = 'stem' AND toestel = ? AND t > ?").bind(w.toestel, t - 24 * 3600e3).first()).n);
    if (n >= REGELS.stemmenPerToestelDag) return fout(429, "dag_vol");
    const al = await db.prepare("SELECT t FROM stemmen WHERE melding = ? AND toestel = ?").bind(id, w.toestel).first();
    if (al && (!eigen || !eigenMag(rij, al.t, t))) return antwoord(200, { al: true, melding: vorm(rij) });
    await db.prepare("INSERT INTO acties (soort, toestel, vinger, t) VALUES ('stem', ?, ?, ?)").bind(w.toestel, w.vinger, t).run();
    const nieuw = await stemOp(db, rij, w.toestel, b.ja, t);
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
    const vak = url.searchParams.get("vak") || "";
    const m = /^(-?\d{1,4})_(-?\d{1,4})$/.exec(vak);
    if (!m) return fout(400, "vak");
    const t = nu();
    const lat0 = +m[1] * VAK_LAT, lon0 = +m[2] * VAK_LON;
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
    const vak = url.searchParams.get("vak") || "";
    if (!/^(-?\d{1,4})_(-?\d{1,4})$/.test(vak)) return fout(400, "vak");
    if (!msiVakken) return fout(503, "msi");
    if (!msiIds.has(vak)) msiIds.set(vak, msiVakken.vakken[vak] ? msiVakken.vakken[vak].split(",") : []);
    const ids = msiIds.get(vak);
    const t = nu();
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
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      const p = url.pathname.replace(/\/+$/, "");
      try {
        if (p === "/api/msi" && req.method === "GET") return await msiVak(req, ctx);
        if (!env.DB) return fout(503, "geen_database");
        if (p === "/api/meldingen" && req.method === "GET") return await lijst(req, env, ctx);
        if (p === "/api/meldingen" && req.method === "POST") return await meld(req, env);
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
export default { fetch: (req, env, ctx) => server.fetch(req, env, ctx) };
