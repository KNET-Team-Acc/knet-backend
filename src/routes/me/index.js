import { Router } from "express";
import { requireLegal } from "../../middleware/legal.js";
import checkins from "./checkins.js";
import connections from "./connections.js";
import consents from "./consents.js";
import dossiers from "./dossiers.js";
import missions from "./missions.js";
import profile from "./profile.js";
import registrations from "./registrations.js";
import stream from "./stream.js";

const router = Router();

// Sin bloqueo legal: re-aceptar los documentos (POST /consents) y ejercer la supresión (DELETE /api/me)
router.use("/consents", consents);
router.use(requireLegal((req) => req.method === "DELETE" && (req.path === "/" || req.path === "")));

router.use("/", profile);                 // GET/PATCH/DELETE /api/me
router.use("/registrations", registrations);
router.use("/checkins", checkins);
router.use("/missions", missions);
router.use("/connections", connections);
router.use("/dossiers", dossiers);
router.use("/stream", stream);            // Server-Sent Events

export default router;
