import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { resolveUser } from "./middleware/user.js";
import contactsRouter from "./routes/contacts.js";
import eventsRouter from "./routes/events.js";
import healthRouter from "./routes/health.js";
import meRouter from "./routes/me/index.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: config.corsOrigin, allowedHeaders: ["Content-Type", "X-User-Id"] }));
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter);

  const api = express.Router();
  api.use(resolveUser);
  api.use("/events", eventsRouter);
  api.use("/contacts", contactsRouter);
  api.use("/me", meRouter);
  app.use("/api", api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
