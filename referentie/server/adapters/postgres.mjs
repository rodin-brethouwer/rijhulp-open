// Tussenstuk voor Postgres: levert de kleine database-interface die server.mjs verwacht als env.DB
// (db.prepare(sql).bind(...).first/all/run en db.batch), bovenop een Postgres-client die je zelf
// meebrengt. Voor platforms die Postgres geven: Supabase (ook achter Lovable en Bolt), Railway,
// Render, Neon of een eigen server.
//
// Twee soorten clients werken:
//   - node-postgres (`pg`): new pg.Pool({ connectionString }), met query(tekst, waarden);
//   - postgres.js (`postgres`, ook in Deno en Supabase Edge Functions als npm:postgres), met unsafe(tekst, waarden).
//
// De SQL van server.mjs is geschreven voor SQLite; dit tussenstuk vertaalt de twee verschillen
// die erin voorkomen: ? wordt $1, $2, ... en INSERT OR IGNORE wordt ON CONFLICT DO NOTHING.
// Getallen die Postgres als BIGINT of NUMERIC teruggeeft (tijden, id's, COUNT), komen terug als
// gewone getallen, zoals de server verwacht.
//
// De tabellen: postgres-schema.sql in deze map (eenmalig, of met migreer hieronder).
import fs from "node:fs";

const GETAL_OIDS = new Set([20, 21, 23, 700, 701, 1700]); // int8, int2, int4, float4, float8, numeric

/** Vertaalt een SQLite-zin van server.mjs naar Postgres. */
export function naarPostgres(q) {
  let n = 0, uit = "", inTekst = false;
  for (const c of q) {
    if (c === "'") inTekst = !inTekst;
    uit += c === "?" && !inTekst ? "$" + ++n : c;
  }
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(uit)) {
    uit = uit.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");
    uit = /\bRETURNING\b/i.test(uit) ? uit.replace(/\s+RETURNING\b/i, " ON CONFLICT DO NOTHING RETURNING") : uit + " ON CONFLICT DO NOTHING";
  }
  return uit;
}

function getallen(rijen, kolommen) {
  const welke = kolommen.filter((k) => GETAL_OIDS.has(k.oid)).map((k) => k.naam);
  if (!welke.length) return rijen;
  for (const r of rijen) for (const k of welke) if (r[k] != null && typeof r[k] !== "number") r[k] = Number(r[k]);
  return rijen;
}

function vraagFunctie(client) {
  if (client && typeof client.query === "function") {
    return async (tekst, waarden) => {
      const r = waarden ? await client.query(tekst, waarden) : await client.query(tekst);
      if (Array.isArray(r)) return { rijen: [], aantal: 0 }; // meerdere zinnen tegelijk (migreer)
      const kol = (r.fields || []).map((f) => ({ naam: f.name, oid: f.dataTypeID }));
      return { rijen: getallen(r.rows || [], kol), aantal: r.rowCount ?? 0 };
    };
  }
  if (client && typeof client.unsafe === "function") {
    return async (tekst, waarden) => {
      const r = waarden ? await client.unsafe(tekst, waarden) : await client.unsafe(tekst);
      if (!waarden) return { rijen: [], aantal: 0 }; // zonder waarden alleen voor migreer
      const kol = (r.columns || []).map((c) => ({ naam: c.name, oid: c.type }));
      return { rijen: getallen([...r], kol), aantal: r.count ?? r.length };
    };
  }
  throw new Error("postgresDb: geef een client met query() (pg) of unsafe() (postgres.js)");
}

/** De database-interface op een Postgres-client. */
export function postgresDb(client) {
  const vraag = vraagFunctie(client);
  function stmt(q, args = []) {
    const tekst = naarPostgres(q);
    return {
      bind: (...a) => stmt(q, a),
      all: async () => ({ results: (await vraag(tekst, args)).rijen }),
      first: async (kol) => {
        const r = (await vraag(tekst, args)).rijen[0] ?? null;
        return kol ? (r?.[kol] ?? null) : r;
      },
      run: async () => ({ success: true, meta: { changes: (await vraag(tekst, args)).aantal } }),
    };
  }
  return {
    prepare: (q) => stmt(q),
    // Na elkaar. De server gebruikt batch alleen om verlopen rijen op te ruimen; dat mag half lukken
    // en gaat bij de volgende vraag verder.
    async batch(lijst) {
      const uit = [];
      for (const s of lijst) uit.push(await s.run());
      return uit;
    },
    exec: async (q) => { await vraag(q); },
  };
}

/** Maakt de tabellen aan (idempotent). */
export async function migreer(db, bestand = new URL("./postgres-schema.sql", import.meta.url)) {
  await db.exec(fs.readFileSync(bestand, "utf8"));
}
