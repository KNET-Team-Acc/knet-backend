import { Router } from "express";
import checkins from "./checkins.js";
import connections from "./connections.js";
import consents from "./consents.js";
import dossiers from "./dossiers.js";
import missions from "./missions.js";
import profile from "./profile.js";
import registrations from "./registrations.js";

const router = Router();
router.use("/", profile);                 // GET/PATCH /api/me
router.use("/consents", consents);
router.use("/registrations", registrations);
router.use("/checkins", checkins);
router.use("/missions", missions);
router.use("/connections", connections);
router.use("/dossiers", dossiers);

export default router;
