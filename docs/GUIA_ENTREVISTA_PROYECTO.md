# Guía de entrevista técnica — Proyecto **WhatsApp + Excel/BD** (Laser Control)

Fecha: 17/02/2026  
Proyecto: `whatsapp-excel`

---

## 1) Cómo explicar el proyecto en 60 segundos (pitch)

Este sistema conecta **WhatsApp** con una aplicación web interna para operación de grabado láser/pavonado.

- Recibe mensajes desde WhatsApp (texto, cantidades e imágenes).
- Interpreta los datos de producción (número de parte, cantidad, evidencia fotográfica).
- Guarda todo en **SQLite** como fuente de verdad.
- Muestra y administra la información en un dashboard web multiusuario en LAN.
- Permite reportes, métricas por lote, exportación/importación y cierres mensuales protegidos.

Frase clave para entrevista:
> “Transformamos mensajes no estructurados de WhatsApp en datos operativos trazables, consultables y auditables en tiempo real.”

---

## 2) Problema de negocio que resuelve

Antes: datos dispersos en chats y archivos sueltos, poca trazabilidad, reporteo manual y riesgo de errores.

Ahora:
- Unifica captura de datos operativos.
- Reduce retrabajo administrativo.
- Da visibilidad en tiempo real al estado de lotes y métricas.
- Mejora trazabilidad (quién, cuándo, qué llegó) y continuidad operativa.

---

## 3) Arquitectura general

### Backend
- **Node.js + Express** (`server.js`)
- Integración WhatsApp con **`whatsapp-web.js`** + `LocalAuth`
- Persistencia en **SQLite** (`db.js`)
- API REST + SSE (eventos en tiempo real)

### Frontend
- UI principal en `public/sistema_de_grabado_laserv1.html`
- Módulos JS en `public/app/...` (features, services, state, ui)
- Login UI dedicado en `public/login.html`

### Datos
- BD principal: `laser_engraving.db`
- Esquema principal: `lotes`, `pieces`, `lot_metrics`, `sync_log`, `monthly_snapshots`

### Despliegue
- Escenario recomendado: **1 servidor LAN** (Node + BD) y varios clientes vía navegador.
- Arranque típico con `.bat` en Windows (`INICIAR_LASER_CONTROL.bat`).

---

## 4) Flujo end-to-end (de WhatsApp al reporte)

1. Operador envía mensaje a WhatsApp (parte/cantidad/foto).  
2. El bot recibe evento `message` y aplica filtros/autorización (si están activos).  
3. Se hace deduplicación:
   - por `messageId` (TTL),
   - por firma de contenido en ventana corta.
4. Se intenta parsear número de parte y cantidad.
5. Si hay imagen, se descarga; si falla, entra a cola de reintento.
6. Se guarda la pieza en BD (`pieces`) dentro del lote de entrada (`lotes` por defecto).
7. Se emite evento SSE a clientes conectados para actualización en vivo.
8. UI refleja cambios, permite edición/movimientos por lote y genera reportes.

---

## 5) Diseño de autenticación y permisos (punto importante de entrevista)

El proyecto soporta auth opcional por configuración:
- `AUTH_ENABLED=true` activa login.
- Login por `/api/auth/login`.
- Sesión en memoria con cookie `HttpOnly` (`lc_auth`).
- Usuarios en tabla `auth_users` (hash PBKDF2 con salt).
- Sistema de permisos granulares (`admin.users`, `pieces.edit`, `system.reset`, etc.).

### Lo que puedes destacar
- Separación entre autenticación (quién eres) y autorización (qué puedes hacer).
- Principio de mínimo privilegio con permisos por módulo.
- Passwords nunca en texto plano; uso de `pbkdf2` + `timingSafeEqual`.

---

## 6) Modelo de datos clave (SQLite)

## `lotes`
Agrupa piezas por proceso o contexto operativo.

## `pieces`
Entidad principal de producción:
- `uid`, `lot_id`, `partNumber`, `quantity`, `timestamp`, `imagen`, `messageId`, `metadata`, etc.

## `lot_metrics`
Métricas por lote y tipo (`laser` / `pavonado`).

## `sync_log`
Auditoría de sincronizaciones/acciones.

## `monthly_snapshots`
Cortes mensuales históricos para reportes.

### Decisión técnica relevante
Se corrigieron patrones peligrosos de `INSERT OR REPLACE` para evitar borrados colaterales por `ON DELETE CASCADE`, migrando a `ON CONFLICT ... DO UPDATE` donde aplica.

