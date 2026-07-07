# API y Configuración de WhatsApp — Sistema de Grabado Láser

Fecha: 22/12/2025

## Resumen

Este documento describe cómo está configurado el bot de WhatsApp y la API HTTP que expone el servidor del Sistema de Grabado Láser. Incluye:

- Variables de configuración (env y archivos) y sus valores por defecto.
- Flujo de autenticación de WhatsApp (QR, reconexión, estados).
- Cómo se procesan y almacenan los mensajes (deduplicación, hints, persistencia).
- Esquema de base de datos (SQLite) y entidades.
- Endpoints REST y SSE con sus parámetros y respuestas.

Backend principal: `server.js` (Node.js + Express). Persistencia: `laser_engraving.db` (SQLite). Integración WhatsApp: `whatsapp-web.js` con `LocalAuth`.

## Arquitectura — en breve

- Servidor HTTP (Express) en `http://localhost:3000`.
- Cliente de WhatsApp (`whatsapp-web.js`):
  - Autenticación local (carpetas `.wwebjs_auth/` y `.wwebjs_cache/`).
  - Eventos: `qr`, `ready`, `auth_failure`, `disconnected`, `message`.
- Base de datos SQLite (`laser_engraving.db`) con tablas: `lotes`, `pieces`, `lot_metrics`, `sync_log`.
- UI web: `public/sistema_de_grabado_laserv1.html` (consume `/status`, `/qr`, `/events`, `/api/*`).
- Compatibilidad legacy opcional con carpeta `to_engrave` (archivos JSON), desactivada por defecto.

## Configuración

Archivo `.env` o `server.env` (raíces relevantes):

- `RESET_PASSWORD` (string, obligatorio): contraseña para proteger `POST /api/reset`.
- `TO_ENGRAVE_DIR` (string, opcional): ruta a la carpeta de cola/legado. Si no se define:
  1. Intenta usar red: `\\ociserver\INNOVAX\AREA DE TRABAJO\6.- ENSAMBLE\Nueva carpeta` si existe.
  2. Fallback local: `<repo>/to_engrave`.
- `WRITE_TO_ENGRAVE_FILES` (boolean, default: `false`): si `true`, además de BD escribe JSON legacy en `TO_ENGRAVE_DIR`.
- `WHATSAPP_INBOX_LOT_ID` (string, default: `lotes`): lote destino de registros entrantes.
- `WHATSAPP_INBOX_LOT_NAME` (string, default: `LOTES`): nombre del lote destino.
- `ALLOWED_GROUPS_JSON` (JSON string, opcional): sobrescribe whitelist de grupos/contactos.
- `BOT_NUMBER` (string, opcional): número del bot; suele detectarse automáticamente en `ready`.

Archivos de configuración:

- `allowed_groups.json` (junto a `server.env` en desktop o en la raíz del proyecto en modo manual): diccionario `{ "<jid_o_numero>": "<nombre>" }`.
  - Ejemplos válidos: `"12036...@g.us"` (grupo), `"521XXXXXXXXXX@c.us"` (contacto), o solo `"521XXXXXXXXXX"`.
  - Si está vacío y no existe `ALLOWED_GROUPS_JSON`, se aceptan mensajes de cualquier grupo/contacto.
- `tokens.json`, `allowed_users.json`: legacy no utilizados (gestión de usuarios/tokens eliminada).

## Flujo de autenticación de WhatsApp

- Al iniciar el servidor, se inicializa `Client({ authStrategy: new LocalAuth(), puppeteer: { headless: true } })`.
- Eventos clave:
  - `qr`: se genera QR y se expone como DataURL en `GET /qr`.
  - `ready`: autenticado; se intenta detectar `BOT_NUMBER` y se marca `isAuthenticated=true`.
  - `auth_failure` / `disconnected`: se limpian estados y se intenta re-inicializar.
- Endpoints útiles:
  - `GET /qr`: `{ qr: <dataURL|null> }`.
  - `GET /status`: `{ authenticated: boolean, registros: [...], engraveCount: number }`.
  - `POST /force-reconnect`: destruye e inicializa el cliente para forzar un nuevo QR.
  - `POST /stop-client`: detiene el cliente de WhatsApp sin cerrar el proceso Node.

