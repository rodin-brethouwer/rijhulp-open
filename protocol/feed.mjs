// Hulpmiddelen voor het protocol (PROTOCOL.md, versie 0.1): een feed ophalen, de handtekening
// controleren tegen de publieke sleutel uit deelnemers.json, en de inhoud keuren.
// Alleen WebCrypto: werkt in Node 20+, Deno, Bun en elke runtime met een fetch-handler.

export const VAK_LAT = 0.2, VAK_LON = 0.3;
export const vakVan = (lat, lon) => Math.floor(lat / VAK_LAT) + "_" + Math.floor(lon / VAK_LON);
export const SOORTEN = ["mobiele_flitser"];
export const MAX_BYTES = 256 * 1024;
export const MAX_MELDINGEN = 300;

export const naarB64url = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const vanB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Controleert een Ed25519-handtekening (kop "Rijhulp-Handtekening: ed25519=<b64url>") over de ruwe bytes. */
export async function klopt(bytes, kop, publiekeSleutel) {
  const m = /^ed25519=([A-Za-z0-9_-]{80,90})$/.exec(String(kop || "").trim());
  if (!m || !publiekeSleutel) return false;
  try {
    const sleutel = await crypto.subtle.importKey("raw", vanB64url(publiekeSleutel), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, sleutel, vanB64url(m[1]), bytes);
  } catch { return false; }
}

/** Keurt de inhoud van een feed. Geeft { ok, fouten, meldingen } met alleen de bruikbare meldingen. */
export function keur(feed, { app, vak, nu = Date.now(), landAan } = {}) {
  const fouten = [];
  if (!feed || typeof feed !== "object") return { ok: false, fouten: ["geen object"], meldingen: [] };
  if (typeof feed.protocol !== "string" || !feed.protocol.startsWith("0.")) fouten.push("protocol");
  if (app && feed.app !== app) fouten.push("app");
  if (vak && feed.vak !== vak) fouten.push("vak");
  if (!Number.isFinite(feed.nu) || Math.abs(nu - feed.nu) > 5 * 60e3) fouten.push("nu");
  if (!Array.isArray(feed.meldingen) || feed.meldingen.length > MAX_MELDINGEN) fouten.push("meldingen");
  if (fouten.length) return { ok: false, fouten, meldingen: [] };
  const goed = [];
  for (const m of feed.meldingen) {
    if (!m || typeof m.id !== "string" || m.id.length > 64) continue;
    if (!SOORTEN.includes(m.soort)) continue; // onbekende soort: overslaan, niet weigeren
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon) || Math.abs(m.lat) > 90 || Math.abs(m.lon) > 180) continue;
    if (vakVan(m.lat, m.lon) !== feed.vak) continue;
    if (m.koers != null && !(Number.isInteger(m.koers) && m.koers >= 0 && m.koers < 360)) continue;
    if (!Number.isFinite(m.gemaakt) || !Number.isFinite(m.verloopt) || m.verloopt <= nu || m.gemaakt > nu + 60e3) continue;
    if (m.verloopt - m.gemaakt > 8 * 3600e3) continue;
    if (!Number.isInteger(m.ja) || !Number.isInteger(m.nee) || m.ja < 0 || m.nee < 0) continue;
    if (landAan && !landAan(m.lat, m.lon)) continue; // de landregels gelden ook voor andermans meldingen
    goed.push({ ...m, app: feed.app, sleutel: feed.app + ":" + m.id });
  }
  return { ok: true, fouten, meldingen: goed };
}

/** Haalt één feed op en controleert hem. deelnemer: een regel uit deelnemers.json. */
export async function haal(deelnemer, vak, opties = {}) {
  const url = new URL(deelnemer.feed);
  url.searchParams.set("vak", vak);
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": opties.userAgent || "rijhulp-open/0.1" }, signal: opties.signal });
  if (!r.ok) return { ok: false, fouten: ["http " + r.status], meldingen: [] };
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > MAX_BYTES) return { ok: false, fouten: ["te groot"], meldingen: [] };
  if (!(await klopt(bytes, r.headers.get("Rijhulp-Handtekening"), deelnemer.publieke_sleutel))) return { ok: false, fouten: ["handtekening"], meldingen: [] };
  let j; try { j = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { ok: false, fouten: ["json"], meldingen: [] }; }
  return keur(j, { app: deelnemer.id, vak, nu: opties.nu, landAan: opties.landAan });
}
