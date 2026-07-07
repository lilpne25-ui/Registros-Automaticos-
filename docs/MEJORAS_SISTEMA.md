# Oportunidades de mejora — Sistema de Grabado Láser (WhatsApp)

Fecha: 22/12/2025

Este documento resume las funciones actuales del sistema y propone mejoras prácticas para hacerlo más robusto, seguro y escalable. Incluye quick wins, cambios estructurales y una hoja de ruta.

## Funciones actuales (resumen)

- Ingesta por WhatsApp (`whatsapp-web.js` + `LocalAuth`):
  - Eventos: `qr`, `ready`, `auth_failure`, `disconnected`, `message`.
  - Detección de duplicados (por `messageId` y por firma de contenido 15s).
  - Hints por chat (combina cantidad o imagen con el siguiente mensaje del mismo chat).
  - Filtro opcional por grupos/contactos (`allowed_groups.json` o `ALLOWED_GROUPS_JSON`).
- Persistencia (SQLite `laser_engraving.db`):
  - Tablas: `lotes`, `pieces`, `lot_metrics`, `sync_log`.
  - Guardado siempre en BD (JSON legacy opcional si `WRITE_TO_ENGRAVE_FILES=true`).
- API HTTP (Express):
  - Ingreso `/enqueue`, estado `/status`, QR `/qr`, SSE `/events`.
  - CRUD: `/api/lotes`, `/api/pieces`, `/api/lotes/:id/metrics`, `/api/export`, `/api/sync`.
  - Reset seguro `/api/reset` (password).
  - Cierre de mes (password):
    - `/api/reset-monthly-pavonado` y `/api/reset-monthly-all`.
    - Al ejecutarse guarda un _cutoff_ en BD (`system_kv.images_import_cutoff_iso`) para que la sincronización desde `TO_ENGRAVE_DIR\images` no reimporte archivos antiguos y los datos no “reaparezcan” tras reinicios.
  - Importación de archivos legacy al iniciar.
- UI (`public/sistema_de_grabado_laserv1.html`):
  - Carga inicial desde `/api/export` y `/engrave-list` (paginado).
  - Tiempos reales vía SSE, helpers de fecha, optimizaciones de render.

## Oportunidades de mejora (por área)

A continuación se indica, para cada grupo de mejoras, el beneficio principal y la prioridad (Alta > Media > Baja).

### 1) Robustez de WhatsApp y reintentos

- Beneficio: reduce caídas y duplicados si el cliente WA se desconecta o falla al bajar media; mejora continuidad operativa.
- Prioridad: **Alta**
- Exponencial backoff al reconectar tras `disconnected`/`auth_failure` (evita reconectar en bucle cada 1.5s).
- Health-check de cliente WA y watchdog que vuelve a iniciar si se queda en estado inconsistente.
- Cola persistente de eventos (por si el proceso cae durante la descarga de media); reintentar `downloadMedia()` con límites.
- Almacenar metadatos de chat (grupo/nombre) para trazabilidad y debugging.

### 2) Seguridad del backend

- Beneficio: protege datos y evita abuso de endpoints críticos; reduce superficie de ataque.
- Prioridad: **Alta**
- Añadir Helmet y saneamiento de cabeceras.
- Rate limiting (p. ej., `express-rate-limit`) en endpoints sensibles (`/enqueue`, `/api/reset`, `/engrave/delete`).
- Autorización para endpoints administrativos (API key o sesión con rol admin).
- Validación de entrada con un esquema (Joi/Zod) para `/enqueue`, `/api/*`.
- Validar `.env` al arranque (p. ej., con Zod) y fallar rápido si falta algo crítico.

### 3) Modelo de datos y rendimiento de SQLite

- Beneficio: consultas más rápidas y consistentes; permite múltiples métricas por lote; menos bloqueos.
- Prioridad: **Alta**
- Corrigir esquema de `lot_metrics`: actualmente `lot_id` es `UNIQUE`, impide guardar métricas por tipo (láser/pavonado) en el mismo lote. Propuesta:
  - Cambiar a `UNIQUE(lot_id, metric_type)`.
  - Migración segura: crear tabla nueva, copiar datos, renombrar.
