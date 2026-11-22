import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";

const server = createApp().listen(config.port, () => {
  console.log(`KNET API escuchando en http://localhost:${config.port} (CORS: ${config.corsOrigin.join(", ")})`);
});

function shutdown(signal) {
  console.log(`${signal}: cerrando el servidor…`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
