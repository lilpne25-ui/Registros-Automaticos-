# Production Readiness Audit

## 1. Resultado final
Categoria: Listo para piloto controlado

## 2. Resumen ejecutivo

Auditoria realizada sobre el repositorio `E:\whatsapp-excel`, asumiendo el despliegue real que el propio proyecto evidencia hoy: aplicacion desktop/on-prem Windows con launcher Electron, servidor Express embebido y persistencia SQLite local por defecto, con opcion MSSQL.

El sistema ya no esta en nivel "solo demo". Tiene autenticacion activa por defecto, health checks, backup/restore operable, pruebas de integracion del flujo critico y un camino de empaquetado desktop funcional al menos de forma parcial. `npm test` paso en este turno y el runtime minimo de servidor tambien se pudo reconstruir.

No lo considero listo para produccion real todavia. El principal bloqueo no es de funcionalidad, sino de higiene operativa y release: el repo contiene artefactos sensibles y de sesion versionados, el arbol `dist` sigue mostrando empaquetado inconsistente con `.env` dentro de `win-unpacked/resources/server`, no hay CI/CD visible ni gate automatizado de release, y la base del backend/UI sigue muy concentrada en archivos monoliticos grandes.

Resultado practico:

- Si el objetivo es un piloto controlado en una planta o cliente acompanado por el equipo, se puede defender.
- Si el objetivo es una entrega repetible y segura a multiples clientes con soporte bajo friccion, todavia no.

## 3. Checklist general

| Area | Estado | Evidencia | Riesgo |
|---|---|---|---|
| Tipo de despliegue soportado | Correcto | `desktop/main.js`, `desktop/package.json`, `README.md` describen launcher Electron + servidor local + DB por maquina | El alcance real es on-prem/LAN, no SaaS |
| Autenticacion basica | Correcto | `server.js` usa `AUTH_ENABLED=true` y `AUTH_REQUIRE_PASSWORD=true` por defecto; login y `/status`/`/qr` quedan protegidos; `tests/integration.server.test.js` valida login | Base correcta para piloto LAN |
| Seguridad de cabeceras y abuso | Parcial | `server.js` integra `helmet`, `express-rate-limit` y validacion `zod` en rutas sensibles | No hay CSRF, no hay cookie `Secure`, y sigue habiendo defaults peligrosos si falta config manual |
| Secretos y artefactos sensibles | Riesgoso | `git ls-files` incluye `.env`, `tokens.json`, `laser_engraving.db`, `laser_grabado.db`, y gran parte de `.wwebjs_auth` / `.wwebjs_cache` | Riesgo alto de fuga de credenciales, sesiones y datos operativos |
| Empaquetado desktop | Riesgoso | `desktop/build-server-runtime.js` reconstruye runtime minimo; pero `dist/win-unpacked/resources/server/.env` existe y en `dist/LaserControl-win32-x64/resources/app` conviven `server` y `server-runtime` | Release inconsistente, sensible a artefactos stale |
| Backups y recuperacion | Parcial | `server/services/backup-restore.js`, rutas `/api/backups` y `/api/import`, y prueba de restore real en `tests/integration.server.test.js` | No hay estrategia visible de retencion, cifrado, backup off-machine ni verificacion programada |
| Base de datos y persistencia | Parcial | SQLite local por defecto desde `desktop/main.js`; soporte MSSQL presente en `db_mssql.js` y `scripts/migrate_sqlite_to_mssql.js` | Falta contrato operativo fuerte entre modo SQLite y modo MSSQL |
| Observabilidad | Parcial | `desktop/main.js` escribe `lasercontrol.log`; `server.js` registra eventos por `console.*`; hay endpoint `/healthz` y `/readyz` | No hay logging estructurado real, metricas, alertas ni trazabilidad centralizada |
| Testing | Parcial | `package.json` ejecuta integracion + store + pieces; `npm test` paso en este turno | No hay smoke automatizado de empaquetado/instalador ni suite CI de release |
| CI/CD | No encontrado | `.github` no contiene workflows operativos visibles en este checkout | Cada release depende de ejecucion manual y aumenta el riesgo de regresion |
| Documentacion operativa | Parcial | `README.md` ya documenta arranque, auth, backups y empaquetado; `docs/` tiene manuales | Falta playbook unico de instalacion, soporte, rollback y checklist por cliente |
| Mantenibilidad de codigo | Riesgoso | `server.js` mide 4547 lineas; `public/sistema_de_grabado_laserv1.html` mide 9392 lineas; aun quedan bloques legacy deshabilitados | Riesgo alto de regresiones y de soporte costoso |