- Índices:
  - `CREATE INDEX IF NOT EXISTS idx_pieces_lot_ts ON pieces(lot_id, timestamp DESC);`
  - `CREATE INDEX IF NOT EXISTS idx_pieces_part ON pieces(partNumber);`
  - `CREATE INDEX IF NOT EXISTS idx_pieces_msg ON pieces(messageId);` (ya UNIQUE, verificar).
- Activar WAL para concurrencia/estabilidad: `PRAGMA journal_mode=WAL;` al conectar.
- Mantenimiento: tareas de `VACUUM` programadas en horarios de menor uso.

### 4) API: contrato, paginación y documentación

- Beneficio: menos breaking changes, clientes más fiables, mejor rendimiento en datos grandes, y onboarding rápido.
- Prioridad: **Media-Alta**
- OpenAPI (Swagger) para toda la API; generar docs y colección para Postman.
- Input/output schemas compartidos (TypeScript/JSDoc) para reducir errores.
- `/api/lotes` puede crecer mucho; añadir parámetros `includePieces=false` por defecto, o paginar piezas por lote.
- `/api/export` grande: soportar streaming/chunked y filtros por fecha/lote.
- Idempotencia en `/enqueue`: aceptar `Idempotency-Key` además de `messageId`.

### 5) Gestión de imágenes

- Beneficio: reduce tamaño de la BD, mejora performance y evita duplicados de media.
- Prioridad: **Media-Alta**
- Evitar guardar base64 BLOB en SQLite (crece el archivo y ralentiza consultas):
  - Guardar imágenes como archivos en `TO_ENGRAVE_DIR/images` con nombre por hash (SHA-256) y solo referenciar ruta en BD.
  - Limitar tamaño máximo de imagen (p. ej., 1–2 MB) y recomprimir si excede.
  - Deduplicar por hash (no almacenar duplicados).

### 6) UI/UX y rendimiento

- Beneficio: interfaz más fluida y clara; menor carga de CPU en listas grandes; mejor accesibilidad.
- Prioridad: **Media**
- Virtualizar listas largas de piezas para render fluido (p. ej., `virtual-scroller`).
- Estados de carga y errores más claros; reintentos con backoff al fallar `/engrave-list`.
- Formateo de fechas consistente vía `Intl.DateTimeFormat` con zona horaria definida.
- Modularizar el HTML legacy: mover lógica a `public/app/...` y reducir duplicidad entre scripts.
- Mejorar accesibilidad (contraste, roles ARIA, navegación por teclado).

### 7) Observabilidad y soporte

- Beneficio: diagnósticos más rápidos, menos tiempo muerto; visibilidad de salud y rendimiento.
- Prioridad: **Media**
- Logging estructurado (pino/winston) con niveles y rotación a archivos (ya hay `server_run.log` pero formalizar).
- Endpoint `/healthz` y `/readyz` para monitoreo.
- Métricas básicas (p. ej., Prometheus): tasa de mensajes, tiempos de respuesta, errores por endpoint.
- Trazabilidad de acciones de borrado (`/engrave/delete`), con quién/cuándo/por qué.

### 8) Pruebas y calidad

- Beneficio: menos regresiones, mayor confianza al desplegar, compatibilidad mantenida.
- Prioridad: **Media-Alta**
- Tests de integración para `/enqueue` + lectura en BD para diferentes formatos de mensaje y medios.
- Tests E2E del flujo WA simulado (mock o sandbox) para parseo + hints.
- Pruebas de carga (autocannon/k6) en `/engrave-list` y `/api/export`.
- Linter + formateo (ESLint/Prettier) y hooks pre-commit.
- CI (GitHub Actions): ejecutar tests, linter y empaquetado.

### 9) Despliegue y operación

