# KNET · Backend

API REST (Node.js + **Express 5**) y base de datos **PostgreSQL 16** para el panel del asistente de KNET.
La consume el frontend ([knet-frontend](https://github.com/KNET-Team-Acc/knet-frontend)) desde `src/services/api.js`, con fallback a `localStorage` si la API está apagada.

## Requisitos

- Node.js 20 o superior
- Docker Desktop (con `docker compose`)

## Cómo arrancar

```bash
git clone https://github.com/KNET-Team-Acc/knet-backend.git
cd knet-backend
cp .env.example .env          # en PowerShell: Copy-Item .env.example .env
docker compose up -d          # PostgreSQL en localhost:5433
npm install
npm run db:migrate            # crea las tablas
npm run db:seed               # carga eventos, sesiones, misiones, contactos y usuarios demo
npm run dev                   # API en http://localhost:4000 (se recarga al guardar)
```

Para comprobar que todo funciona, con la API en marcha y desde otra terminal:

```bash
npm run smoke
```

| Script | Qué hace |
|---|---|
| `npm run dev` / `npm start` | Levanta la API (`dev` se recarga al guardar) |
| `npm run db:migrate` | Aplica las migraciones de `db/migrations/` que falten |
| `npm run db:seed` | Carga `db/data/` en la base de datos. Se puede repetir |
| `npm run db:reset` | **Borra todo** y vuelve a migrar y a cargar el seed (solo desarrollo) |
| `npm run smoke` | Prueba todos los endpoints contra la API en marcha (incluye registro, login, refresh y legal) |
| `npm run test:ai` | Prueba `/api/ai/*` con respuestas simuladas del proveedor (no gasta tokens ni necesita la API en marcha) |
| `npm run test:stream` | Prueba `GET /api/me/stream` (SSE): eventos, heartbeat y reanudación. Con `EVENTS_PG_NOTIFY=true` prueba LISTEN/NOTIFY |
| `npm run test:linkedin` | Prueba el flujo OAuth de LinkedIn simulando sus endpoints (no necesita la API en marcha) |

PostgreSQL usa el puerto **5433** del host para no chocar con una instalación local en el 5432.
Para entrar a la consola: `docker exec -it knet-db psql -U knet`.

## Autenticación

- **Cuentas reales:** `POST /api/auth/register` o `/api/auth/login` devuelven un **access token JWT** (HS256, `JWT_TTL`, 15 min por defecto) y un **refresh token** opaco y rotatorio (`REFRESH_TTL`, 30 días). Se envía `Authorization: Bearer <accessToken>`. Al caducar (401 `token_expired`), `POST /api/auth/refresh` entrega un par nuevo y el refresh anterior deja de servir; reutilizar uno ya rotado revoca toda su familia (401 `invalid_refresh`). En la base solo se guarda el SHA-256 del refresh token. Contraseñas con bcrypt (12 rondas).
- **LinkedIn (OpenID Connect):** el frontend navega a `GET /api/auth/linkedin?scopes=work,skills&legalVersion=1.2&returnTo=<url del front>`; la API guarda un `state` de un solo uso (10 min) y redirige a LinkedIn con `openid profile email`. El callback crea o vincula la cuenta por `linkedin_sub` (o por correo verificado), registra `autorizacion_linkedin` con los campos que marcó el usuario y vuelve a `returnTo?knet_auth=<código>`; el front canjea ese código (2 min, un solo uso) en `POST /api/auth/exchange`. Si el usuario cancela, vuelve con `?knet_auth_error=linkedin_denied`. Con OIDC estándar LinkedIn solo entrega **nombre, foto y correo**: cargo, empresa, industria e intereses los completa el usuario aunque los haya autorizado. En LinkedIn Developers, la URL de redirección debe ser exactamente `LINKEDIN_REDIRECT_URI`.
- **Versión legal:** `users.legal_version` guarda la versión de Términos y Política aceptada. Si es menor que `LEGAL_VERSION` (o no hay ninguna), `/api/me/*` responde `409 { error: "legal_outdated", required: "1.2" }`, salvo `/api/me/consents` y `DELETE /api/me`. Para salir del bloqueo se envía `POST /api/me/consents` con `type: "aceptacion"` y `documents` que incluyan `terminos` y `privacidad` en esa versión. Las cuentas demo no se bloquean.
- **Desarrollo:** solo con `NODE_ENV=development` se acepta el header `X-User-Id: <uuid>` y, sin nada, el usuario demo `DEMO_USER_EMAIL` (por defecto `demo.tech@knet.local`). En cualquier otro entorno, sin token responde 401. El catálogo (`/api/events`, `/api/contacts`) es público: sin sesión no trae `registered` ni `locked`.
- `/login`, `/register` y `/exchange` tienen rate limit por IP (`AUTH_RATE_LIMIT` intentos cada 15 min → 429 `rate_limited`). Detrás de un proxy, define `TRUST_PROXY`.

Al terminar, `npm run db:seed` muestra los UUID de los 4 usuarios demo (`demo.banca`, `demo.tech`, `demo.consultoria`, `demo.energia`). No tienen contraseña: solo se usan con `X-User-Id` en desarrollo.

## Endpoints

Todas las respuestas son JSON. Los errores tienen la forma `{ "error": "code", "message": "…" }`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado de la API, de la base de datos y de las migraciones |
| GET | `/api/auth/providers` | `{ password, linkedin, legalVersion }`: métodos de acceso activos y versión legal vigente |
| POST | `/api/auth/register` | `{ email, password (8+), name, industry?, acceptLegal: true, legalVersion, consentDetails? }` → `{ user, consent, accessToken, refreshToken, expiresIn, refreshExpiresAt }`. Registra la `aceptacion` en la cadena. 409 `email_taken`, 409 `legal_outdated` si la versión es vieja |
| POST | `/api/auth/login` | `{ email, password }` → `{ user, accessToken, refreshToken, … }`. 401 `invalid_credentials` |
| POST | `/api/auth/refresh` | `{ refreshToken }` → par nuevo (rotación). 401 `invalid_refresh` si está revocado, caducado o reutilizado |
| POST | `/api/auth/logout` | `{ refreshToken }` → 204. Revoca ese refresh token |
| GET | `/api/auth/linkedin` | Inicia OAuth con LinkedIn (`scopes`, `legalVersion`, `returnTo`). 503 `linkedin_unavailable` sin configurar |
| GET | `/api/auth/linkedin/callback` | Retorno de LinkedIn: crea o vincula la cuenta y redirige a `returnTo?knet_auth=<código>` |
| POST | `/api/auth/exchange` | `{ code }` → `{ user, created, linkedinScopes, accessToken, refreshToken, … }` |
| GET | `/api/events` | Eventos (`?kind=real\|demo\|exclusive`, `?industry=tech`). Incluye `locked` y `registered` |
| GET | `/api/events/:id` | Detalle con ficha (`info`), recinto 3D (`venue`) y speakers |
| GET | `/api/events/:id/sessions?day=0` | Sesiones del día, en la variante de la industria del usuario, con `checkedIn` |
| GET | `/api/contacts` | Personas con las que se puede conectar (`?industry=`) |
| GET | `/api/me` | Perfil, XP, nivel, permisos, estadísticas e inscripciones |
| PATCH | `/api/me` | Edita `name`, `role`, `company`, `industry`, `seniority`, `location`, `interests`, `avatar` y `scopes` |
| DELETE | `/api/me` | Suprime el perfil, el progreso y las sesiones (refresh tokens). Exige identificarse explícitamente con Bearer o, en desarrollo, `X-User-Id` (400 si se usa el demo por defecto); las cuentas demo responden 403 `demo_account`. Los consentimientos se conservan desvinculados y se agrega un evento `supresion`. Devuelve `{ deleted: { profile, registrations, … }, consentsRetained }` |
| GET | `/api/me/consents` | Registro de consentimientos, con la verificación de la cadena de hashes (`chain.valid`) |
| POST | `/api/me/consents` | `{ type, documents?, details? }`: agrega un registro a la cadena (`supresion` solo lo registra el servidor). Una `aceptacion` de `terminos` y `privacidad` actualiza `legalVersion` (respuesta: `{ consent, legalVersion, legalRequired }`) |
| GET | `/api/me/registrations` | Eventos en los que estoy inscrito |
| POST / DELETE | `/api/me/registrations/:eventId` | Inscribirse o cancelar. Los eventos exclusivos exigen el nivel mínimo |
| GET | `/api/me/checkins` | Mis check-ins (`?eventId=`) |
| POST | `/api/me/checkins` | `{ sessionCode: "bog:0:2", method?: "qr"\|"nfc"\|"manual" }`: +40 XP |
| GET | `/api/me/missions` | Misiones de mi industria, comunes y grupales, con su estado |
| POST | `/api/me/missions/:code/complete` | Completa la misión y suma su XP |
| GET | `/api/me/connections` | Mis conexiones (`?status=pending\|accepted`) |
| POST | `/api/me/connections` | `{ contactId \| name, source?: "request"\|"match"\|"qr", context?, eventId? }`. Por QR queda aceptada y suma +100 XP |
| PATCH | `/api/me/connections/:id` | `{ status: "accepted" }`: acepta una solicitud pendiente y suma +100 XP (una sola vez por contacto; repetirlo no falla) |
| DELETE | `/api/me/connections/:id` | Quita la conexión. La XP ya ganada se conserva |
| GET | `/api/me/coffees` | Cafés 1:1 donde participo (`?status=proposed\|accepted\|declined\|done\|cancelled`). Cada uno trae `role` (`proposer`/`invitee`), `connectionId` (la conexión propia) y `with` |
| POST | `/api/me/coffees` | `{ connectionId, slot (ISO, futuro), place?, eventId? }` → propone un café. 403 `not_connected` si la conexión no está aceptada; 409 `coffee_active` si ya hay uno pendiente o confirmado con esa persona |
| PATCH | `/api/me/coffees/:id` | `{ status: "accepted"\|"declined"\|"done"\|"cancelled" }`. Acepta o rechaza el invitado (con un contacto del catálogo, quien propone). Aceptar suma +50 XP a cada participante con cuenta, una sola vez (`coffee:<id>`). 409 `invalid_transition` |
| GET | `/api/me/messages/:connId` | Chat con esa conexión, del más antiguo al más reciente (`?limit=30&before=<nextCursor>`). Marca como leídos los recibidos. 404 si la conexión no es mía |
| POST | `/api/me/messages/:connId` | `{ body }` (1–2000 caracteres) → envía un mensaje. 403 `not_connected` si la conexión no está aceptada |
| POST | `/api/ai/chat` | AI Concierge. `{ message, history?, eventId?, day?, lang? }` → `{ reply, sources }`. RAG ligero: sesiones del día (variante de la industria) y speakers reales del evento van en el prompt; `sources` lista las sesiones citadas |
| POST | `/api/ai/simulate` | Simulador de networking. `{ contactId | contactName, message, history?, lang? }` → `{ reply }` en la voz del contacto |
| POST | `/api/ai/dossier` | `{ eventId, lang? }` → `{ dossier }` (mismo contrato que `/api/me/dossiers/:eventId`, con `content.generatedBy: "ai"` y `content.paraTi`). Usa check-ins, conexiones y `xp_ledger` reales |
| GET | `/api/me/stream` | Server-Sent Events del usuario (`connection.request`, `connection.accepted`, `message.new`, `coffee.updated`). Ver «Tiempo real» |
| GET | `/api/me/dossiers` | Todos mis dossiers |
| GET / POST | `/api/me/dossiers/:eventId` | Lee o genera el dossier del evento. `POST { ideas?, plan?, notes? }`; el resumen de sesiones, contactos y XP lo calcula el servidor |

Ejemplo:

```bash
curl http://localhost:4000/api/events/bog/sessions?day=0
curl -X POST http://localhost:4000/api/me/checkins -H "Content-Type: application/json" -d '{"sessionCode":"bog:0:0"}'
```

## IA (Claude)

- `src/lib/ai.js` usa el SDK oficial `@anthropic-ai/sdk` con `AI_MODEL` (por defecto `claude-opus-5-5`), un solo reintento y `AI_TIMEOUT_MS` por intento. Activa el *server-side fallback* de Anthropic (`fallbacks: "default"`): si el modelo declina por seguridad, la API reintenta con un modelo de respaldo en la misma llamada.
- Sin `AI_API_KEY`, con el proveedor caído, un timeout o un rechazo, los tres endpoints responden `503 { error: "ai_unavailable" }` y el frontend usa su contenido local. El resto de la API no se ve afectado.
- Rate limit por usuario: `AI_RATE_LIMIT` peticiones por minuto → 429 `rate_limited`. Exigen sesión y la versión legal vigente (409 `legal_outdated`).
- **Privacidad:** al proveedor solo va lo que cubren los permisos del usuario (`aiProfile()` en `src/lib/queries.js`): nombre de pila y cargo; industria, seniority y empresa con `industry`; intereses con `interests`; las conexiones del dossier con `network`. Nunca correo, id ni foto. La key no aparece en logs ni respuestas.
- `history` admite como máximo 12 turnos de hasta 2000 caracteres; `message`, 1000 (600 en el simulador).

## Tiempo real (SSE)

`GET /api/me/stream` mantiene abierta una respuesta `text/event-stream`. Cada evento lleva `id`, `event` (tipo) y `data` (JSON con `at` y el objeto afectado, p. ej. `{ connection }`).

```js
// En el navegador: EventSource no envía headers, así que el token va en la query
const es = new EventSource(`${API_URL}/api/me/stream?access_token=${accessToken}`);
es.addEventListener("connection.accepted", (e) => console.log(JSON.parse(e.data)));
```

- **Heartbeat:** un comentario `: ping` cada `SSE_HEARTBEAT_MS` (25 s) para que proxies y balanceadores no corten la conexión.
- **Reanudación:** `EventSource` reconecta solo (`retry: 5000`) y envía `Last-Event-ID`; la API reenvía los eventos que siguen en el buffer (últimos 100 por usuario, 5 min). También se acepta `?lastEventId=`.
- **Token:** se valida al conectar. Si caduca, la conexión abierta sigue; al reconectar con un token vencido responde 401 y el cliente debe abrir el stream con uno nuevo. En desarrollo también sirve `?userId=<uuid>`.
- **Eventos publicados hoy:** `connection.request` y `connection.accepted` (`/api/me/connections`), `message.new` (`{ connectionId, message }`, con el `connectionId` de quien lo recibe) y `coffee.updated` (`{ coffeeId, status }`, a los dos participantes).
- **Varias instancias:** con `EVENTS_PG_NOTIFY=true` cada evento se publica con `NOTIFY knet_events` y todas las instancias lo reciben con `LISTEN`. Con una sola instancia basta el bus en memoria.
- **¿WebSockets?** SSE alcanza mientras el tiempo real sea solo servidor → cliente (las acciones siguen por REST). Si se necesita un canal bidireccional (p. ej. «escribiendo…» en los DMs), se puede migrar a WebSockets reutilizando el mismo bus.

## Despliegue

**Producción actual (Vercel + Neon):** API en https://knet-backend.vercel.app (proyecto `knet-backend`), PostgreSQL en Neon (`knet-db`, región `iad1`, conectado por la integración de Vercel, que define `DATABASE_URL` y `DATABASE_URL_UNPOOLED`). `api/index.js` exporta la app de Express como Vercel Function y `vercel.json` reescribe todas las rutas hacia ella; `.vercelignore` evita subir `.env*`.
- Desplegar: `npx vercel deploy --prod` (el repositorio aún no está conectado a la app de GitHub de Vercel; al conectarlo, cada push a `main` desplegará solo).
- Migraciones: `vercel env pull` y `npm run db:migrate` con `DATABASE_URL_UNPOOLED` (no se aplican al desplegar la función).
- Variables en Vercel: `JWT_SECRET` (sensible), `TRUST_PROXY=1`, `LEGAL_VERSION`, `CORS_ORIGIN=https://knet-frontend.vercel.app`. Faltan `AI_API_KEY` y las de LinkedIn.
- Límites en Vercel: `/api/me/stream` (SSE) se corta a los 300 s y el cliente reconecta con `Last-Event-ID`; el bus de eventos y el rate limit viven en memoria por instancia.

**Contenedor (cualquier otra plataforma):**

**Imagen Docker** (`Dockerfile` multi-stage, Node 22 Alpine, usuario `node` sin privilegios, solo dependencias de producción):

```bash
docker build -t knet-api .
docker run -p 4000:4000 --env-file .env.production knet-api
```

- Al arrancar aplica las migraciones pendientes (`docker-entrypoint.sh`). Para correrlas en un job previo (`npm run db:migrate`), define `RUN_MIGRATIONS=false`.
- El healthcheck de la imagen y de la plataforma es `GET /health` (200 con la base de datos arriba, 503 si no).
- Variables de producción: ver `.env.production.example`. Lo mínimo: `NODE_ENV=production`, `DATABASE_URL` con SSL (`?sslmode=require` y `DATABASE_SSL`), `CORS_ORIGIN` con el dominio del frontend, `JWT_SECRET`, `TRUST_PROXY=1` detrás del balanceador y, si se usan, las de LinkedIn e IA. `LINKEDIN_REDIRECT_URI` debe apuntar al dominio público de la API.
- El frontend se construye con `VITE_API_URL` = URL pública de la API; ese origen va en `CORS_ORIGIN`.
- Sirve en cualquier plataforma de contenedores (Render, Railway, Fly.io, Cloud Run, Azure Container Apps…) con un PostgreSQL 16 gestionado.

**CI** (`.github/workflows/ci.yml`, en cada push a `main` y en cada PR): instala, migra y carga el seed contra un PostgreSQL de servicio, arranca la API y corre `npm run smoke`, `test:ai`, `test:linkedin` y `test:stream` (también con LISTEN/NOTIFY). Otro job construye la imagen y comprueba que migra y responde 200 en `/health`.

## Modelo de datos

`db/migrations/001_init.sql`, `002_user_erasure.sql`, `003_auth.sql` y `004_coffees_messages.sql`:

- **Perfil:** `users` (con `password_hash`, `linkedin_sub`, `legal_version`, `email_verified_at`, `photo_url`), `user_scopes` (permisos MCP) y `consents` (cadena SHA-256, solo inserción).
- **Sesiones:** `refresh_tokens` (SHA-256 del token, familia de rotación, `ON DELETE CASCADE`), `oauth_states` (state de LinkedIn, un solo uso) y `auth_handoffs` (código de canje tras LinkedIn).
- **Catálogo:** `industries`, `events`, `event_days`, `speakers` y `sessions` (`code` = `evento:día:slot`, igual que en el frontend).
- **Progreso:** `registrations`, `checkins`, `missions`, `mission_progress` y `xp_ledger` (cada XP sumado queda registrado y no se puede sumar dos veces; `users.xp` guarda el total).
- **Red:** `contacts` (los matches de cada industria y los asistentes de `SUMMIT_POOL` que aparecen en el escaneo QR) y `connections`. Una conexión apunta a un contacto del catálogo (`contact_id`) o a otro usuario real (`peer_user_id`); entre usuarios reales hay dos filas espejo, una por lado.
- **Cafés y chat:** `coffees` (`proposer_id`, `invitee_id` NULL si el invitado es un contacto del catálogo, `slot`, `place`, `status`) y `messages` (por `connection_id` de quien envía; un hilo entre usuarios reales reúne las dos filas espejo). Todo cae por `ON DELETE CASCADE` al borrar el usuario.
- **Dossier:** `dossiers` (contenido `jsonb` por usuario y evento).

Notas:

- **Datos del seed:** `db/data/` es una copia de los archivos de `src/data/` del frontend (`events`, `gamification`, `industries`, `privacy`, `venues`). Si el frontend los cambia, cópialos de nuevo aquí y corre `npm run db:seed`.
- La agenda del **día 1 de `bog`** tiene una variante por industria, como en el frontend (`IND[*].agenda`).
  Las demás sesiones son genéricas: usan las mismas plantillas que `sessionsFor()`, pero sin personalizarlas por perfil, así que los títulos pueden no coincidir con los que muestra el frontend hoy. Los códigos sí coinciden.
- **Consentimientos:** el frontend envía cada evento a `POST /api/me/consents` (`details` lleva el registro local completo, con su `idLocal` y `hashLocal`) y muestra el registro con `GET /api/me/consents`. Si la API no responde, el evento queda pendiente en el navegador y se reenvía en orden al reconectar. El hash del servidor es una cadena propia, independiente de la del navegador.
- **Supresión y retención:** `DELETE /api/me` borra el usuario; las demás tablas se borran por `ON DELETE CASCADE`. `consents.user_id` usa `ON DELETE SET NULL` y el trigger de solo inserción permite únicamente ese cambio (pasar `user_id` a `NULL` sin tocar otra columna); cualquier otro `UPDATE` o `DELETE` sigue bloqueado. `consents.subject_id` guarda el UUID del titular sin llave foránea y es el que entra en el hash, así que la cadena sigue siendo verificable después del borrado. El registro queda **desvinculado, no anonimizado** (`payload` conserva el nombre del titular y `client` el navegador): es la prueba de la autorización (Ley 1581, art. 17) durante el periodo de retención.
- El nivel se calcula igual que en el frontend: `floor(xp / 500) + 1`, con 5 niveles como máximo (`src/lib/levels.js`).
- Para cambiar el esquema, agrega `db/migrations/005_<descripcion>.sql` (o el siguiente número). No edites una migración que ya se aplicó.

## Pendiente

- Verificación de correo y recuperación de contraseña para las cuentas con contraseña.
- Importar cargo y empresa de LinkedIn (requiere productos de LinkedIn fuera de OpenID Connect).
- Usar la agenda personalizada del servidor en el RAG del Concierge cuando exista (#4).
- Pasar a la base de datos el chat del Concierge, las notificaciones y las recompensas del avatar.
- Endpoint de administración para que el Responsable consulte y exporte el registro de consentimientos de todos los usuarios (hoy `GET /api/me/consents` solo devuelve el del usuario actual).
- Purgar los consentimientos desvinculados cuando vence el periodo de retención (hoy el trigger impide borrarlos; haría falta un proceso controlado).
- Cuentas demo: `DELETE /api/me` las rechaza porque son compartidas; con login real ya no se usan fuera de desarrollo.
- Guardar en el servidor la agenda personalizada por perfil (hoy las sesiones son genéricas salvo el día 1 de `bog`).

## Licencia

[MIT](LICENSE) © 2026 KNET Team.