## Procesamiento de mensajes entrantes

- Filtro de grupo/contacto (opcional):
  - Si `allowed_groups.json` o `ALLOWED_GROUPS_JSON` tienen entradas, sólo se aceptan mensajes desde esos JIDs/números. Si no, se aceptan todos.
- Detección de duplicados:
  - Por `messageId` (TTL 5 min): evita procesar el mismo mensaje más de una vez.
  - Por firma de contenido (15 s): `numParte | cantidad | imagen[:80]` — previene duplicados casi simultáneos.
- Hints por chat (TTL 10 min): combina mensajes consecutivos del mismo chat (por ejemplo, imagen o "16pz") con un mensaje posterior que contenga el número de parte.
- Parseo:
  - Número de parte: patrón flexible alfanumérico con separadores `-_/`.
  - Cantidad: número después del número de parte, o detección de sufijos tipo `16pz`, `16 pzas`.
- Almacenamiento:
  - Siempre se guarda en BD (tabla `pieces`), con `lot_id=WHATSAPP_INBOX_LOT_ID`.
  - Si `WRITE_TO_ENGRAVE_FILES=true`, también se escribe JSON legacy en `TO_ENGRAVE_DIR` (nombre `engrave_<fecha>_<parte>.json`).
  - Mensajes sin número de parte se guardan como genéricos (`partNumber=''`, `quantity=0`, `metadata.rawMessage`).
- Respuesta automática: el bot responde por WhatsApp con confirmación (pieza, cantidad, origen de guardado y si se combinó con hints).

Importación de legacy al iniciar:

- Si existen `*.json` en `TO_ENGRAVE_DIR`, se importan a BD para unificar fuente de verdad. Evita duplicados por `messageId`.

## Base de datos (SQLite)

Archivo: `laser_engraving.db`. Esquema principal:

- `lotes`
  - `id` (PK, TEXT)
  - `name` (TEXT)
  - `process` (TEXT, default `all`)
  - `metadata` (JSON)
  - `created_at`, `updated_at`
- `pieces`
  - `uid` (PK, TEXT)
  - `lot_id` (FK → `lotes.id`)
  - `partNumber` (TEXT)
  - `quantity` (INTEGER)
  - `incidents` (INTEGER)
  - `incidentType` (TEXT)
  - `timestamp` (DATETIME)
  - `imagen` (BLOB/Base64)
  - `sourceFile` (TEXT)
  - `clientId` (TEXT, UNIQUE)
  - `messageId` (TEXT, UNIQUE)
  - `proceso` (TEXT)
  - `metadata` (JSON)
- `lot_metrics`
  - `lot_id` (UNIQUE)
  - `metric_type` (TEXT) — ejemplos: `laser`, `pavonado`
  - `data` (JSON)
- `sync_log` (auditoría/sincronización)

Notas:

- En el reset se preserva/asegura el lote `lotes` (`WHATSAPP_INBOX_LOT_ID`).
- `getPiecesInLotPaged` soporta paginación y búsqueda (usado en `/engrave-list`).

## Endpoints HTTP

Rutas principales expuestas por `server.js`:

- UI

  - `GET /`: sirve `public/sistema_de_grabado_laserv1.html`.

- WhatsApp/Estado

  - `GET /qr`: QR en base64 si disponible.
  - `GET /status`: estado `{ authenticated, registros, engraveCount }`.
  - `POST /force-reconnect`: fuerza nuevo QR.
  - `POST /stop-client`: detiene el cliente de WhatsApp.

- Ingreso de piezas / Cola

  - `POST /enqueue`
    - Body: `{ numParte: string, numPiezas|piezas|cantidad?: number|string, imagen?: string(base64), clientId?: string, messageId?: string }`.
    - Respuesta: `{ ok: true, uid, clientId }`. Si `messageId` ya se procesó: `{ ok: true, skippedDuplicate: true, messageId }`.
  - `GET /engrave-list`
    - Query: `page` (int, default 0), `pageSize` (int, default 500, máx 5000), `search` (string opcional).
    - Respuesta: `{ data: [ { filename, content: { uid, numParte, numPiezas, fecha, imagen, messageId, rawMessage } } ], pagination: { page, pageSize, totalRegistros, totalPages, hasMore } }`.
  - `GET /engrave/:file`: entrega archivo o imagen de `TO_ENGRAVE_DIR` (con protección de traversal).
  - `POST /engrave/clear-part`
    - Body: `{ filename: string }` — limpia `numParte` en el JSON legacy indicado.
  - `POST /engrave/delete`
    - Body: `{ filename?: string|uid, messageId?: string }`.
    - Borra por `uid` en BD si no termina en `.json`; si no, elimina archivo legacy y su imagen asociada.