- Beneficio: menor downtime, despliegues repetibles, soporte más sencillo.
- Prioridad: **Media**
- Ejecutar como servicio (PM2/NSSM) con autorestart y logs rotados.
- Paquete/installer: asegurarse de dependencias de `puppeteer` (Chrome/Chromium) en la máquina destino.
- Copias de seguridad periódicas de `laser_engraving.db` y exportación JSON.
- Opción de contenedor (Docker) si aplica al entorno.

### 10) SSE y tiempo real

- Beneficio: conexiones más estables y manejables; menos fugas de clientes.
- Prioridad: **Media-Baja**
- Heartbeat/keep-alive periódicos para detectar clientes muertos antes.
- `retry:` en SSE para reconexión controlada desde el front.
- Nombrar tipos de eventos (`event: nuevo-registro`, `event: delete`, etc.) para facilitar handlers.

### 11) Legacy y compatibilidad

- Beneficio: simplifica mantenimiento y evita doble fuente de verdad.
- Prioridad: **Media-Baja**
- Plan de retiro gradual de `to_engrave`:
  - Importación al arrancar (ya existe) + herramienta manual de migración.
  - Feature flag para desactivar completamente escritura a archivos.
  - Limpieza automática de legacy según política de retención.

## Hoja de ruta sugerida

- Quick wins (1–3 días):

  - Índices en BD, activar WAL, endpoint `/healthz`, rate limiting básico, Helmet.
  - Fix esquema `lot_metrics` con UNIQUE compuesto.
  - UI: estados de error y reintentos con backoff en `/engrave-list`.

- Corto plazo (1–2 semanas):

  - Validación con Joi/Zod en endpoints; OpenAPI + documentación.
  - Desacoplar imagen a sistema de archivos + hash; límites de tamaño.
  - Logging estructurado y rotación; métricas básicas.

- Mediano plazo (2–4 semanas):

  - Reintentos robustos en WhatsApp; cola persistente para media.
  - Paginación/filtrado avanzados en `/api/lotes` y `/api/export`.
  - Tests E2E y de carga; CI/CD con GitHub Actions.

- Backlog:
  - FTS5 para búsquedas por `partNumber`/`rawMessage`.
  - Archivado/particionado por antigüedad.
  - Panel admin para gestión (reconexión, reset, métricas, logs).

## Apéndice A — SQL de índices y migración de métricas

```sql
-- ÍNDICES RECOMENDADOS
CREATE INDEX IF NOT EXISTS idx_pieces_lot_ts ON pieces(lot_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_pieces_part ON pieces(partNumber);
-- messageId ya es UNIQUE; verificar con PRAGMA index_list(pieces);

-- MIGRACIÓN lot_metrics: UNIQUE(lot_id, metric_type)
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS lot_metrics_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  data JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(lot_id, metric_type),
  FOREIGN KEY (lot_id) REFERENCES lotes(id) ON DELETE CASCADE
);
INSERT INTO lot_metrics_new(lot_id, metric_type, data, created_at, updated_at)
SELECT lot_id, metric_type, data, created_at, updated_at FROM lot_metrics
ON CONFLICT DO NOTHING;
DROP TABLE lot_metrics;
ALTER TABLE lot_metrics_new RENAME TO lot_metrics;
COMMIT;
```

## Apéndice B — Esqueleto OpenAPI (inicio)

