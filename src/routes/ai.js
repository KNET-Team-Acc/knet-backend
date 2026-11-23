/**
 * Funciones de IA del panel (autenticadas, con la versión legal vigente y rate limit por usuario):
 *  - POST /api/ai/chat      AI Concierge con RAG ligero: sesiones y speakers reales del evento en el prompt.
 *  - POST /api/ai/simulate  Simulador de networking: el contacto responde en un chat 1:1.
 *  - POST /api/ai/dossier   Dossier redactado por el LLM con check-ins, conexiones y XP reales; se guarda en dossiers.
 * Al proveedor solo se envía lo que cubren los permisos del usuario (aiProfile); nunca correo ni ids.
 * Sin AI_API_KEY o si el proveedor falla → 503 ai_unavailable (el frontend responde con su contenido local).
 */
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { config } from "../config.js";
import { pool, query, tx } from "../db.js";
import { generate } from "../lib/ai.js";
import { dossierSummary, saveDossier } from "../lib/dossier.js";
import { HttpError } from "../lib/http.js";
import { aiProfile, eventContext } from "../lib/queries.js";
import { toDossier } from "../lib/serialize.js";

const router = Router();

// Rate limit por usuario y por minuto (antes de comprobar la key: protege también al proveedor)
router.use(rateLimit({
  windowMs: 60_000,
  limit: config.ai.rateLimit,
  keyGenerator: (req) => req.user.id,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "rate_limited", message: "Demasiadas peticiones a la IA: espera un minuto" }),
}));

const lang = z.enum(["es", "en"]).default("es");
const history = z.array(z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(2000),
}).strict()).max(12).default([]);

const LANG_RULE = { es: "Responde en español de Colombia.", en: "Respond in English." };
const json = (v) => JSON.stringify(v, null, 0);

/** Historial acotado + mensaje nuevo, empezando siempre por un turno del usuario */
function turns(hist, message) {
  const h = hist.slice();
  while (h.length && h[0].role !== "user") h.shift();
  return [...h, { role: "user", content: message }];
}

// POST /api/ai/chat { message, history?, eventId?, day?, lang? } → { reply, sources }
const chatSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  history,
  eventId: z.string().max(40).optional(),
  day: z.number().int().min(0).max(30).optional(),
  lang,
}).strict();

router.post("/chat", async (req, res) => {
  const body = chatSchema.parse(req.body ?? {});
  const [{ profile }, ctx] = await Promise.all([aiProfile(pool, req.user), eventContext(pool, req.user, body.eventId, body.day)]);
  const sessions = (ctx?.sessions ?? []).map((s) => ({ code: s.code, hora: s.time, tipo: s.kind, titulo: s.title, sala: s.room, porQue: s.why || undefined, checkIn: s.checkedIn }));
  const system = [
    "Eres el AI Concierge de KNET, el asistente de un asistente a un Summit de tecnología y negocios en Colombia.",
    "Ayudas con su agenda, qué sesión sigue, speakers, networking, misiones y logística del evento.",
    "Usa SOLO los datos del bloque <contexto> para hablar de sesiones, horas, salas y speakers; si algo no está ahí, dilo y sugiere revisar la agenda en el panel. No inventes sesiones ni personas.",
    "Cuando recomiendes una sesión, cita su título exacto, la hora y la sala.",
    "Sé breve: 1 a 4 frases, sin Markdown ni listas largas. No pidas ni repitas datos sensibles (salud, creencias, finanzas).",
    LANG_RULE[body.lang],
    `<contexto>\n${json({
      asistente: profile,
      evento: ctx ? { nombre: ctx.event.name, ciudad: ctx.event.city, recinto: ctx.event.venue_name, fechas: ctx.event.date_label, dia: ctx.day + 1, diasTotales: ctx.event.days } : null,
      sesionesDelDia: sessions,
      speakers: (ctx?.speakers ?? []).map((s) => ({ nombre: s.name, cargo: s.role, org: s.org, sesion: s.session_label, charla: s.talk })),
    })}\n</contexto>`,
  ].join("\n");
  const { text } = await generate({ system, messages: turns(body.history, body.message), maxTokens: 1024, effort: "low" });
  res.json({ reply: text, sources: sessions.filter((s) => text.includes(s.titulo)).map((s) => ({ code: s.code, title: s.titulo, time: s.hora, room: s.sala })) });
});

// POST /api/ai/simulate { contactId | contactName, message, history?, lang? } → { reply }
const simulateSchema = z.object({
  contactId: z.number().int().positive().optional(),
  contactName: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(600),
  history,
  lang,
}).strict().refine((o) => o.contactId || o.contactName, "Envía contactId o contactName");