## 4. Bloqueadores de produccion

| Severidad | Bloqueador | Archivo/Ruta | Impacto | Accion requerida |
|---|---|---|---|---|
| Critica | Artefactos sensibles y de sesion versionados en el repo | `.env`, `.wwebjs_auth/`, `.wwebjs_cache/`, `tokens.json`, `laser_engraving.db`, `laser_grabado.db` | Posible fuga de credenciales, sesion de WhatsApp, datos locales y configuracion real | Sacar estos artefactos del control de versiones, rotar secretos, limpiar historial si aplica y endurecer `.gitignore` |
| Critica | El arbol `dist` sigue mostrando empaquetado inconsistente y fuga de `.env` | `dist/win-unpacked/resources/server/.env`, `dist/LaserControl-win32-x64/resources/app/server`, `dist/LaserControl-win32-x64/resources/app/server-runtime` | El release puede distribuir configuracion sensible o artefactos stale; soporte impredecible | Limpiar `dist` antes de empaquetar, asegurar una sola ruta de runtime soportada y validar que no viaje `.env` ni estado local |
| Alta | No existe gate automatizado de CI/CD | `.github/` | Releases manuales sin control automatico de tests, build ni smoke | Agregar workflow minimo: `npm test`, build runtime, smoke de arranque y validacion de artefactos |
| Alta | Backend y UI principal siguen demasiado concentrados | `server.js`, `public/sistema_de_grabado_laserv1.html` | Cada cambio eleva el riesgo de regresion global y dificulta soporte por cliente | Seguir extraccion por dominios y retirar fisicamente bloques legacy deshabilitados |
| Alta | Defaults inseguros si el despliegue manual omite configuracion | `server.js` (`RESET_PASSWORD='admin2025'`, `AUTH_SECRET=''`) | Un arranque Node mal configurado deja una postura de seguridad debil | Fallar en startup si faltan secretos criticos fuera del modo controlado de desktop |
| Media | Cookie de sesion sin atributo `Secure` | `server.js` | En internet o reverse proxy mal configurado aumenta riesgo de robo de cookie; en LAN sigue siendo un riesgo moderado | Condicionar `Secure` a HTTPS/proxy confiable y documentar claramente el alcance solo HTTP local |
| Media | Observabilidad insuficiente para soporte multiinstalacion | `server.js`, `desktop/main.js` | Diagnostico lento, poca trazabilidad y soporte reactivo | Incorporar logging estructurado, rotacion, nivelado y export simple de logs |
| Media | Estrategia de backup incompleta para produccion real | `server/services/backup-restore.js`, `README.md` | Hay restore funcional, pero no politica de respaldo durable | Definir retencion, ubicacion externa, periodicidad y prueba operativa de recuperacion |
| Media | Dependencias y runtime con drift | `package.json`, `desktop/build-server-runtime.js`, salida de `npm ci` | Mayor peso, warnings/deprecations y complejidad innecesaria en release | Eliminar dependencias no usadas o integrarlas realmente; revisar paquetes deprecated |

## 5. Seguridad de produccion

Fortalezas verificadas:

- Autenticacion activa por defecto en runtime principal.
- Password de admin y `AUTH_SECRET` aleatorios por maquina cuando el arranque viene desde Electron.
- `helmet` y rate limiting activos.
- Endpoints publicos de salud acotados a `GET /healthz` y `GET /readyz`.
- Validacion de payload con `zod` en rutas sensibles.

Debilidades verificadas:

- El repo contiene secretos y estado real versionado o distribuible.
- El empaquetado observado en `dist/win-unpacked/resources/server` todavia contiene `.env`.
- `server.js` mantiene defaults inseguros para ejecucion manual fuera del flujo desktop:
  - `RESET_PASSWORD=admin2025`
  - `AUTH_SECRET=''`
- La cookie `lc_auth` usa `HttpOnly` y `SameSite=Lax`, pero no `Secure`.
- No encontre control CSRF dedicado ni separacion formal de entornos dev/staging/prod.

Dictamen de seguridad:

- Aceptable para piloto LAN acompanado.
- No aceptable todavia para produccion repetible sin limpiar repo, empaquetado y defaults.

## 6. Infraestructura y despliegue

Estado actual:

- Despliegue orientado a Windows desktop/on-prem.
- Launcher Electron inicia y monitorea el servidor local.
- El runtime minimo de servidor se reconstruye desde `desktop/build-server-runtime.js`.
- Hay `package-win` e `installer-win` en `desktop/package.json`.

Hallazgos:

