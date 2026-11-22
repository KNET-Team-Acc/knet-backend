import { ZodError } from "zod";
import { HttpError } from "../lib/http.js";

export function notFound(req, res) {
  res.status(404).json({ error: "not_found", message: `No existe ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "validation_error",
      message: "Datos inválidos",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json", message: "El cuerpo no es JSON válido" });
  // Errores de PostgreSQL
  if (err.code === "23505") return res.status(409).json({ error: "conflict", message: "El registro ya existe" });
  if (err.code === "23503") return res.status(400).json({ error: "bad_reference", message: "Referencia a un registro que no existe" });
  if (err.code === "ECONNREFUSED") return res.status(503).json({ error: "db_unavailable", message: "La base de datos no responde" });

  console.error(err);
  res.status(500).json({ error: "internal_error", message: "Error interno" });
}
