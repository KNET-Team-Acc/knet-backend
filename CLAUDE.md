# KNET backend

API REST de KNET. Express 5 + PostgreSQL 16 (Docker, host **5433** → contenedor 5432). API en **:4000**. Frontend en `../knet-frontend/knet-frontend` (CORS `http://localhost:5173`). Detalle de endpoints y esquema: `README.md`.

## Carpetas
- `db/migrations/` — SQL numerado (`001_init.sql`, `002_user_erasure.sql`, `003_auth.sql`). Nunca edites una migración aplicada: agrega la siguiente (`004_...`).
- `db/data/` — copia de `src/data/` del frontend para el seed (si el frontend cambia, recopiar y `db:seed`).
- `src/` — `app.js`, `config.js`, `db.js` (`query`, `tx`), `middleware/` (`user.js`: Bearer JWT; `X-User-Id`/demo solo en desarrollo), `lib/` (`ai.js`, `auth.js`, `dossier.js`, `events-bus.js`, `consents.js`, `xp.js`, `levels.js`, `serialize.js`, `http.js`), `routes/` (`auth.js` público; `ai.js`; `me/*` = rutas del usuario).

## Comandos
- `npm run dev` (con `--watch`) / `npm start` (sin watch: reiniciar tras cambios)
- `npm run db:migrate` — aplica migraciones pendientes
- `npm run db:seed` — catálogo + usuarios demo
- `npm run db:reset` — borra el esquema y reseedea (solo desarrollo)
- `npm run smoke` — prueba la API en marcha (`API_URL` para otro puerto). Deja usuarios borrados con consentimientos desvinculados: es a propósito.
- `npm run test:ai` — `/api/ai/*` con el proveedor simulado (no gasta tokens; solo necesita la BD).
- `npm run test:stream` — SSE de `/api/me/stream` (solo necesita la BD; `EVENTS_PG_NOTIFY=true` prueba LISTEN/NOTIFY).
- `npm run test:linkedin` — flujo OAuth de LinkedIn con los endpoints de LinkedIn simulados (solo necesita la BD).

## Reglas
- Nivel = `floor(xp / 500) + 1`, máximo 5 (`src/lib/levels.js`), igual que el frontend.
- XP: solo con `awardXp()` dentro de `tx()`. `xp_ledger` es un libro de solo inserción (`UNIQUE (user_id, reason, ref)` evita doble suma); no hagas UPDATE/DELETE sobre él (no hay trigger: es convención). `users.xp` es la caché del total.
- `consents`: trigger append-only. Única excepción: `user_id → NULL` por `ON DELETE SET NULL`. El hash usa `subject_id` (UUID del titular sin FK), no `user_id`; `verifyChain()` recalcula con `subject_id`. Agregar eventos solo con `appendConsent()`. `supresion` solo la registra el servidor.
- `DELETE /api/me`: exige identificación explícita (`req.authVia` = `jwt` o `header`; 400 con el demo por defecto), rechaza `is_demo` con 403 `demo_account`, registra `supresion` y borra el usuario en una transacción (CASCADE en progreso; consents se conservan desvinculados, no anonimizados). El borrado diferido (offline) lo maneja el frontend reintentando.
- Identidad: `resolveUser()` acepta `Authorization: Bearer`. Solo con `NODE_ENV=development` acepta `X-User-Id` y, sin nada, el demo compartido (`DEMO_USER_EMAIL`): nunca lo borres ni lo ensucies en pruebas (el smoke usa `demo.energia@knet.local`). `/api/events` y `/api/contacts` usan `resolveUser({ optional: true })` (`req.user` puede ser `null`).
- Auth: refresh tokens solo como SHA-256 (`refresh_tokens`); reutilizar uno revocado revoca su familia (`rotateRefreshToken` confirma esa revocación antes de responder 401). Nunca registres tokens ni secretos en logs.
- Legal: `legal_version < LEGAL_VERSION` (o NULL, salvo demo) → 409 `legal_outdated` en `/api/me/*` menos `consents` y `DELETE /api/me`. Una `aceptacion` con `terminos` y `privacidad` en la versión vigente lo actualiza. `LEGAL_VERSION` debe ser igual a `LEGAL.version` del frontend.
- Comentarios y mensajes de error en español.
- IA: solo por `generate()` (`src/lib/ai.js`, SDK `@anthropic-ai/sdk`, `AI_MODEL` = `claude-opus-5-5`). Cualquier fallo → 503 `ai_unavailable` (el frontend tiene fallback). Lo que va al proveedor pasa por `aiProfile()` y respeta `user_scopes`; nunca correo, id ni la key en logs.
- Tiempo real: publica con `publish(userId, tipo, data)` (`src/lib/events-bus.js`) **después** de confirmar la transacción; tipos en `EVENT_TYPES`. `/api/me/stream` acepta `?access_token=` porque EventSource no envía headers.
- Despliegue: `Dockerfile` + `docker-entrypoint.sh` (migra al arrancar salvo `RUN_MIGRATIONS=false`); variables en `.env.production.example`. El CI (`.github/workflows/ci.yml`) corre smoke y todos los `test:*`: mantenlos verdes.
