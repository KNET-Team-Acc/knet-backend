import { Router } from "express";
import { query } from "../db.js";

const router = Router();

router.get("/health", async (_req, res) => {
  try {
    const { rows } = await query("SELECT count(*)::int AS n, max(name) AS last FROM schema_migrations");
    res.json({ status: "ok", db: "up", migrations: rows[0].n, lastMigration: rows[0].last });
  } catch (e) {
    res.status(503).json({ status: "degraded", db: "down", message: e.message || e.code || "Sin conexión" });
  }
});

export default router;
