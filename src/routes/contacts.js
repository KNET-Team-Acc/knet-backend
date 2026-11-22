import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { toContact } from "../lib/serialize.js";

const router = Router();

// GET /api/contacts?industry=tech → personas con las que se puede conectar (matches)
router.get("/", async (req, res) => {
  const { industry } = z.object({ industry: z.string().max(40).optional() }).parse(req.query);
  const { rows } = await query(
    `SELECT * FROM contacts WHERE ($1::text IS NULL OR industry = $1)
      ORDER BY affinity DESC NULLS LAST, name`, [industry ?? null]);
  res.json({ contacts: rows.map(toContact) });
});

export default router;
