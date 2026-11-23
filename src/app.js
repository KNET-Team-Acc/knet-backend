import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { resolveUser } from "./middleware/user.js";
import authRouter from "./routes/auth.js";
import contactsRouter from "./routes/contacts.js";
import eventsRouter from "./routes/events.js";
import healthRouter from "./routes/health.js";
import meRouter from "./routes/me/index.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  app.use(cors({ origin: config.corsOrigin, allowedHeaders: ["Content-Type", "Authorization", "X-User-Id"] }));
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter);

  const api = express.Router();
  api.use("/auth", authRouter);                                  // público
  api.use("/events", resolveUser({ optional: true }), eventsRouter); // catálogo: con o sin sesión
  api.use("/contacts", resolveUser({ optional: true }), contactsRouter);
  api.use("/me", resolveUser(), meRouter);
  app.use("/api", api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
