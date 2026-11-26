/**
 * Validación de lo que envía el panel de creador de eventos (/api/admin/*). Mensajes en español.
 * La ficha (info) y el recinto (venue) siguen la forma de EV_INFO y VENUES del frontend: el frontend
 * descarta los que no la cumplen (okInfo / okVenue en knetApp.js), así que aquí se exige lo mismo.
 */
import { z } from "zod";

const txt = (max, min = 0, label = "El texto") =>
  z.string({ error: `${label} debe ser texto` }).trim()
    .min(min, min ? `${label} debe tener al menos ${min} caracteres` : undefined)
    .max(max, `${label} admite hasta ${max} caracteres`);
const hex = z.string().regex(/^#[0-9a-f]{3,8}$/i, "Usa un color hexadecimal, p. ej. #1E1452");
const num = z.number({ error: "Debe ser un número" }).finite();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa fechas AAAA-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().startsWith(d), "Fecha inválida");
const tags = z.array(txt(60, 1, "Cada etiqueta"), { error: "Envía una lista" }).max(12, "Hasta 12 etiquetas");
const httpUrl = z.string().trim().max(500).regex(/^https?:\/\/[^\s"'<>`]+$/i, "La URL debe empezar por http:// o https://");

export const eventFields = {
  name: txt(120, 3, "El nombre"),
  city: txt(60, 2, "La ciudad"),
  venueName: txt(160, 0, "El recinto"),
  dateLabel: txt(60, 0, "La fecha visible"),
  lat: num.min(-90).max(90).nullable(),
  lon: num.min(-180).max(180).nullable(),
  tags,
  industries: z.array(z.string().max(40)).max(12),
  description: txt(600, 0, "La descripción"),
  sourceUrl: httpUrl.nullable(),
  organizer: txt(120, 0, "El organizador"),
};

export const createEventSchema = z.object(eventFields).partial().required({ name: true, city: true }).strict();

export const patchEventSchema = z.object(eventFields).partial().strict()
  .refine((o) => Object.keys(o).length > 0, "Envía al menos un campo");

export const daysSchema = z.object({
  days: z.array(isoDate).min(1, "Agrega al menos un día").max(14, "Hasta 14 días")
    .refine((d) => d.every((x, i) => i === 0 || x > d[i - 1]), "Los días deben ir en orden y sin repetirse"),
}).strict();

export const infoSchema = z.object({
  info: z.object({
    tone: z.tuple([hex, hex], { error: "tone son dos colores" }),
    accent: hex,
    lema: txt(300, 0, "El lema"),
    para: txt(300, 0, "«Para quién»"),
    formato: z.array(txt(60, 1, "Cada formato")).max(6),
    agenda: z.array(z.tuple([txt(40, 1, "La hora o bloque"), txt(80, 1, "El título"), txt(200, 0, "El detalle")])).max(12, "Hasta 12 bloques de agenda"),
    llevas: z.array(txt(160, 1, "Cada punto")).max(8, "Hasta 8 puntos"),
  }).strict(),
}).strict();

const VENUE_COLORS = ["purple", "lime", "orange", "blue"];
const point = z.tuple([num, num]);
const zone = z.tuple([
  txt(60, 1, "El nombre de la zona"), txt(30, 1, "El tipo de zona"), z.enum(VENUE_COLORS),
  txt(200, 0, "La descripción de la zona"), z.tuple([num, num, num, num]), point, z.string().max(8),
]);
export const venueSchema = z.object({
  venue: z.object({
    size: num.positive(),
    floor: z.tuple([num, num, num, num]),
    ground: z.string().max(20),
    aisle: num.positive(),
    ent: z.string().max(8),
    totems: z.array(z.string().max(8)).max(20),
    // Decoración del recinto 3D: palabras clave («palms water-front», «lamps») y, con palms, dónde van las palmeras
    deco: z.union([z.string().max(80), z.array(z.unknown()).max(40)]).optional(),
    palms: z.array(point).max(60).optional(),
    nodes: z.record(z.string().max(8), point),
    edges: z.array(z.tuple([z.string().max(8), z.string().max(8)])).max(60),
    z: z.array(zone).min(1, "El recinto necesita al menos una zona").max(12),
  }).strict()
    .refine((v) => v.nodes[v.ent], "La entrada (ent) debe ser uno de los nodos")
    .refine((v) => v.edges.every(([a, b]) => v.nodes[a] && v.nodes[b]), "Cada pasillo debe unir dos nodos existentes")
    .refine((v) => v.z.every((x) => v.nodes[x[6]]), "Cada zona debe apuntar a un nodo existente")
    .nullable(),
}).strict();

export const speakerSchema = z.object({
  name: txt(120, 2, "El nombre"),
  role: txt(120, 0, "El cargo"),
  org: txt(120, 0, "La organización"),
  session: txt(120, 0, "La sesión"),
  talk: txt(200, 0, "La charla"),
  bio: txt(800, 0, "La bio"),
  tags,
  avatar: z.record(z.string(), z.unknown()).nullable(),
}).partial().required({ name: true }).strict();
export const speakerPatchSchema = speakerSchema.partial().refine((o) => Object.keys(o).length > 0, "Envía al menos un campo");

export const SESSION_KINDS = ["Keynote", "Panel", "Taller", "Charla", "Networking"];
const sessionFields = {
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Usa la hora en formato HH:MM"),
  kind: z.enum(SESSION_KINDS, { error: `El tipo debe ser ${SESSION_KINDS.join(", ")}` }),
  title: txt(160, 3, "El título"),
  room: txt(80, 0, "La sala"),
  speaker: txt(120, 0, "El ponente"),
  tag: txt(60, 0, "El tema").nullable(),
  why: txt(200, 0, "La descripción").nullable(),
};
export const sessionSchema = z.object({ day: z.number().int().min(0, "El día no es válido"), ...sessionFields })
  .partial().required({ day: true, time: true, kind: true, title: true }).strict();
// El día no se cambia (forma parte del código evento:día:slot que usan los check-ins): borra y vuelve a crear
export const sessionPatchSchema = z.object(sessionFields).partial().strict()
  .refine((o) => Object.keys(o).length > 0, "Envía al menos un campo");

// Tipo de misión → icono que pinta el frontend
export const MISSION_TYPES = { presencial: "pin", networking: "handshake", contenido: "file", quiz: "quiz" };
const missionFields = {
  type: z.enum(Object.keys(MISSION_TYPES), { error: `El tipo debe ser ${Object.keys(MISSION_TYPES).join(", ")}` }),
  title: txt(120, 3, "El título"),
  condition: txt(200, 0, "La condición"),
  xp: z.number().int("La XP debe ser un número entero").min(10, "La XP mínima es 10").max(500, "La XP máxima es 500"),
};
export const missionSchema = z.object(missionFields).partial().required({ type: true, title: true, xp: true }).strict();
export const missionPatchSchema = z.object(missionFields).partial().strict()
  .refine((o) => Object.keys(o).length > 0, "Envía al menos un campo");
