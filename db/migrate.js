/**
 * Aplica en orden los archivos db/migrations/*.sql que falten, cada uno en su propia transacción.
 * Uso: npm run db:migrate          → aplica las pendientes
 *      node db/migrate.js --reset  → borra el esquema public y lo recrea (solo desarrollo)
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const reset = process.argv.includes("--reset");

async function main() {
  const c = await pool.connect();
  try {
    if (reset) {
      if (config.nodeEnv === "production") throw new Error("--reset no está permitido con NODE_ENV=production");
      await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      console.log("Esquema public reiniciado");
    }
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(DIR, file), "utf8");
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`Falló ${file}: ${e.message}`);
      }
      console.log(`  ✓ ${file}`);
      count++;
    }
    console.log(count ? `${count} migración(es) aplicada(s)` : "Sin migraciones pendientes");
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
