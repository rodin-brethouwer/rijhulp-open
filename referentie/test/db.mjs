// De database voor de tests: standaard node:sqlite in het geheugen (via adapters/sqlite.mjs).
// Met RIJHULP_TEST_PG=<postgres-url> draaien dezelfde tests tegen Postgres (via
// adapters/postgres.mjs), in een eigen tijdelijk schema. Daarvoor moet het pakket pg te vinden
// zijn; RIJHULP_PG_MODULE mag naar een pad wijzen als het niet in node_modules staat.
import { sqliteDb, migreer as migreerSqlite } from "../server/adapters/sqlite.mjs";
import { postgresDb, migreer as migreerPostgres } from "../server/adapters/postgres.mjs";

export async function testDb() {
  const url = process.env.RIJHULP_TEST_PG;
  if (!url) {
    const DB = sqliteDb(":memory:");
    migreerSqlite(DB);
    return { DB, soort: "sqlite", sluit: async () => {} };
  }
  const mod = await import(process.env.RIJHULP_PG_MODULE || "pg");
  const pg = mod.default || mod;
  const schema = "rijhulp_proef_" + process.pid;
  const pool = new pg.Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA ${schema}`);
  const DB = postgresDb(pool);
  await migreerPostgres(DB);
  return {
    DB,
    soort: "postgres",
    sluit: async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); },
  };
}
