import { Router } from "express";
import { requireLegal } from "../../middleware/legal.js";
import attendees from "./attendees.js";
import checkins from "./checkins.js";
import coffees from "./coffees.js";
import connections from "./connections.js";
import consents from "./consents.js";
import dossiers from "./dossiers.js";
import leaderboard from "./leaderboard.js";
import messages from "./messages.js";
import missions from "./missions.js";
import network from "./network.js";
import profile from "./profile.js";
import qr from "./qr.js";
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
router.use("/attendees", attendees);       // directorio de asistentes del evento
router.use("/leaderboard", leaderboard);   // ranking de asistentes del evento (Misiones)
router.use("/network", network);           // grafo de la red con 1.º y 2.º grado
router.use("/qr-token", qr);
router.use("/coffees", coffees);
router.use("/messages", messages);
router.use("/dossiers", dossiers);
router.use("/stream", stream);            // Server-Sent Events

export default router;
