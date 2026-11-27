/** Convierte filas snake_case de PostgreSQL en el JSON camelCase de la API. */
import { levelInfo } from "./levels.js";

export const initialsOf = (n) =>
  (String(n || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("") || "TÚ").toUpperCase();

export const toUser = (u, scopes) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  initials: initialsOf(u.name),
  role: u.role,
  company: u.company,
  industry: u.industry,
  seniority: u.seniority,
  location: u.location,
  interests: u.interests,
  avatar: u.avatar,
  fieldSources: u.field_sources,
  linkedinConnected: u.linkedin_connected,
  photoUrl: u.photo_url ?? null,
  emailVerified: Boolean(u.email_verified_at),
  hasPassword: Boolean(u.password_hash),
  legalVersion: u.legal_version ?? null,
  isDemo: u.is_demo,
  accountRole: u.account_role ?? "attendee", // attendee | organizer | admin (rol de la cuenta, no el cargo)
  xp: u.xp,
  ...levelInfo(u.xp),
  scopes,
  createdAt: u.created_at,
  updatedAt: u.updated_at,
});

export const toEvent = (e, userXp) => ({
  id: e.id,
  name: e.name,
  kind: e.kind,
  city: e.city,
  venueName: e.venue_name,
  dateLabel: e.date_label,
  days: e.days ?? [],
  lat: e.lat,
  lon: e.lon,
  tags: e.tags,
  industries: e.industries,
  minLevel: e.min_level,
  locked: userXp === undefined ? undefined : levelInfo(userXp).level < e.min_level,
  registered: e.registered,
  organizer: e.organizer,
  sourceUrl: e.source_url,
  description: e.description,
  // Creado por un organizador en KNET (panel /api/admin): su agenda y misiones vienen en GET /api/events/:id
  hosted: e.owner_id != null,
});

/** Evento en el panel de creador: con estado, dueño y totales */
export const toAdminEvent = (e) => ({
  ...toEvent(e),
  status: e.status ?? "published",
  ownerId: e.owner_id ?? null,
  // Quién lo creó (lo usa el admin, que ve los de todos) y si es del catálogo sembrado (solo lectura en el panel)
  owner: e.owner_id ? { id: e.owner_id, name: e.owner_name ?? null, email: e.owner_email ?? null } : null,
  catalog: !e.owner_id,
  publishedAt: e.published_at ?? null,
  counts: { sessions: e.sessions_count ?? 0, speakers: e.speakers_count ?? 0, missions: e.missions_count ?? 0, registrations: e.registrations_count ?? 0 },
  createdAt: e.created_at,
  updatedAt: e.updated_at,
});

export const toAdminSpeaker = (s) => ({
  id: s.id, name: s.name, role: s.role, org: s.org, session: s.session_label, talk: s.talk, bio: s.bio, tags: s.tags, avatar: s.avatar,
});

export const toSession = (s) => ({
  code: s.code,
  eventId: s.event_id,
  day: s.day_index,
  slot: s.slot,
  time: s.start_time,
  kind: s.kind,
  title: s.title,
  room: s.room,
  tag: s.tag,
  why: s.why,
  industry: s.industry,
  speaker: s.speaker || "",
  checkedIn: s.checked_in,
});

export const toAdminSession = (s) => ({ id: s.id, ...toSession(s), checkedIn: undefined });

export const toCheckin = (c) => ({
  id: c.id,
  sessionCode: c.session_code,
  eventId: c.event_id,
  method: c.method,
  createdAt: c.created_at,
  session: c.title === undefined ? undefined
    : c.title === null ? null
    : { title: c.title, time: c.start_time, room: c.room, kind: c.kind, day: c.day_index },
});

export const toMission = (m) => ({
  code: m.code,
  kind: m.kind,
  industry: m.industry,
  icon: m.icon,
  title: m.title,
  subtitle: m.subtitle,
  xp: m.xp,
  tags: m.tags,
  eventId: m.event_id ?? null,
  completed: Boolean(m.completed_at),
  completedAt: m.completed_at ?? null,
});

export const toContact = (c) => ({
  id: c.id,
  name: c.name,
  initials: c.initials,
  headline: c.headline,
  industry: c.industry,
  affinity: c.affinity,
  matchReason: c.match_reason,
  interests: c.interests,
  likes: c.likes,
  goal: c.goal,
});

export const toConnection = (r) => ({
  id: r.id,
  status: r.status,
  source: r.source,
  context: r.context,
  eventId: r.event_id,
  createdAt: r.created_at,
  acceptedAt: r.accepted_at,
  // Contacto del catálogo o, en conexiones entre usuarios reales, la tarjeta pública del otro usuario
  contact: r.contact ? toContact(r.contact) : toPeer(r.peer),
});

/** Tarjeta pública de otro usuario: sin correo ni datos sensibles */
export const toPeer = (u) => u && ({
  id: null,
  userId: u.id,
  name: u.name,
  initials: initialsOf(u.name),
  headline: [u.role, u.company].filter(Boolean).join(" · "),
  industry: u.industry,
  affinity: null,
  matchReason: "",
  interests: [],
  likes: [],
  goal: "",
});

export const toCoffee = (c) => ({
  id: c.id,
  connectionId: c.connection_id,
  role: c.role,                       // proposer | invitee (desde el punto de vista de quien consulta)
  with: c.with_name === undefined ? undefined : { name: c.with_name, initials: initialsOf(c.with_name), userId: c.with_user_id ?? null },
  eventId: c.event_id,
  slot: c.slot,
  place: c.place,
  status: c.status,
  respondedAt: c.responded_at,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

export const toMessage = (m, viewerId) => ({
  id: m.id,
  fromMe: m.sender_id === viewerId,
  body: m.body,
  createdAt: m.created_at,
  readAt: m.read_at,
});

export const toConsent = (c) => ({
  id: c.id,
  type: c.event_type,
  payload: c.payload,
  client: c.client,
  prevHash: c.prev_hash,
  hash: c.hash,
  createdAt: c.created_at,
});

export const toDossier = (d) => ({
  id: d.id,
  eventId: d.event_id,
  content: d.content,
  generatedAt: d.generated_at,
  updatedAt: d.updated_at,
});
