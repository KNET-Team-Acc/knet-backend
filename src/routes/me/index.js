import { Router } from "express";
import { legalOutdated, legalOutdatedError } from "../../lib/auth.js";
import checkins from "./checkins.js";
import connections from "./connections.js";
import consents from "./consents.js";
import dossiers from "./dossiers.js";
import missions from "./missions.js";
import profile from "./profile.js";
import registrations from "./registrations.js";

const router = Router();

// Sin bloqueo legal: re-aceptar los documentos (POST /consents) y ejercer la supresión (DELETE /api/me)
router.use("/consents", consents);
router.use((req, _res, next) => {
  const erase = req.method === "DELETE" && (req.path === "/" || req.path === "");
  if (!erase && legalOutdated(req.user)) throw legalOutdatedError();
  next();
});

router.use("/", profile);                 // GET/PATCH/DELETE /api/me
router.use("/registrations", registrations);
router.use("/checkins", checkins);
router.use("/missions", missions);
router.use("/connections", connections);
router.use("/dossiers", dossiers);

export default router;
