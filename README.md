<p align="center">
  <img src="https://raw.githubusercontent.com/KNET-Team-Acc/knet-frontend/main/docs/screenshots/banner.webp" alt="KNET · Knowledge Network & Event Technology" width="100%">
</p>

<h1 align="center">KNET · Backend</h1>

<p align="center">
  <b>La API que guarda el perfil, el progreso, la red y los consentimientos de cada asistente, y le da al panel de KNET su IA y su tiempo real.</b>
</p>

<p align="center">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white&labelColor=0A0710">
  <img alt="Express 5" src="https://img.shields.io/badge/Express-5-FFFFFF?logo=express&logoColor=white&labelColor=0A0710">
  <img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white&labelColor=0A0710">
  <img alt="Claude" src="https://img.shields.io/badge/IA-Claude_Opus_5.5-D97757?logo=anthropic&logoColor=white&labelColor=0A0710">
  <img alt="Vercel + Neon" src="https://img.shields.io/badge/Deploy-Vercel_%2B_Neon-000000?logo=vercel&logoColor=white&labelColor=0A0710">
  <img alt="MIT" src="https://img.shields.io/badge/Licencia-MIT-10B981?labelColor=0A0710">
</p>

<p align="center">
  <a href="https://knet-backend.vercel.app/health"><b>API en producción</b></a> ·
  <a href="https://knet-frontend.vercel.app"><b>App</b></a> ·
  <a href="https://github.com/KNET-Team-Acc/knet-frontend"><b>Frontend</b></a>
</p>

---

## Tabla de contenido

