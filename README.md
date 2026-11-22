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
| `npm run smoke` | Prueba todos los endpoints contra la API en marcha |

PostgreSQL usa el puerto **5433** del host para no chocar con una instalación local en el 5432.
Para entrar a la consola: `docker exec -it knet-db psql -U knet`.

## Usuario actual

Todavía no hay login. Cada petición identifica al usuario con el header `X-User-Id: <uuid>`.
Sin ese header se usa el usuario demo `DEMO_USER_EMAIL` (por defecto `demo.tech@knet.local`).
Al terminar, `npm run db:seed` muestra los UUID de los 4 usuarios demo (`demo.banca`, `demo.tech`, `demo.consultoria`, `demo.energia`).

## Endpoints

Todas las respuestas son JSON. Los errores tienen la forma `{ "error": "code", "message": "…" }`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado de la API, de la base de datos y de las migraciones |
| GET | `/api/events` | Eventos (`?kind=real\|demo\|exclusive`, `?industry=tech`). Incluye `locked` y `registered` |
| GET | `/api/events/:id` | Detalle con ficha (`info`), recinto 3D (`venue`) y speakers |
| GET | `/api/events/:id/sessions?day=0` | Sesiones del día, en la variante de la industria del usuario, con `checkedIn` |
| GET | `/api/contacts` | Personas con las que se puede conectar (`?industry=`) |
| GET | `/api/me` | Perfil, XP, nivel, permisos, estadísticas e inscripciones |
| PATCH | `/api/me` | Edita `name`, `role`, `company`, `industry`, `seniority`, `location`, `interests`, `avatar` y `scopes` |
| GET | `/api/me/consents` | Registro de consentimientos, con la verificación de la cadena de hashes (`chain.valid`) |
| POST | `/api/me/consents` | `{ type, documents?, details? }`: agrega un registro a la cadena |
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
| GET | `/api/me/dossiers` | Todos mis dossiers |
| GET / POST | `/api/me/dossiers/:eventId` | Lee o genera el dossier del evento. `POST { ideas?, plan?, notes? }`; el resumen de sesiones, contactos y XP lo calcula el servidor |

Ejemplo:

```bash
curl http://localhost:4000/api/events/bog/sessions?day=0
curl -X POST http://localhost:4000/api/me/checkins -H "Content-Type: application/json" -d '{"sessionCode":"bog:0:0"}'
```

## Modelo de datos

`db/migrations/001_init.sql`:

- **Perfil:** `users`, `user_scopes` (permisos MCP) y `consents` (cadena SHA-256, solo inserción).
- **Catálogo:** `industries`, `events`, `event_days`, `speakers` y `sessions` (`code` = `evento:día:slot`, igual que en el frontend).
- **Progreso:** `registrations`, `checkins`, `missions`, `mission_progress` y `xp_ledger` (cada XP sumado queda registrado y no se puede sumar dos veces; `users.xp` guarda el total).
- **Red:** `contacts` (los matches de cada industria y los asistentes de `SUMMIT_POOL` que aparecen en el escaneo QR) y `connections`.
- **Dossier:** `dossiers` (contenido `jsonb` por usuario y evento).

Notas:

- **Datos del seed:** `db/data/` es una copia de los archivos de `src/data/` del frontend (`events`, `gamification`, `industries`, `privacy`, `venues`). Si el frontend los cambia, cópialos de nuevo aquí y corre `npm run db:seed`.
- La agenda del **día 1 de `bog`** tiene una variante por industria, como en el frontend (`IND[*].agenda`).
  Las demás sesiones son genéricas: usan las mismas plantillas que `sessionsFor()`, pero sin personalizarlas por perfil, así que los títulos pueden no coincidir con los que muestra el frontend hoy. Los códigos sí coinciden.
- El nivel se calcula igual que en el frontend: `floor(xp / 500) + 1`, con 5 niveles como máximo (`src/lib/levels.js`).
- Para cambiar el esquema, agrega `db/migrations/002_<descripcion>.sql`. No edites una migración que ya se aplicó.

## Pendiente

- Login real (LinkedIn OAuth o JWT) en lugar de `X-User-Id`.
- Pasar a la base de datos los DMs, el chat del Concierge, las notificaciones y las recompensas del avatar.
- Conectar los consentimientos del frontend (antes hay que actualizar el texto legal de la app).
- Guardar en el servidor la agenda personalizada por perfil (hoy las sesiones son genéricas salvo el día 1 de `bog`).
