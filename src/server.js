import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { startEventsBus, stopEventsBus } from "./lib/events-bus.js";

const server = createApp().listen(config.port, () => {
  console.log(`KNET API escuchando en http://localhost:${config.port} (CORS: ${config.corsOrigin.join(", ")})`);
});

startEventsBus().catch((e) => console.error(`[eventos] no se pudo activar LISTEN/NOTIFY: ${e.message}`));

function shutdown(signal) {
  console.log(`${signal}: cerrando el servidor…`);
  stopEventsBus().finally(() => server.close(() => pool.end().finally(() => process.exit(0)))); // cierra también las conexiones SSE
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
