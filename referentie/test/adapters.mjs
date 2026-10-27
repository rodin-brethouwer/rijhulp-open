// De tussenstukken in server/adapters/: dezelfde kleine database-interface op node:sqlite en op
// Postgres. Postgres zelf draait hier niet (zie db.mjs om de hele servertest tegen Postgres te
// draaien); hier gaat het om de vertaling en om de vorm van wat terugkomt.
// node test/adapters.mjs
import assert from "node:assert/strict";
import { sqliteDb, migreer } from "../server/adapters/sqlite.mjs";
import { postgresDb, naarPostgres } from "../server/adapters/postgres.mjs";

// node:sqlite
const db = sqliteDb(":memory:");
assert.deepEqual(migreer(db), ["0001_meldingen.sql", "0002_ip_en_toestel.sql"]);
assert.deepEqual(migreer(db), ["0001_meldingen.sql", "0002_ip_en_toestel.sql"], "nog een keer migreren gaat goed (ADD COLUMN die er al is)");
assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('stemmen') WHERE name IN ('ip', 'vers')").get().n, 2);
const nieuw = await db.prepare("INSERT INTO meldingen (lat, lon, koers, gemaakt, verloopt, melder) VALUES (?, ?, ?, ?, ?, ?) RETURNING *").bind(52.1, 4.5, 10, 1, 2, "x").first();
assert.equal(nieuw.id, 1);
assert.equal(await db.prepare("SELECT koers FROM meldingen WHERE id = ?").bind(1).first("koers"), 10);
assert.equal(await db.prepare("SELECT koers FROM meldingen WHERE id = ?").bind(99).first("koers"), null);
assert.equal((await db.prepare("SELECT * FROM meldingen").all()).results.length, 1);
assert.equal((await db.prepare("INSERT OR IGNORE INTO zout (dag, waarde) VALUES (?, ?)").bind("2026-10-25", "a").run()).meta.changes, 1);
assert.equal((await db.prepare("INSERT OR IGNORE INTO zout (dag, waarde) VALUES (?, ?)").bind("2026-10-25", "b").run()).meta.changes, 0);
await assert.rejects(db.batch([
  db.prepare("DELETE FROM zout WHERE dag = ?").bind("2026-10-25"),
  db.prepare("INSERT INTO geen_tabel VALUES (1)"),
]));
assert.equal(await db.prepare("SELECT waarde FROM zout").first("waarde"), "a", "een mislukte batch draait alles terug");
console.log("ok  sqlite: first, all, run en batch als geheel");

// Postgres: de vertaling van de SQL uit server.mjs
assert.equal(naarPostgres("SELECT * FROM meldingen WHERE id = ? AND verloopt > ?"), "SELECT * FROM meldingen WHERE id = $1 AND verloopt > $2");
assert.equal(naarPostgres("INSERT OR IGNORE INTO zout (dag, waarde) VALUES (?, ?)"), "INSERT INTO zout (dag, waarde) VALUES ($1, $2) ON CONFLICT DO NOTHING");
assert.equal(naarPostgres("INSERT OR IGNORE INTO stemmen (melding, toestel, ja, t) VALUES (?, ?, ?, ?) RETURNING melding"), "INSERT INTO stemmen (melding, toestel, ja, t) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING melding");
assert.equal(naarPostgres("SELECT COUNT(*) AS n FROM acties WHERE soort = 'wat?' AND t > ?"), "SELECT COUNT(*) AS n FROM acties WHERE soort = 'wat?' AND t > $1");
assert.equal(naarPostgres("INSERT INTO acties (soort, toestel, vinger, t) VALUES ('meld', ?, ?, ?)"), "INSERT INTO acties (soort, toestel, vinger, t) VALUES ('meld', $1, $2, $3)");
console.log("ok  postgres: ? wordt $n, INSERT OR IGNORE wordt ON CONFLICT DO NOTHING");

// Postgres met een client zoals node-postgres: BIGINT en COUNT komen als tekst, de server krijgt getallen.
const gezien = [];
const pgClient = {
  async query(tekst, waarden) {
    gezien.push([tekst, waarden]);
    return { rows: [{ id: "7", n: "3", lat: 52.1, dag: "2026-10-25", leeg: null }], rowCount: 1, fields: [{ name: "id", dataTypeID: 20 }, { name: "n", dataTypeID: 20 }, { name: "lat", dataTypeID: 701 }, { name: "dag", dataTypeID: 25 }, { name: "leeg", dataTypeID: 20 }] };
  },
};
const pdb = postgresDb(pgClient);
const rij = await pdb.prepare("SELECT * FROM x WHERE a = ? AND b = ?").bind(1, "twee").first();
assert.deepEqual(gezien[0], ["SELECT * FROM x WHERE a = $1 AND b = $2", [1, "twee"]]);
assert.deepEqual(rij, { id: 7, n: 3, lat: 52.1, dag: "2026-10-25", leeg: null });
assert.equal(await pdb.prepare("SELECT n FROM x").first("n"), 3);
assert.equal((await pdb.prepare("DELETE FROM x").run()).meta.changes, 1);
assert.equal((await pdb.batch([pdb.prepare("DELETE FROM x WHERE a = ?").bind(1), pdb.prepare("DELETE FROM y")])).length, 2);
console.log("ok  postgres (pg): getallen als getal, first, run en batch");

// Postgres met een client zoals postgres.js (unsafe).
const pjs = postgresDb({
  async unsafe(tekst, waarden) {
    const r = [{ t: "1793000000000", koers: 10 }];
    r.count = 1;
    r.columns = [{ name: "t", type: 20 }, { name: "koers", type: 23 }];
    return r;
  },
});
assert.deepEqual((await pjs.prepare("SELECT t, koers FROM x").all()).results, [{ t: 1793000000000, koers: 10 }]);
console.log("ok  postgres (postgres.js): zelfde vorm");
assert.throws(() => postgresDb({}), /query\(\)/);
console.log("alles goed");