- El build del runtime minimo si fue verificable en este turno.
- El intento de `node desktop/build-package.js` no cerro limpio dentro del timeout del comando.
- Aun asi, los artefactos presentes en `dist/` mostraron mezcla de rutas y contenido stale:
  - `resources/app/server`
  - `resources/app/server-runtime`
  - `resources/server/.env`

Conclusion de despliegue:

- El proyecto ya tiene base de empaquetado vendible.
- El pipeline de release todavia no es lo bastante determinista para llamarlo listo para produccion.

## 7. Datos, backups y recuperacion

Fortalezas:

- Hay export, listado, descarga, backup en disco y restore por archivo/API.
- La restauracion ya esta validada con mutacion y rollback real en integracion.
- El launcher desktop fuerza por defecto una BD local por maquina.

Gaps:

- No hay evidencia de backup automatico programado.
- No hay evidencia de cifrado de backup.
- No hay evidencia de respaldo fuera de la maquina ni replica.
- No hay evidencia de playbook de desastre con RPO/RTO definidos.

Veredicto:

- Recuperacion funcional para piloto.
- Insuficiente para produccion formal sin politica operativa adicional.

## 8. Observabilidad

- Logs: Parcial. `desktop/main.js` escribe log local y `server.js` emite muchos `console.log/warn/error`.
- Metricas: No encontrado en el proyecto.
- Alertas: No encontrado en el proyecto.
- Trazabilidad: Parcial. Hay health checks y logs locales, pero no correlacion formal ni logging estructurado.

## 9. Testing minimo requerido

Verificado en este turno:

- `npm test` paso completo.
- La integracion cubre:
  - `healthz`
  - login
  - `/status`
  - `/qr`
  - grupos y logs de WhatsApp
  - validacion de restart
  - `/enqueue`
  - snapshots
  - backup/restore
- `node desktop/build-server-runtime.js` paso completo.

Falta como minimo para aprobar produccion:

- Smoke automatizado del paquete desktop generado.
- Validacion automatizada del instalador `NSIS`.
- Verificacion automatica de que `dist` no contenga `.env`, sesiones ni artefactos stale.
- Un test de arranque que falle si faltan secretos criticos fuera del flujo desktop controlado.

## 10. Requisitos antes de venderlo

- Limpiar secretos, sesiones de WhatsApp, bases locales y caches del repositorio.
- Corregir el pipeline de empaquetado para que nunca distribuya `.env` ni artefactos duplicados.
- Agregar un gate minimo de CI/release.
- Endurecer `server.js` para fallar si faltan secretos criticos en despliegues manuales.
- Documentar instalacion y soporte con checklist por cliente.
- Definir oficialmente el modo soportado por venta:
  - `SQLite + Electron + LAN`
  - o `MSSQL + servidor compartido`

## 11. Plan de estabilizacion

### Critico

- Sacar de git `.env`, sesiones `.wwebjs_auth`, cache `.wwebjs_cache`, `tokens.json` y bases locales.
- Rotar secretos y credenciales posiblemente expuestos.
- Limpiar `dist/` antes de cada build y dejar una sola ruta de runtime soportada.
- Agregar validacion post-build que falle si encuentra `.env`, sesiones o runtime duplicado dentro del paquete.

### Alta prioridad

- Agregar CI minima con `npm test`, build runtime y smoke de empaquetado.
- Hacer que el servidor falle al arrancar si faltan `AUTH_SECRET` y `RESET_PASSWORD` en despliegue manual no-desktop.
- Seguir partiendo `server.js` y retirar los bloques `if (false)` legacy.
- Seguir extrayendo logica del HTML legacy a modulos `public/app/*`.

### Media prioridad

- Incorporar logging estructurado y rotado.
- Formalizar politica de backup: frecuencia, retencion, ubicacion externa y prueba de restauracion.
- Definir contrato soportado SQLite vs MSSQL.
- Revisar dependencias no usadas y warnings deprecados del runtime.

### Mejoras posteriores

- Mejorar estrategia de imagenes y crecimiento de almacenamiento.
- Agregar telemetria operativa simple por instalacion.
- Formalizar checklist comercial/tecnico de implementacion por cliente.

## 12. Proxima accion recomendada

No venderlo todavia como "listo para produccion". Venderlo, si se necesita mover ya, solo como piloto controlado on-prem/LAN con acompanamiento directo, y cerrar primero un hardening corto de release:

1. limpiar repo y secretos,
2. corregir empaquetado,
3. agregar gate automatizado minimo,
4. rerun de smoke del paquete limpio.
