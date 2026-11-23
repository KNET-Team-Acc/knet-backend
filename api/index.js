/**
 * Entrada de la API en Vercel (Vercel Functions, Node.js). La app de Express es en sí misma un
 * manejador (req, res): vercel.json reescribe todas las rutas hacia esta función.
 * En local y en Docker se sigue usando src/server.js (app.listen).
 */
import { createApp } from "../src/app.js";

export default createApp();
