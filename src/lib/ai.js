/**
 * Cliente del LLM (Claude, SDK oficial @anthropic-ai/sdk). La key vive solo en el servidor (AI_API_KEY)
 * y nunca se registra ni se devuelve. Cualquier fallo del proveedor (sin key, timeout, 429/5xx, rechazo
 * por seguridad) se traduce en 503 { error: "ai_unavailable" } para que el frontend use su respuesta local.
 *
 * - Un solo reintento (maxRetries: 1) y timeout AI_TIMEOUT_MS por intento.
 * - Server-side fallback ("default"): si el modelo declina por seguridad, la API reintenta con el
 *   modelo de respaldo que define Anthropic dentro de la misma llamada.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../config.js";
import { HttpError } from "./http.js";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
let client = null;

export const aiEnabled = () => !!config.ai.apiKey;

function getClient() {
  if (!aiEnabled()) throw unavailable("La IA no está configurada en el servidor");
  client ||= new Anthropic({ apiKey: config.ai.apiKey, timeout: config.ai.timeoutMs, maxRetries: 1 });
  return client;
}

const unavailable = (message = "La IA no está disponible ahora") => new HttpError(503, message, "ai_unavailable");

/** Registra el fallo sin datos sensibles (ni key, ni prompt, ni respuesta) */
function logFailure(e) {
  let kind = "error";
  if (e instanceof Anthropic.RateLimitError) kind = "429 rate limit del proveedor";
  else if (e instanceof Anthropic.AuthenticationError) kind = "401 key inválida";
  else if (e instanceof Anthropic.APIConnectionTimeoutError) kind = "timeout";
  else if (e instanceof Anthropic.APIConnectionError) kind = "sin conexión con el proveedor";
  else if (e instanceof Anthropic.APIError) kind = `HTTP ${e.status}`;
  console.error(`[IA] fallo del proveedor: ${kind}`);
}

/**
 * Llama al modelo. format (opcional) = esquema zod para salida estructurada.
 * Devuelve { text } o { data } (si hay format) y { model } (el que respondió).
 */
export async function generate({ system, messages, maxTokens = 1024, effort = "low", format }) {
  const c = getClient();
  const params = {
    model: config.ai.model,
    max_tokens: maxTokens,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    system,
    messages,
    output_config: { effort, ...(format ? { format: zodOutputFormat(format) } : {}) },
  };
  let res;
  try {
    res = format ? await c.beta.messages.parse(params) : await c.beta.messages.create(params);
  } catch (e) {
    logFailure(e);
    throw unavailable();
  }
  if (res.stop_reason === "refusal") {
    console.error(`[IA] el modelo declinó la solicitud (${res.stop_details?.category ?? "sin categoría"})`);
    throw unavailable();
  }
  if (format) {
    if (!res.parsed_output) throw unavailable("La IA devolvió una respuesta incompleta");
    return { data: res.parsed_output, model: res.model };
  }
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw unavailable("La IA devolvió una respuesta vacía");
  return { text, model: res.model };
}