- SSE (tiempo real)

  - `GET /events`: Server-Sent Events. Emite eventos `data: { type: 'nuevo-registro', registro }` al registrar piezas o importar.

- Información/Inventario (legacy/read-only)

  - `GET /info-excel`: resumen de archivos `*.json` en `TO_ENGRAVE_DIR`.
  - `GET /inventario`: listado transformado de `*.json` legacy (si existen).

- API de Base de Datos (CRUD)

  - `GET /api/lotes`: devuelve todos los lotes con piezas y métricas agregadas.
  - `POST /api/lotes`: crear/actualizar lote. Body: `{ id, name, process?, metadata? }`.
  - `DELETE /api/lotes/:id`: elimina un lote (cascada a sus piezas).
  - `POST /api/pieces`: guarda/actualiza pieza. Body mínimo: `{ uid, lot_id, ... }`.
  - `GET /api/lotes/:id/pieces`: piezas de un lote específico.
  - `DELETE /api/pieces/:uid`: elimina una pieza por `uid`.
  - `POST /api/lotes/:id/metrics`: guarda métricas del lote. Body: `{ metric_type, data }`.
  - `GET /api/lotes/:id/metrics`: obtiene métricas del lote.
  - `POST /api/sync`: importa estructura completa `{ laserGrabadoData }` (piezas y métricas) a BD.
  - `GET /api/export`: exporta estado completo `{ [lotId]: { name, process, pieces, laserMetrics, pavonadoMetrics, metadata } }`.

- Reset de datos (protegido)
  - `POST /api/reset` (requiere contraseña)
    - Body: `{ password: string, deleteFiles?: boolean }`.
    - Efecto: borra tablas (`pieces`, `lot_metrics`, `sync_log`) y lotes excepto `lotes` (lo recrea y normaliza). Opcionalmente elimina `*.json` en `TO_ENGRAVE_DIR`.

## Seguridad y buenas prácticas

- Definir `RESET_PASSWORD` y `AUTH_SECRET` antes de producción.
- Usar `allowed_groups.json` o `ALLOWED_GROUPS_JSON` para permitir sólo grupos/contactos autorizados (si lo requiere la operación).
- `GET /events` limita a 200 clientes SSE concurrentes.
- Sanitización de rutas de archivo y protección de traversal están activas en `/engrave/:file`.

## Puesta en marcha rápida

1. Instalar dependencias (ya incluidas en `package.json`).
2. Configurar `.env` (al menos `RESET_PASSWORD`).
3. Arrancar el servidor.

Ejemplo (PowerShell):

```powershell
node server.js
```

Abrir `http://localhost:3000` en el navegador para ver la UI y, si es necesario, escanear el QR desde el móvil (o consultar `GET /qr`).

## Preguntas frecuentes

- ¿Dónde se guardan las piezas? Siempre en SQLite (`pieces`), lote `WHATSAPP_INBOX_LOT_ID` — por defecto `lotes`.
- ¿Sigue siendo necesario `to_engrave`? No; es opcional para compatibilidad. Si activas `WRITE_TO_ENGRAVE_FILES=true`, además se escribe JSON.
- ¿Qué pasa si llegan mensajes sin número de parte? Se guardan como genéricos con `partNumber=''`, `quantity=0`, preservando `rawMessage` e imagen.
- ¿Cómo evito duplicados? Ya hay deduplicación por `messageId` (5 min) y por firma de contenido (15 s).

## Referencias de código

- Lógica de WhatsApp, endpoints y SSE: `server.js`.
- Acceso y esquema de BD: `db.js`.
- UI y consumo de API: `public/sistema_de_grabado_laserv1.html` y `public/app/services/server.js`.
