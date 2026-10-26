// Tussenstuk voor Node met node:sqlite (Node 22.5 of nieuwer, zonder pakketten): levert de kleine
// database-interface die server.mjs verwacht als env.DB:
//
//   db.prepare(sql).bind(...waarden).first(kolom?) / .all() / .run()
//   db.batch([stmt, ...])
//
// Voor een eigen VPS of server met Node, Replit, Railway of Render met een schijf.
// Gebruik: const DB = sqliteDb("rijhulp.db"); migreer(DB); daarna env = { DB }.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Een database op een bestand (of ":memory:"), of op een bestaande DatabaseSync. */
export function sqliteDb(bestand = ":memory:") {
  const sql = typeof bestand === "string" ? new DatabaseSync(bestand) : bestand;
  if (typeof bestand === "string" && bestand !== ":memory:") {
    sql.exec("PRAGMA journal_mode = WAL");
    sql.exec("PRAGMA busy_timeout = 5000");
  }
  function stmt(q, args = []) {
    return {
      bind: (...a) => stmt(q, a),
      all: async () => ({ results: sql.prepare(q).all(...args) }),
      first: async (kol) => {
        const r = sql.prepare(q).get(...args) ?? null;
        return kol ? (r?.[kol] ?? null) : r;
      },
      run: async () => {
        const r = sql.prepare(q).run(...args);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
  }
  return {
    prepare: (q) => stmt(q),
    // Alles of niets, net als een batch hoort te zijn.
    async batch(lijst) {
      sql.exec("BEGIN");
      try {
        const uit = [];
        for (const s of lijst) uit.push(await s.run());
        sql.exec("COMMIT");
        return uit;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (q) => { sql.exec(q); },
    sql,
  };
}

/** Draait de migraties uit server/migraties/ in volgorde (ze zijn idempotent: IF NOT EXISTS). */
export function migreer(db, map = new URL("../migraties/", import.meta.url)) {
  const namen = fs.readdirSync(map).filter((n) => n.endsWith(".sql")).sort();
  for (const n of namen) db.sql.exec(fs.readFileSync(new URL(n, map), "utf8"));
  return namen;
}