---

## 7) Robustez operativa implementada

- Reintentos de descarga de media con cola y backoff.
- Protección contra duplicados (IDs y firmas de contenido).
- Limpieza/normalización de datos heredados.
- Endpoints de control (`/force-reconnect`, `/stop-client`).
- Lógica de recuperación controlada desde imágenes legacy (feature flag).
- Compatibilidad con modo legacy (`WRITE_TO_ENGRAVE_FILES=true`) sin perder BD como fuente principal.

---

## 8) Seguridad y prácticas de operación

- Login opcional y permisos por acción.
- Endpoints sensibles protegidos.
- Contraseña de reset por `.env` (`RESET_PASSWORD`).
- Recomendación multiusuario estable: no abrir la misma BD desde múltiples instancias de Node en red.
- Uso de firewall/puerto en LAN para acceso de clientes.

---

## 9) Pruebas y calidad

Hay pruebas unitarias en `tests/`:
- `store.test.js` (estado global)
- `pieces.test.js` (validaciones y recálculo de métricas)

Script:
- `npm test` ejecuta ambas.

Mensaje para entrevista:
> “Aunque el sistema nació pragmático, ya tiene base de test automatizado para cubrir lógica crítica del front modular.”

---

## 10) Decisiones de ingeniería que puedes defender

1. **SQLite como fuente única de verdad**: simple, rápido de operar, ideal para LAN/pyme.  
2. **SSE para tiempo real**: suficiente para broadcast de eventos sin complejidad de WebSockets completos.  
3. **Procesamiento tolerante a entradas imperfectas**: WhatsApp real trae datos inconsistentes; se priorizó resiliencia con parseo flexible + metadata.  
4. **Feature flags para convivencia legacy**: permitió transición gradual sin romper operación.

---

## 11) Riesgos conocidos y mejoras futuras (hablar con madurez)

- Sesiones en memoria: en reinicio se pierde login (aceptable para LAN, mejorable con Redis/JWT persistente).
- `server.js` es grande: conviene dividir en módulos de dominio (auth, whatsapp, API, sync).
- Falta de observabilidad completa (health checks/métricas estructuradas ya propuestas en `docs/MEJORAS_SISTEMA.md`).
- Endurecer seguridad HTTP con `helmet`, rate limit y validación estricta de payloads.

---

## 12) Preguntas típicas de entrevista (y respuesta sugerida)

### “¿Cuál fue el reto técnico más fuerte?”
Integrar WhatsApp de forma estable: manejo de desconexiones, media intermitente y deduplicación sin perder registros.

### “¿Cómo evitaste datos duplicados?”
Con estrategia doble: `messageId` con TTL + firma de contenido en ventana corta; además controles al guardar.

### “¿Por qué SQLite y no PostgreSQL?”
Por contexto de operación local/LAN, simplicidad de despliegue y mantenimiento. Diseñamos con posibilidad de migración posterior.

### “¿Cómo manejan permisos?”
Modelo de permisos granulares en backend, validados por middleware, con usuarios persistidos en BD y contraseñas hasheadas.

### “¿Qué harías si escala a varias plantas?”
Separar servicios, mover a PostgreSQL, sesiones persistentes, colas de eventos y observabilidad formal.

---

## 13) Cómo cerrar tu explicación en entrevista

Puedes cerrar con algo así:

> “El valor principal del proyecto es convertir una operación basada en chat en un flujo formal de datos productivos: trazable, auditable y en tiempo real. Técnicamente, ya resolvimos autenticación, permisos, deduplicación, persistencia robusta y operación multiusuario en LAN; el siguiente paso natural es modularización y endurecimiento para escala.”

---

## 14) Resumen de archivos clave que debes conocer

- `server.js`: orquestación principal (API, WhatsApp, auth, SSE, flujos operativos)
- `db.js`: acceso a datos y migraciones
- `public/login.html`: login y UX de acceso
- `public/sistema_de_grabado_laserv1.html`: UI principal
- `docs/WHATSAPP_API.md`: referencia técnica de API
- `docs/MEJORAS_SISTEMA.md`: roadmap técnico
- `docs/MANUAL_USUARIO.md`: operación funcional para usuarios

---

Si quieres, en una siguiente iteración te preparo una versión **“speech de 5 minutos”** y otra **“speech de 15 minutos con preguntas difíciles”** para practicar antes de la entrevista.