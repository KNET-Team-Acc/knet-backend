import pg from "pg";
import { config } from "./config.js";

// DATE como "YYYY-MM-DD" (sin convertir a Date con zona horaria) y BIGINT como número.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl, max: 10 });

export const query = (text, params) => pool.query(text, params);

/** Ejecuta fn(client) dentro de una transacción; hace ROLLBACK si lanza. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
