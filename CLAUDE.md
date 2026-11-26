# KNET backend

API REST de KNET. Express 5 + PostgreSQL 16 (Docker, host **5433** → contenedor 5432). API en **:4000**. Frontend en `../knet-frontend` (CORS `http://localhost:5173`). Detalle de endpoints y esquema: `README.md`.

## Carpetas
- `db/migrations/` — SQL numerado (`001_init.sql`, `002_user_erasure.sql`, `003_auth.sql`, `004_coffees_messages.sql`, `005_qr_nfc.sql`). Nunca edites una migración aplicada: agrega la siguiente (`006_...`).
- `db/data/` — copia de `src/data/` del frontend para el seed (si el frontend cambia, recopiar y `db:seed`). Solo datos reales: lo ficticio va en `db/fixtures/demo.js`.
- `src/` — `app.js`, `config.js`, `db.js` (`query`, `tx`), `middleware/` (`user.js`: Bearer JWT; `X-User-Id`/demo solo en desarrollo), `lib/` (`ai.js`, `auth.js`, `dossier.js`, `events-bus.js`, `consents.js`, `xp.js`, `levels.js`, `serialize.js`, `http.js`, `threads.js`, `qr.js`, `checkins.js`, `agenda.js`), `routes/` (`auth.js` público; `totem.js` con `X-Totem-Key`; `ai.js`; `me/*` = rutas del usuario).

## Comandos
- `npm run dev` (con `--watch`) / `npm start` (sin watch: reiniciar tras cambios)
- `npm run db:migrate` — aplica migraciones pendientes
- `npm run db:seed` — catálogo real (retira eventos fuera de `EVENTS` moviendo lo del usuario a `EV_ALIAS`, y quita los contactos ficticios). Es el de producción
- `npm run db:seed:demo` — catálogo + fixtures de `db/fixtures/demo.js` (usuarios `demo.*`, matches y asistentes del QR); los necesitan smoke, `test:ai` y `test:stream`
- `npm run db:reset` — borra el esquema y reseedea (solo desarrollo)
- `npm run smoke` — prueba la API en marcha (`API_URL` para otro puerto). Deja usuarios borrados con consentimientos desvinculados: es a propósito.
- `npm run test:ai` — `/api/ai/*` con el proveedor simulado (no gasta tokens; solo necesita la BD).
- `npm run test:stream` — SSE de `/api/me/stream` (solo necesita la BD; `EVENTS_PG_NOTIFY=true` prueba LISTEN/NOTIFY).
- `npm run test:linkedin` — flujo OAuth de LinkedIn con los endpoints de LinkedIn simulados (solo necesita la BD).
- `npm run parity` — paridad de la agenda con `sessionsFor()` del frontend (`FRONTEND_DIR`, por defecto `../knet-frontend`); si la API está en marcha, compara también lo sembrado

## Reglas
- Nivel = `floor(xp / 500) + 1`, máximo 5 (`src/lib/levels.js`), igual que el frontend.
- XP: solo con `awardXp()` dentro de `tx()`. `xp_ledger` es un libro de solo inserción (`UNIQUE (user_id, reason, ref)` evita doble suma); no hagas UPDATE/DELETE sobre él (no hay trigger: es convención). `users.xp` es la caché del total.
- `consents`: trigger append-only. Única excepción: `user_id → NULL` por `ON DELETE SET NULL`. El hash usa `subject_id` (UUID del titular sin FK), no `user_id`; `verifyChain()` recalcula con `subject_id`. Agregar eventos solo con `appendConsent()`. `supresion` solo la registra el servidor.
- `DELETE /api/me`: exige identificación explícita (`req.authVia` = `jwt` o `header`; 400 con el demo por defecto), rechaza `is_demo` con 403 `demo_account`, registra `supresion` y borra el usuario en una transacción (CASCADE en progreso; consents se conservan desvinculados, no anonimizados). El borrado diferido (offline) lo maneja el frontend reintentando.
- Identidad: `resolveUser()` acepta `Authorization: Bearer`. Solo con `NODE_ENV=development` acepta `X-User-Id` y, sin nada, el demo compartido (`DEMO_USER_EMAIL`, sembrado por `db:seed:demo`; sin él, `/api/events` y `/api/contacts` responden como anónimo): nunca lo borres ni lo ensucies en pruebas (el smoke usa `demo.energia@knet.local`). `/api/events` y `/api/contacts` usan `resolveUser({ optional: true })` (`req.user` puede ser `null`).
- Auth: refresh tokens solo como SHA-256 (`refresh_tokens`); reutilizar uno revocado revoca su familia (`rotateRefreshToken` confirma esa revocación antes de responder 401). Nunca registres tokens ni secretos en logs.
- Legal: `legal_version < LEGAL_VERSION` (o NULL, salvo demo) → 409 `legal_outdated` en `/api/me/*` menos `consents` y `DELETE /api/me`. Una `aceptacion` con `terminos` y `privacidad` en la versión vigente lo actualiza. `LEGAL_VERSION` debe ser igual a `LEGAL.version` del frontend.
- Agenda: `src/lib/agenda.js` es un port de `sessionsFor()` del frontend (día 0 de `MAIN_EV` = agenda curada) y el seed lo usa para sembrar una variante por industria. Si el frontend cambia sus plantillas, actualiza el port y corre `npm run parity`.
- Comentarios y mensajes de error en español.
- Conexiones: `contact_id` (catálogo) o `peer_user_id` (usuario real, dos filas espejo A→B y B→A). Cafés y mensajes pasan siempre por `resolveThread()` (`src/lib/threads.js`): 404 si la conexión no es del usuario, 403 `not_connected` si no está aceptada por ambos lados. XP de café: `awardXp(..., "coffee", "coffee:<id>")` a cada participante con cuenta.
- QR/NFC: tokens `knet1.<payload>.<hmac>` solo con `signQrToken()`/`verifyQrToken()` (`src/lib/qr.js`); gasta el nonce con `consumeNonce()` dentro de la misma `tx()` que crea la conexión o el check-in. `QR_SECRET` vacío = derivado de `JWT_SECRET`; `TOTEM_SECRET` vacío fuera de desarrollo = NFC desactivado (503). Los check-ins (app y tótem) pasan por `recordCheckin()` (`src/lib/checkins.js`).
- IA: solo por `generate()` (`src/lib/ai.js`, SDK `@anthropic-ai/sdk`, `AI_MODEL` = `claude-opus-5-5`). Cualquier fallo → 503 `ai_unavailable` (el frontend tiene fallback). Lo que va al proveedor pasa por `aiProfile()` y respeta `user_scopes`; nunca correo, id ni la key en logs.
- Tiempo real: publica con `publish(userId, tipo, data)` (`src/lib/events-bus.js`) **después** de confirmar la transacción; tipos en `EVENT_TYPES`. `/api/me/stream` acepta `?access_token=` porque EventSource no envía headers.
- Despliegue: `Dockerfile` + `docker-entrypoint.sh` (migra al arrancar salvo `RUN_MIGRATIONS=false`); variables en `.env.production.example`. El CI (`.github/workflows/ci.yml`) corre smoke y todos los `test:*`: mantenlos verdes.
- Vercel: `api/index.js` + `vercel.json` (todas las rutas → la función). Producción: https://knet-backend.vercel.app con Neon (`DATABASE_URL`). Las migraciones las aplica `.github/workflows/db-migrate.yml` al llegar a `main` un cambio en `db/**` (secreto `NEON_DATABASE_URL_UNPOOLED`); como Vercel despliega en paralelo, escríbelas aditivas (que el código anterior siga funcionando).