router.post("/simulate", async (req, res) => {
  const body = simulateSchema.parse(req.body ?? {});
  const { rows: [ct] } = body.contactId
    ? await query("SELECT * FROM contacts WHERE id = $1", [body.contactId])
    : await query("SELECT * FROM contacts WHERE name = $1", [body.contactName]);
  if (!ct) throw new HttpError(404, `No existe el contacto ${body.contactId ?? body.contactName}`);
  const { profile } = await aiProfile(pool, req.user);
  const system = [
    `Interpretas a ${ct.name}, asistente de un Summit de tecnología y negocios en Colombia, en un chat 1:1 de networking dentro de la app KNET.`,
    "Habla en primera persona, con tono profesional y cercano, como en un chat real: 1 a 3 frases, sin Markdown.",
    "Mantente fiel a tu perfil; no inventes datos de contacto (teléfono, correo) ni compromisos fuera del Summit. Si te proponen un café, responde con naturalidad.",
    "Es una simulación para practicar networking: no reveles que eres una IA salvo que te lo pregunten directamente.",
    LANG_RULE[body.lang],
    `<tu_perfil>\n${json({ nombre: ct.name, titular: ct.headline, industria: ct.industry, intereses: ct.interests, teGusta: ct.likes, objetivo: ct.goal })}\n</tu_perfil>`,
    `<con_quien_hablas>\n${json(profile)}\n</con_quien_hablas>`,
  ].join("\n");
  const { text } = await generate({ system, messages: turns(body.history, body.message), maxTokens: 512, effort: "low" });
  res.json({ reply: text });
});

// POST /api/ai/dossier { eventId, lang? } → { dossier } (mismo contrato que /api/me/dossiers/:eventId)
const DossierText = z.object({
  resumen: z.string().describe("Párrafo de 2 a 4 frases con lo que logró en el evento"),
  ideas: z.array(z.string()).describe("3 a 6 ideas clave aprendidas, una frase cada una"),
  plan: z.array(z.string()).describe("4 a 8 acciones concretas para los próximos 30 días"),
  paraTi: z.string().describe("Recomendación personal de 1 a 3 frases según su cargo e intereses"),
});

router.post("/dossier", async (req, res) => {
  const body = z.object({ eventId: z.string().min(1).max(40), lang }).strict().parse(req.body ?? {});
  const [summary, { profile, scopes }] = await Promise.all([dossierSummary(pool, req.user, body.eventId), aiProfile(pool, req.user)]);
  const { rows: xpByReason } = await query(
    "SELECT reason, sum(amount)::int AS xp, count(*)::int AS veces FROM xp_ledger WHERE user_id = $1 GROUP BY reason ORDER BY reason",
    [req.user.id]);
  const activity = {
    asistente: profile,
    evento: { nombre: summary.event.name, ciudad: summary.event.city },
    sesionesConCheckIn: summary.sessionsAttended.map((s) => s.title).filter(Boolean),
    // La red solo se comparte con el proveedor si el permiso «network» está concedido
    conexiones: scopes.network ? summary.contacts.map((c) => ({ nombre: c.name, titular: c.headline, contexto: c.context || undefined })) : `${summary.contacts.length} (sin permiso para detallarlas)`,
    misionesCompletadas: summary.missionsCompleted,
    xp: { total: summary.xp, nivel: summary.level, nombreNivel: summary.levelName, porMotivo: xpByReason },
  };
  const system = [
    "Redactas el Dossier post-evento de KNET: un informe breve y accionable para el asistente.",
    "Básate SOLO en la actividad del bloque <actividad>; no inventes sesiones, personas ni cifras. Si hay poca actividad, dilo con tacto y enfoca el plan en retomar contactos y asistir a más sesiones.",
    "Escribe en segunda persona, frases cortas, sin Markdown.",
    LANG_RULE[body.lang],
  ].join("\n");
  const { data, model } = await generate({
    system,
    messages: [{ role: "user", content: `<actividad>\n${json(activity)}\n</actividad>\nGenera el Dossier.` }],
    maxTokens: 4096,
    effort: "medium",
    format: DossierText,
  });
  const clip = (arr, max, len) => arr.map((x) => String(x).trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, len));
  const { row, created } = await tx(async (c) => {
    const fresh = await dossierSummary(c, req.user, body.eventId); // por si cambió durante la generación
    return saveDossier(c, req.user.id, fresh.event.id, {
      ideas: clip(data.ideas, 20, 500),
      plan: clip(data.plan, 30, 300),
      notes: String(data.resumen).slice(0, 5000),
      paraTi: String(data.paraTi).slice(0, 1000),
      summary: fresh,
      generatedBy: "ai",
      model,
    });
  });
  res.status(created ? 201 : 200).json({ dossier: toDossier(row) });
});

export default router;