```yaml
openapi: 3.0.3
info:
  title: Sistema Grabado Láser API
  version: 1.0.0
servers:
  - url: http://localhost:3000
paths:
  /enqueue:
    post:
      summary: Encolar pieza
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                numParte: { type: string }
                numPiezas: { oneOf: [{ type: integer }, { type: string }] }
                imagen: { type: string, description: base64 data URL }
                clientId: { type: string }
                messageId: { type: string }
              required: [numParte]
      responses:
        "200": { description: OK }
        "400": { description: Parámetros inválidos }
```

      ## Plan de implementación paso a paso (recomendado)

      Sigue este orden para maximizar impacto y minimizar riesgos. Incluye comandos orientativos en PowerShell.

      ### Fase 0 — Preparación

      - Crear un branch de trabajo y respaldo de BD.

      ```powershell
      # respaldo rápido
      Copy-Item .\laser_engraving.db .\backup_laser_engrabado_$(Get-Date -Format 'yyyy-MM-dd').db
      ```

      ### Fase 1 — Quick Wins (Alta prioridad)

      1) Activar WAL y añadir índices en SQLite
      - Editar `db.js`: al conectar, ejecutar `PRAGMA journal_mode=WAL;` y crear índices recomendados.
      - Verificar tamaño/crecimiento estable tras varias inserciones.

      2) Seguridad básica
      - Instalar Helmet y rate limiter, y aplicarlo a `/enqueue`, `/api/reset`, `/engrave/delete`.

      ```powershell
      npm install helmet express-rate-limit
      ```

      3) Endpoints de salud
      - Añadir `GET /healthz` y `GET /readyz` en `server.js` con chequeos de BD y estado de WhatsApp.

      4) UI — reintentos con backoff en `/engrave-list`
      - En `public/app/services/server.js`, envolver `importEngraveList` con backoff (p. ej., 250ms → 500 → 1s → 2s, máx 5 intentos).

      ### Fase 2 — Modelo de datos (Alta prioridad)

      5) Migración `lot_metrics` a UNIQUE compuesto
      - Ejecutar el SQL del Apéndice A en una ventana de mantenimiento.
      - Probar guardar dos tipos de métricas (`laser`, `pavonado`) para un mismo lote.

      ### Fase 3 — API y contratos (Media‑Alta)

      6) Documentación OpenAPI
      - Crear `docs/openapi.yaml` (iniciar con el esqueleto del Apéndice B) e integrar `swagger-ui-express`.

      ```powershell
      npm install swagger-ui-express
      ```

      7) Validación de entrada
      - Integrar Joi/Zod en `/enqueue`, `/api/*` para validar tipos y rangos.

      ### Fase 4 — Gestión de imágenes (Media‑Alta)

      8) Desacoplar imágenes de la BD
      - Al recibir media, guardar archivo en `TO_ENGRAVE_DIR/images/<hash>.ext` y referenciar ruta en `pieces.imagen`.
      - Implementar límite de tamaño y recomprimir si excede.

      ### Fase 5 — WhatsApp robusto (Alta)

      9) Reconexión con backoff y watchdog
      - En `server.js`, sustituir reconexiones fijas por backoff exponencial y agregar watchdog que monitorice estado y reinicie si se estanca.

      10) Reintentos de media
      - Implementar hasta 3 reintentos en `downloadMedia()` con delays crecientes.

      ### Fase 6 — Observabilidad, pruebas y CI (Media)

      11) Logging y métricas
      - Integrar `pino` o `winston` con rotación; exponer métricas básicas (Prometheus si aplica).

      12) Pruebas y CI
      - Añadir tests de integración para `/enqueue` y E2E simulados del flujo WA; configurar GitHub Actions para ejecutar tests/linter.

      ### Fase 7 — Despliegue y operación (Media)

      13) Ejecutar como servicio
      - PM2/NSSM con autorestart y rotación de logs.

      14) Backups
      - Programar copias de seguridad de `laser_engraving.db` y exportaciones regulares.

      ### Fase 8 — SSE y legacy (Media‑Baja)

      15) SSE robusto
      - Añadir heartbeat y `retry:`; nombrar eventos.

      16) Retiro gradual de `to_engrave`
      - Desactivar escritura legacy salvo necesidad; completar migración y limpieza programada.


      ## Prioridad y beneficio por función (resumen)

      - Alta: Robustez WhatsApp (continuidad), Seguridad (protección), BD/índices/WAL + migración métricas (rendimiento/consistencia).
      - Media‑Alta: API/OpenAPI + validación (estabilidad de contratos), Gestión de imágenes (performance/espacio).
      - Media: UI/UX (fluidez), Observabilidad y pruebas (diagnóstico y calidad), Despliegue como servicio (operación).
      - Media‑Baja: SSE robusto (estabilidad de conexiones), Retiro legacy (mantenimiento).
