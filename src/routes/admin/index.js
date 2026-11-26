import { Router } from "express";
import { requireLegal } from "../../middleware/legal.js";
import { requireRole } from "../../middleware/roles.js";
import events from "./events.js";

// /api/admin/* · solo cuentas organizer o admin (resolveUser() lo pone src/app.js: sin sesión → 401)
const router = Router();
router.use(requireRole("organizer", "admin"), requireLegal());
router.use("/events", events);

export default router;