1. [¿Qué es?](#qué-es)
2. [Funcionalidades](#funcionalidades)
3. [Stack técnico](#stack-técnico)
4. [Cómo empezar](#cómo-empezar)
5. [Variables de entorno](#variables-de-entorno)
6. [Arquitectura](#arquitectura)
7. [Estructura del proyecto](#estructura-del-proyecto)
8. [Autenticación](#autenticación)
9. [Endpoints](#endpoints)
10. [IA (Claude)](#ia-claude)
11. [Tiempo real (SSE)](#tiempo-real-sse)
12. [Modelo de datos](#modelo-de-datos)
13. [Pruebas y CI](#pruebas-y-ci)
14. [Despliegue](#despliegue)
15. [Hoja de ruta](#hoja-de-ruta)
16. [Equipo](#equipo)
17. [Licencia](#licencia)

---

## ¿Qué es?

Es la API REST de **KNET (Knowledge Network & Event Technology)**: Node.js + **Express 5** sobre **PostgreSQL 16**. La consume el [frontend](https://github.com/KNET-Team-Acc/knet-frontend) desde `src/services/api.js`.

El frontend funciona también sin servidor: si la API no responde, sigue con `localStorage` y encola lo que haya que enviar. Al volver la conexión, el backend recibe la cola en orden y es la fuente de verdad de la cuenta, la XP y el registro de consentimientos.

> [!NOTE]
> **En producción:** API en https://knet-backend.vercel.app (Vercel Functions) con la base en **Neon**. Cada push a `main` despliega solo y aplica las migraciones nuevas (ver [Despliegue](#despliegue)).

---

## Funcionalidades

| Área | Qué resuelve |
|---|---|
| **Cuentas** | Registro con correo y contraseña, login con JWT y refresh tokens rotatorios, y **Sign In with LinkedIn** (OpenID Connect). |
| **Legal y consentimientos** | Cadena de hashes SHA-256 de solo inserción, bloqueo `409 legal_outdated` hasta re-aceptar la versión vigente y derecho de supresión (Ley 1581). |
| **Eventos y agenda** | Catálogo de eventos, recintos y speakers, y una agenda del día **personalizada por industria**. |
| **Gamificación** | Check-ins, misiones y un libro de XP que impide sumar dos veces lo mismo. 5 niveles, como en el frontend. |
| **Networking** | Conexiones, **QR dinámico** firmado de un solo uso, **cafés 1:1** y **chat directo** entre asistentes reales. |
| **Check-in NFC** | Endpoint para los tótems del recinto, autenticado con su propia clave. |
| **IA** | AI Concierge con RAG ligero, Simulador de networking y Dossier post-Summit con **Claude**, respetando los permisos del usuario. |
| **Tiempo real** | Server-Sent Events por usuario, con reanudación y LISTEN/NOTIFY para varias instancias. |
| **Operación** | Rate limits, `/health`, imagen Docker, CI con pruebas de punta a punta y migraciones automáticas en producción. |

---

## Stack técnico

| Capa | Tecnología |
|---|---|
| Runtime | **Node.js 22** (ESM, `node --watch` en desarrollo) |
| HTTP | **Express 5** + `cors` + `express-rate-limit` |
| Validación | **zod 4** (cada body y query se valida; los errores salen como `400`) |
| Base de datos | **PostgreSQL 16** con `pg`, migraciones SQL numeradas |
| Auth | `jsonwebtoken` (HS256), `bcryptjs` (12 rondas), OAuth 2.0 / OIDC de LinkedIn |
| IA | SDK oficial **`@anthropic-ai/sdk`**, modelo `claude-opus-5-5` con salida estructurada (zod) |
| Despliegue | **Vercel Functions** + **Neon** · imagen **Docker** multi-stage para otras plataformas |
| CI | **GitHub Actions**: smoke + pruebas contra PostgreSQL, build de la imagen y migraciones en Neon |

---

## Cómo empezar

**Requisitos:** Node.js 20 o superior (se recomienda 22) y Docker Desktop con `docker compose`.

```bash
# 1. Clonar e instalar
git clone https://github.com/KNET-Team-Acc/knet-backend.git
cd knet-backend
npm install

# 2. Variables de entorno
cp .env.example .env          # PowerShell: Copy-Item .env.example .env

# 3. Base de datos (PostgreSQL en localhost:5433)
docker compose up -d
npm run db:migrate            # crea las tablas
npm run db:seed               # eventos, sesiones, misiones, contactos y usuarios demo

# 4. API en http://localhost:4000 (se recarga al guardar)
npm run dev

# 5. En otra terminal: probar todos los endpoints
npm run smoke
```

> [!TIP]
> PostgreSQL usa el puerto **5433** del host para no chocar con una instalación local en el 5432 (cámbialo con `POSTGRES_PORT` y `DATABASE_URL`). Si el 4000 está ocupado, usa otro `PORT` y apunta el frontend con `VITE_API_URL`. Consola de la base: `docker exec -it knet-db psql -U knet`.

| Script | Qué hace |
|---|---|
| `npm run dev` / `npm start` | Levanta la API (`dev` se recarga al guardar). |
| `npm run db:migrate` | Aplica las migraciones de `db/migrations/` que falten. |
| `npm run db:seed` | Carga `db/data/` en la base. Solo hace upserts: se puede repetir. |
| `npm run db:reset` | **Borra todo** y vuelve a migrar y a cargar el seed (bloqueado con `NODE_ENV=production`). |
| `npm run smoke` | Prueba todos los endpoints contra la API en marcha: cuentas, refresh, legal, misiones, red, QR, cafés, chat, supresión… |
| `npm run test:ai` | Prueba `/api/ai/*` con el proveedor simulado (no gasta tokens ni necesita la API en marcha). |
| `npm run test:linkedin` | Prueba el flujo OAuth de LinkedIn simulando sus endpoints. |
| `npm run test:stream` | Prueba el SSE de `/api/me/stream`: eventos, heartbeat y reanudación. Con `EVENTS_PG_NOTIFY=true`, LISTEN/NOTIFY. |
| `npm run parity` | Compara la agenda con `sessionsFor()` del frontend (`FRONTEND_DIR`, `../knet-frontend` por defecto) y, con la API en marcha, también su respuesta. |

Al terminar, `npm run db:seed` muestra los UUID de los 4 usuarios demo (`demo.banca`, `demo.tech`, `demo.consultoria`, `demo.energia`). No tienen contraseña: solo se usan con `X-User-Id` en desarrollo.

---

## Variables de entorno

Todas están en [`.env.example`](.env.example) (desarrollo) y [`.env.production.example`](.env.production.example) (producción). Las principales:

| Variable | Para qué | Por defecto |
|---|---|---|
| `DATABASE_URL` | Conexión a PostgreSQL | `postgres://knet:knet@localhost:5433/knet` |
| `DATABASE_SSL` | SSL de PostgreSQL: vacío, `true` o `no-verify` | vacío |
| `PORT` · `NODE_ENV` | Puerto y entorno | `4000` · `development` |
| `CORS_ORIGIN` | Orígenes del frontend, separados por coma | `:5173` y `:4173` |
| `JWT_SECRET` | Firma de los JWT. **Obligatorio en producción** | — |
| `JWT_TTL` · `REFRESH_TTL` | Vida del access y del refresh token | `15m` · `30d` |
| `AUTH_RATE_LIMIT` | Intentos por IP cada 15 min en login, registro y canje | `20` |
| `TRUST_PROXY` | Proxies delante de la API (`1` detrás de un balanceador) | `0` |
| `LEGAL_VERSION` | Versión vigente de Términos y Política (= `LEGAL.version` del frontend) | `1.2` |
| `LINKEDIN_CLIENT_ID` · `LINKEDIN_CLIENT_SECRET` · `LINKEDIN_REDIRECT_URI` | Sign In with LinkedIn. Sin ellas, el frontend usa el formulario manual | — |
| `AI_API_KEY` · `AI_MODEL` | Key de Claude y modelo. Sin key, `/api/ai/*` responde `503` y el frontend usa su contenido local | — · `claude-opus-5-5` |
| `AI_TIMEOUT_MS` · `AI_RATE_LIMIT` | Tiempo por intento y peticiones por usuario y minuto | `20000` · `10` |
| `QR_SECRET` · `QR_TTL_S` · `QR_SCAN_RATE_LIMIT` | Firma y vida de los QR dinámicos, escaneos por minuto | derivado de `JWT_SECRET` · `45` · `30` |
| `TOTEM_SECRET` | Clave de los tótems NFC. Vacía fuera de desarrollo = check-in NFC desactivado (`503`) | `knet-dev-totem` solo en desarrollo |
| `EVENTS_PG_NOTIFY` · `SSE_HEARTBEAT_MS` | Tiempo real con varias instancias y heartbeat del SSE | `false` · `25000` |

---

## Arquitectura

```mermaid
flowchart LR
    FE[knet-frontend<br/>src/services/api.js] -->|REST + Bearer JWT| API
    FE -->|EventSource| SSE
    Totem[Tótem NFC] -->|X-Totem-Key| API
    subgraph API[Express 5 · src/app.js]
        MW[middleware<br/>user · legal · errores] --> R[routes<br/>auth · events · me · ai · totem]
        R --> L[lib<br/>auth · xp · qr · consents · ai · agenda]
        SSE["GET /api/me/stream"] --- BUS[events-bus]
    end
    L --> DB[(PostgreSQL 16<br/>Neon en producción)]
    BUS <-.->|LISTEN/NOTIFY| DB
    L -->|SDK oficial| Claude[Claude API]
    R -->|OIDC| LinkedIn[LinkedIn]
```

1. **`middleware/user.js`** resuelve quién llama: Bearer JWT y, solo en desarrollo, `X-User-Id` o el usuario demo.
2. **`middleware/legal.js`** bloquea `/api/me/*` con `409 legal_outdated` si la versión legal aceptada es vieja (salvo consentimientos y supresión).
3. Cada **ruta** valida con zod, trabaja en una transacción cuando toca varias tablas y responde JSON. Los errores siempre tienen la forma `{ "error": "code", "message": "…" }`.
4. Lo que otros deben enterarse al instante (conexiones, mensajes, cafés) se publica en el **bus de eventos**, que lo entrega por SSE.

---

## Estructura del proyecto

```text
knet-backend/
├── api/index.js                 # Entrada en Vercel: exporta la app de Express como función
├── src/
│   ├── server.js                # Entrada local y Docker (app.listen)
│   ├── app.js                   # Express: CORS, JSON, rutas y manejo de errores
│   ├── config.js                # Todas las variables de entorno, validadas
│   ├── db.js                    # Pool de pg y helper tx()
│   ├── middleware/              # user (quién llama), legal (409), errors
│   ├── routes/
│   │   ├── auth.js              # registro, login, refresh, logout, LinkedIn, canje
│   │   ├── events.js · contacts.js · health.js
│   │   ├── totem.js             # check-in NFC de los tótems
│   │   ├── ai.js                # Concierge, Simulador y Dossier
│   │   └── me/                  # perfil, consentimientos, inscripciones, check-ins, misiones,
│   │                            # conexiones, QR, cafés, mensajes, dossiers y stream (SSE)
│   └── lib/                     # auth, xp, levels, qr, consents, checkins, threads, agenda,
│                                # dossier, ai, events-bus, queries, serialize, http
├── db/
│   ├── migrations/              # 001_init … 005_qr_nfc (SQL numerado; nunca se editan)
│   ├── data/                    # Copia de src/data/ del frontend (catálogo del seed)
│   ├── migrate.js · seed.js
├── scripts/                     # smoke, ai-mock, linkedin-mock, stream-test, agenda-parity
├── .github/workflows/           # ci.yml (pruebas) y db-migrate.yml (migraciones en Neon)
├── Dockerfile · docker-entrypoint.sh · docker-compose.yml
└── vercel.json · .vercelignore
```

---

## Autenticación

- **Cuentas con contraseña:** `POST /api/auth/register` o `/api/auth/login` devuelven un **access token JWT** (HS256, `JWT_TTL`) y un **refresh token** opaco y rotatorio (`REFRESH_TTL`). Se envía `Authorization: Bearer <accessToken>`. Al caducar (401 `token_expired`), `POST /api/auth/refresh` entrega un par nuevo y el anterior deja de servir. Reutilizar un refresh ya rotado revoca toda su familia (401 `invalid_refresh`). En la base solo se guarda el SHA-256 del refresh token.
- **LinkedIn (OpenID Connect):**

  ```mermaid
  sequenceDiagram
      participant F as Frontend
      participant A as API
      participant L as LinkedIn
      F->>A: GET /api/auth/linkedin?scopes&legalVersion&returnTo
      A->>A: guarda state (un solo uso, 10 min)
      A->>L: redirige (openid profile email)
      L->>A: /api/auth/linkedin/callback?code&state
      A->>A: crea o vincula la cuenta · registra autorizacion_linkedin
      A->>F: returnTo?knet_auth=<código> (2 min, un solo uso)
      F->>A: POST /api/auth/exchange { code }
      A-->>F: user + accessToken + refreshToken
  ```

  La cuenta se vincula por `linkedin_sub` o por correo verificado. Si el usuario cancela, vuelve con `?knet_auth_error=linkedin_denied`. Con OIDC estándar LinkedIn solo entrega **nombre, foto y correo**: cargo, empresa, industria e intereses los completa el usuario. En LinkedIn Developers, la URL de redirección debe ser **exactamente** `LINKEDIN_REDIRECT_URI` (para probarlo en local, registra también la de localhost).
- **Versión legal:** `users.legal_version` guarda la versión aceptada. Si es menor que `LEGAL_VERSION`, `/api/me/*` responde `409 { error: "legal_outdated", required: "1.2" }`, salvo `/api/me/consents` y `DELETE /api/me`. Para salir del bloqueo: `POST /api/me/consents` con `type: "aceptacion"` y `documents` que incluyan `terminos` y `privacidad` en esa versión. Las cuentas demo no se bloquean.
- **Desarrollo:** solo con `NODE_ENV=development` se acepta `X-User-Id: <uuid>` y, sin nada, el usuario demo `DEMO_USER_EMAIL`. En cualquier otro entorno, sin token responde 401. El catálogo (`/api/events`, `/api/contacts`) es público: sin sesión no trae `registered` ni `locked`.
- **Rate limits:** `/login`, `/register` y `/exchange` por IP (`AUTH_RATE_LIMIT` cada 15 min → 429 `rate_limited`). Detrás de un proxy, define `TRUST_PROXY`.

---

## Endpoints

Todas las respuestas son JSON. Los errores tienen la forma `{ "error": "code", "message": "…" }`.

```bash
curl http://localhost:4000/api/events/bog/sessions?day=0
curl -X POST http://localhost:4000/api/me/checkins -H "Content-Type: application/json" -d '{"sessionCode":"bog:0:0"}'
```

<details open>
<summary><b>Salud y cuentas</b></summary>

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado de la API, de la base de datos y de las migraciones |
| GET | `/api/auth/providers` | `{ password, linkedin, legalVersion }`: métodos de acceso activos y versión legal vigente |
| POST | `/api/auth/register` | `{ email, password (8+), name, industry?, acceptLegal: true, legalVersion, consentDetails? }` → `{ user, consent, accessToken, refreshToken, expiresIn, refreshExpiresAt }`. Registra la `aceptacion`. 409 `email_taken`, 409 `legal_outdated` |
| POST | `/api/auth/login` | `{ email, password }` → `{ user, accessToken, refreshToken, … }`. 401 `invalid_credentials` |
| POST | `/api/auth/refresh` | `{ refreshToken }` → par nuevo (rotación). 401 `invalid_refresh` si está revocado, caducado o reutilizado |
| POST | `/api/auth/logout` | `{ refreshToken }` → 204. Revoca ese refresh token |
| GET | `/api/auth/linkedin` | Inicia OAuth con LinkedIn (`scopes`, `legalVersion`, `returnTo`). 503 `linkedin_unavailable` sin configurar |
| GET | `/api/auth/linkedin/callback` | Retorno de LinkedIn: crea o vincula la cuenta y redirige a `returnTo?knet_auth=<código>` |
| POST | `/api/auth/exchange` | `{ code }` → `{ user, created, linkedinScopes, accessToken, refreshToken, … }` |

</details>

<details>
<summary><b>Catálogo: eventos, agenda y contactos</b></summary>

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/events` | Eventos (`?kind=real\|demo\|exclusive`, `?industry=tech`). Incluye `locked` y `registered` |
| GET | `/api/events/:id` | Detalle con ficha (`info`), recinto 3D (`venue`) y speakers |
| GET | `/api/events/:id/sessions?day=0&industry=tech` | Agenda del día personalizada por industria (la del perfil, o `industry` si se envía), con `why` y `checkedIn` |
| POST | `/api/events/:id/nfc-checkin` | **Tótem**: header `X-Totem-Key` (= `TOTEM_SECRET`) y opcional `X-Totem-Id`. `{ sessionCode, token \| userId }` (token QR del teléfono o UUID de la credencial) → check-in con `method: "nfc"` (+40 XP). 401 `invalid_totem`, 503 `nfc_unavailable`, 409 si ya hizo check-in o el token ya se usó |
| GET | `/api/contacts` | Personas con las que se puede conectar (`?industry=`) |

</details>

<details>
<summary><b>Mi perfil, consentimientos y supresión</b></summary>

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/me` | Perfil, XP, nivel, permisos, estadísticas e inscripciones |
| PATCH | `/api/me` | Edita `name`, `role`, `company`, `industry`, `seniority`, `location`, `interests`, `avatar` y `scopes` |
| DELETE | `/api/me` | Suprime el perfil, el progreso y las sesiones. Exige Bearer (o `X-User-Id` en desarrollo); las cuentas demo responden 403 `demo_account`. Los consentimientos se conservan desvinculados con un evento `supresion`. Devuelve `{ deleted: { profile, registrations, … }, consentsRetained }` |
| GET | `/api/me/consents` | Registro de consentimientos, con la verificación de la cadena (`chain.valid`) |
| POST | `/api/me/consents` | `{ type, documents?, details? }`: agrega un registro (`supresion` solo lo registra el servidor). Una `aceptacion` de `terminos` y `privacidad` actualiza `legalVersion` |

</details>

<details>
<summary><b>Progreso: inscripciones, check-ins, misiones y dossier</b></summary>

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/me/registrations` | Eventos en los que estoy inscrito |
| POST / DELETE | `/api/me/registrations/:eventId` | Inscribirse o cancelar. Los eventos exclusivos exigen el nivel mínimo |
| GET | `/api/me/checkins` | Mis check-ins (`?eventId=`) |
| POST | `/api/me/checkins` | `{ sessionCode: "bog:0:2", method?: "qr"\|"nfc"\|"manual" }`: +40 XP. 403 si no está inscrito |
| GET | `/api/me/missions` | Misiones de mi industria, comunes y grupales, con su estado |
| POST | `/api/me/missions/:code/complete` | Completa la misión y suma su XP |
| GET | `/api/me/dossiers` | Todos mis dossiers |
| GET / POST | `/api/me/dossiers/:eventId` | Lee o genera el dossier. `POST { ideas?, plan?, notes? }`; sesiones, contactos y XP los calcula el servidor |

</details>

<details>
<summary><b>Red: conexiones, QR dinámico, cafés y chat</b></summary>

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/me/connections` | Mis conexiones (`?status=pending\|accepted`) |
| POST | `/api/me/connections` | `{ contactId \| name, source?: "request"\|"match"\|"qr", context?, eventId? }`. Por QR queda aceptada y suma +100 XP |
| PATCH | `/api/me/connections/:id` | `{ status: "accepted" }`: acepta una solicitud y suma +100 XP (una sola vez por contacto) |
| DELETE | `/api/me/connections/:id` | Quita la conexión. La XP ganada se conserva |
| GET | `/api/me/qr-token` | `?eventId=` → `{ token, expiresAt, ttl, refreshIn }`: token HMAC (`QR_SECRET`) de un solo uso que caduca en `QR_TTL_S` s. 403 sin el permiso `network` |
| POST | `/api/me/connections/scan` | `{ token, context? }`: conexión aceptada en ambos sentidos y +100 XP a cada uno una vez. 201 nueva, 200 ya existía. 400 `invalid_qr`/`qr_expired`/`own_qr`, 409 `qr_used`, 429 |
| GET | `/api/me/coffees` | Cafés 1:1 donde participo (`?status=proposed\|accepted\|declined\|done\|cancelled`), con `role`, `connectionId` y `with` |
| POST | `/api/me/coffees` | `{ connectionId, slot (ISO, futuro), place?, eventId? }`. 403 `not_connected`, 409 `coffee_active` |
| PATCH | `/api/me/coffees/:id` | `{ status: "accepted"\|"declined"\|"done"\|"cancelled" }`. Aceptar suma +50 XP a cada participante con cuenta, una vez. 409 `invalid_transition` |
| GET | `/api/me/messages/:connId` | Chat, del más antiguo al más reciente (`?limit=30&before=<nextCursor>`). Marca como leídos los recibidos |
| POST | `/api/me/messages/:connId` | `{ body }` (1–2000 caracteres). 403 `not_connected` |

</details>

<details>
<summary><b>IA y tiempo real</b></summary>

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/ai/chat` | AI Concierge. `{ message, history?, eventId?, day?, lang? }` → `{ reply, sources }`. La agenda del día (variante de la industria) y los speakers van en el prompt; `sources` lista las sesiones citadas |
| POST | `/api/ai/simulate` | Simulador de networking. `{ contactId \| contactName, message, history?, lang? }` → `{ reply }` en la voz del contacto |
| POST | `/api/ai/dossier` | `{ eventId, lang? }` → `{ dossier }` con `content.generatedBy: "ai"` y `content.paraTi`, a partir de check-ins, conexiones y XP reales |
| GET | `/api/me/stream` | Server-Sent Events del usuario (`connection.request`, `connection.accepted`, `message.new`, `coffee.updated`) |

</details>

---

## IA (Claude)

- `src/lib/ai.js` usa el SDK oficial `@anthropic-ai/sdk` con `AI_MODEL` (por defecto `claude-opus-5-5`), un solo reintento y `AI_TIMEOUT_MS` por intento. Activa el *server-side fallback* de Anthropic (`fallbacks: "default"`): si el modelo declina por seguridad, la API reintenta con un modelo de respaldo en la misma llamada.
- **Siempre degrada con gracia:** sin `AI_API_KEY`, con el proveedor caído, un timeout o un rechazo, los tres endpoints responden `503 { error: "ai_unavailable" }` y el frontend usa su contenido local. El resto de la API no se ve afectado.
- **Límites:** `AI_RATE_LIMIT` peticiones por usuario y minuto (429 `rate_limited`). `history` admite 12 turnos de hasta 2000 caracteres; `message`, 1000 (600 en el simulador). Exigen sesión y la versión legal vigente.
- **Privacidad:** al proveedor solo va lo que cubren los permisos del usuario (`aiProfile()` en `src/lib/queries.js`): nombre de pila y cargo; industria, seniority y empresa con `industry`; intereses con `interests`; las conexiones del dossier con `network`. Nunca correo, id ni foto. La key no aparece en logs ni en respuestas.

---

## Tiempo real (SSE)

`GET /api/me/stream` mantiene abierta una respuesta `text/event-stream`. Cada evento lleva `id`, `event` (tipo) y `data` (JSON con `at` y el objeto afectado).

```js
// En el navegador: EventSource no envía headers, así que el token va en la query
const es = new EventSource(`${API_URL}/api/me/stream?access_token=${accessToken}`);
es.addEventListener("connection.accepted", (e) => console.log(JSON.parse(e.data)));
```

| Tema | Comportamiento |
|---|---|
| Eventos | `connection.request` y `connection.accepted`, `message.new` (`{ connectionId, message }`, con el `connectionId` de quien lo recibe) y `coffee.updated` (`{ coffeeId, status }`, a los dos participantes) |
| Heartbeat | Un comentario `: ping` cada `SSE_HEARTBEAT_MS` para que proxies y balanceadores no corten la conexión |
| Reanudación | `EventSource` reconecta solo (`retry: 5000`) con `Last-Event-ID`; la API reenvía lo que siga en el buffer (100 eventos por usuario, 5 min). También acepta `?lastEventId=` |
| Token | Se valida al conectar. Al reconectar con uno vencido responde 401 y el cliente abre el stream con uno nuevo. En desarrollo también sirve `?userId=<uuid>` |
| Varias instancias | Con `EVENTS_PG_NOTIFY=true` cada evento sale por `NOTIFY knet_events` y todas las instancias lo reciben con `LISTEN` |

> [!NOTE]
> **¿Por qué no WebSockets?** SSE alcanza mientras el tiempo real sea solo servidor → cliente (las acciones siguen por REST). Si hace falta un canal bidireccional (p. ej. «escribiendo…» en el chat), se puede migrar reutilizando el mismo bus.

---

## Modelo de datos

Cinco migraciones en `db/migrations/`: `001_init`, `002_user_erasure`, `003_auth`, `004_coffees_messages` y `005_qr_nfc`.

```mermaid
erDiagram
    users ||--o{ user_scopes : permisos
    users ||--o{ consents : "cadena SHA-256"
    users ||--o{ refresh_tokens : sesiones
    users ||--o{ registrations : inscripciones
    users ||--o{ checkins : asistencia
    users ||--o{ mission_progress : misiones
    users ||--o{ xp_ledger : XP
    users ||--o{ connections : red
    users ||--o{ dossiers : dossier
    events ||--o{ event_days : dias
    events ||--o{ speakers : speakers
    events ||--o{ sessions : agenda
    connections ||--o{ coffees : cafes
    connections ||--o{ messages : chat
    contacts ||--o{ connections : catalogo
```

| Grupo | Tablas |
|---|---|
| **Perfil** | `users` (con `password_hash`, `linkedin_sub`, `legal_version`, `email_verified_at`, `photo_url`), `user_scopes` (permisos MCP) y `consents` (cadena SHA-256, solo inserción) |
| **Sesiones** | `refresh_tokens` (SHA-256 del token y familia de rotación), `oauth_states` (state de LinkedIn, un solo uso) y `auth_handoffs` (código de canje) |
| **Catálogo** | `industries`, `events`, `event_days`, `speakers` y `sessions` (`code` = `evento:día:slot`, como en el frontend) |
| **Progreso** | `registrations`, `checkins` (con `totem_id` si fue por NFC), `missions`, `mission_progress` y `xp_ledger` (cada XP queda registrado y no se puede sumar dos veces; `users.xp` guarda el total) |
| **Red** | `contacts` (matches por industria y asistentes de `SUMMIT_POOL`) y `connections`, que apuntan a un contacto (`contact_id`) o a otro usuario (`peer_user_id`); entre usuarios reales hay dos filas espejo |
| **Cafés y chat** | `coffees` (`invitee_id` NULL si el invitado es del catálogo) y `messages` (un hilo entre usuarios reales reúne las dos filas espejo) |
| **QR/NFC** | `qr_nonces`: cada token QR se usa una vez y se purga al caducar |
| **Dossier** | `dossiers` (contenido `jsonb` por usuario y evento) |

**Notas de diseño**

- **Seed:** `db/data/` es una copia de `src/data/` del frontend (`events`, `gamification`, `industries`, `privacy`, `venues`). Si el frontend los cambia, cópialos aquí y corre `npm run db:seed`.
- **Agenda:** el día 1 de `bog` tiene la agenda curada de cada industria (`IND[*].agenda`). Las demás sesiones se siembran por industria con `generateAgenda()` (`src/lib/agenda.js`), port de `sessionsFor()`: mismos códigos, títulos, horas, salas y `why`. Hay además una variante genérica (`industry` NULL) para usuarios sin industria. `npm run parity` verifica que coincidan.
- **Consentimientos:** el frontend envía cada evento a `POST /api/me/consents` (`details` lleva el registro local con su `idLocal` y `hashLocal`). Si la API no responde, queda pendiente en el navegador y se reenvía en orden. La cadena del servidor es propia, independiente de la del navegador.
- **Supresión y retención:** `DELETE /api/me` borra el usuario y el resto cae por `ON DELETE CASCADE`. `consents.user_id` pasa a `NULL` (el trigger de solo inserción permite únicamente ese cambio) y `consents.subject_id` conserva el UUID, que es el que entra en el hash, así que la cadena sigue siendo verificable. El registro queda **desvinculado, no anonimizado**: es la prueba de la autorización (Ley 1581, art. 17) durante el periodo de retención.
- **Niveles:** `floor(xp / 500) + 1`, con 5 como máximo (`src/lib/levels.js`), igual que el frontend.
- **Cambios de esquema:** agrega `db/migrations/006_<descripcion>.sql` (o el siguiente número). Nunca edites una migración ya aplicada, y escríbelas **aditivas**: en producción la API nueva y la migración se despliegan a la vez.

---

## Pruebas y CI

| Qué | Dónde | Cuándo |
|---|---|---|
| Smoke de todos los endpoints | `scripts/smoke.js` | Local (`npm run smoke`) y CI |
| IA con proveedor simulado | `scripts/ai-mock.js` | Local y CI |
| OAuth de LinkedIn simulado | `scripts/linkedin-mock.js` | Local y CI |
| SSE (memoria y LISTEN/NOTIFY) | `scripts/stream-test.js` | Local y CI |
| Paridad de la agenda con el frontend | `scripts/agenda-parity.js` | Local (`npm run parity`) |
| Imagen Docker: migra y responde `/health` | job `docker` de `ci.yml` | CI |

**CI** (`.github/workflows/ci.yml`, en cada PR y en cada push a `main`): instala, migra y carga el seed contra un PostgreSQL de servicio, arranca la API y corre `smoke`, `test:ai`, `test:linkedin` y `test:stream` (también con LISTEN/NOTIFY). Otro job construye la imagen y comprueba que migra y responde 200 en `/health`. El frontend tiene además una suite E2E contra este backend (`npm run e2e:real`).

---

## Despliegue

### Producción actual: Vercel + Neon

```mermaid
flowchart LR
    PR[Pull request] -->|preview| V[Vercel]
    M[Merge a main] --> V2[Vercel<br/>producción]
    M -->|si cambia db/**| GA[GitHub Action<br/>db-migrate.yml]
    GA -->|db:migrate + db:seed| N[(Neon)]
    V2 --> N
```

- **API:** https://knet-backend.vercel.app (proyecto `knet-backend`). `api/index.js` exporta la app de Express como Vercel Function y `vercel.json` reescribe todas las rutas hacia ella; `.vercelignore` evita subir `.env*`.
- **Base de datos:** Neon (`knet-db`, región `iad1`), conectada con la integración de Vercel, que define `DATABASE_URL` y `DATABASE_URL_UNPOOLED`.
- **Deploys:** el repositorio está conectado a Vercel. Cada push a `main` despliega producción y cada PR tiene su preview. A mano: `npx vercel deploy --prod`.
- **Migraciones:** Vercel no las aplica. Las corre `.github/workflows/db-migrate.yml` en cada push a `main` que toque `db/**` (o `src/lib/agenda.js`): `npm run db:migrate` y luego `npm run db:seed` contra Neon, con el secreto `NEON_DATABASE_URL_UNPOOLED` (= `DATABASE_URL_UNPOOLED` de Vercel). También se lanza a mano desde Actions (*Run workflow*).
- **Variables en Vercel:** `JWT_SECRET`, `AI_API_KEY`, `LINKEDIN_CLIENT_SECRET`, `QR_SECRET` y `TOTEM_SECRET` (sensibles), `TRUST_PROXY=1`, `LEGAL_VERSION`, `CORS_ORIGIN=https://knet-frontend.vercel.app`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_REDIRECT_URI` y el resto de valores de `.env.example`.
- **Límites:** `/api/me/stream` se corta a los 300 s y el cliente reconecta con `Last-Event-ID`. El bus de eventos y los rate limits viven en memoria por instancia.

### Contenedor (cualquier otra plataforma)

Imagen multi-stage (Node 22 Alpine, usuario `node` sin privilegios, solo dependencias de producción):

```bash
docker build -t knet-api .
docker run -p 4000:4000 --env-file .env.production knet-api
```

- Al arrancar aplica las migraciones pendientes (`docker-entrypoint.sh`). Para correrlas en un job previo, define `RUN_MIGRATIONS=false`.
- Healthcheck: `GET /health` (200 con la base arriba, 503 si no).
- Mínimo en producción: `NODE_ENV=production`, `DATABASE_URL` con SSL (`?sslmode=require` y `DATABASE_SSL`), `CORS_ORIGIN` con el dominio del frontend, `JWT_SECRET`, `TRUST_PROXY=1` detrás del balanceador y, si se usan, las de LinkedIn, IA y tótems. `LINKEDIN_REDIRECT_URI` debe apuntar al dominio público de la API.
- El frontend se construye con `VITE_API_URL` = URL pública de la API, y ese origen va en `CORS_ORIGIN`.
- Sirve en Render, Railway, Fly.io, Cloud Run, Azure Container Apps… con un PostgreSQL 16 gestionado.

---

## Hoja de ruta

- [x] Cuentas con contraseña, JWT con refresh rotatorio y Sign In with LinkedIn (OIDC).
- [x] Re-aceptación legal y cadena de consentimientos con derecho de supresión.
- [x] IA con Claude: Concierge (RAG con la agenda personalizada), Simulador y Dossier.
- [x] Agenda personalizada por industria para todos los eventos y días.
- [x] Cafés 1:1, chat directo, QR dinámico y check-in NFC.
- [x] Tiempo real (SSE) con reanudación y LISTEN/NOTIFY.
- [x] Docker, CI, despliegue en Vercel + Neon y migraciones automáticas.
- [ ] Verificación de correo y recuperación de contraseña (requiere un proveedor de correo).
- [ ] Endpoint de administración para que el Responsable consulte y exporte el registro de consentimientos de todos los usuarios.
- [ ] Purga controlada de los consentimientos desvinculados al vencer el periodo de retención.
- [ ] Guardar en la base el chat del Concierge, las notificaciones y las recompensas del avatar.
- [ ] Importar cargo y empresa de LinkedIn (requiere productos de LinkedIn fuera de OpenID Connect, solo para partners).

> Las cuentas demo son compartidas, así que `DELETE /api/me` las rechaza a propósito. Con el login real ya no se usan fuera de desarrollo.

---

## Equipo

| | Integrante | Rol | Enlaces |
|---|---|---|---|
| <img src="https://raw.githubusercontent.com/KNET-Team-Acc/knet-frontend/main/src/assets/team/anderssonprogramming.webp" width="56"> | **Andersson David Sánchez Méndez** | Custom Software Engineering New Associate · Arquitectura de IA & Backend | [GitHub](https://github.com/AnderssonProgramming) · [LinkedIn](https://www.linkedin.com/in/anderssonsm/) |
| <img src="https://raw.githubusercontent.com/KNET-Team-Acc/knet-frontend/main/src/assets/team/killerzeus666.webp" width="56"> | **Katheryn Sofia Guasca Chavarro** | Infra Managed Service New Associate · Infraestructura, DevOps & Cloud | [GitHub](https://github.com/Killerzeus666) · [LinkedIn](https://www.linkedin.com/in/katheryn-sof%C3%ADa-guasca-chavarro-73a93b35a/) |
| <img src="https://raw.githubusercontent.com/KNET-Team-Acc/knet-frontend/main/src/assets/team/pbclaro96.webp" width="56"> | **Paola de Jesús Barros Claro** | Infra Managed Service New Associate · Frontend, Gamificación & Integración | [GitHub](https://github.com/pbclaro96) · [LinkedIn](https://www.linkedin.com/in/paola-de-jes%C3%BAs-barros/) |

---

## Licencia

Código bajo licencia [MIT](LICENSE) © 2026 KNET Team.

<p align="center"><sub>© 2026 Equipo KNET · API de KNET</sub></p>
