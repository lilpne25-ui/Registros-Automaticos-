# AI CTO Review

## 1. Diagnostico ejecutivo
- Que es el producto: sistema operativo local/LAN para control de produccion de grabado laser y pavonado, con captura desde WhatsApp, gestion de lotes/piezas, reportes, snapshots mensuales, control de usuarios y launcher Electron para Windows.
- Que problema resuelve: convierte mensajes, cantidades e imagenes de WhatsApp en datos operativos trazables para planta, evitando que la operacion viva solo en chats, archivos sueltos y captura manual.
- Estado actual: piloto interno funcional y vendible como implementacion puntual. No esta listo todavia para crecer como producto SaaS ni para operar con baja friccion en multiples clientes sin endurecer arquitectura, seguridad y empaquetado.
- Riesgo general: medio-alto. El valor del flujo existe, pero el backend y la UI siguen muy concentrados, el modo seguro no es el default y el paquete distribuido arrastra demasiada configuracion sensible y peso tecnico.
- Potencial comercial: bueno en un nicho claro: talleres o plantas pequenas que ya operan por WhatsApp y necesitan trazabilidad sin comprar un ERP completo.

Evidencia revisada:
- `server.js` concentra API, auth, WhatsApp, SSE, reset, snapshots, archivos y arranque de servidor. Hoy mide 4236 lineas.
- `public/sistema_de_grabado_laserv1.html` sigue siendo la superficie principal y todavia contiene mucha logica legacy. Hoy mide 9380 lineas, aunque ya carga modulos `public/app/features/*`.
- `desktop/main.js` y `desktop/build-package.js` confirman una estrategia desktop/on-prem, no SaaS.
- `desktop/build-package.js` y `desktop/package.json` siguen copiando `.env`, `node_modules`, `bot.js` y otros artefactos completos dentro del paquete.
- `package.json` declara `helmet`, `express-rate-limit`, `swagger-ui-express`, `zod`, `@whiskeysockets/baileys` y `pino`, pero no encontre integracion real de esas piezas en el runtime actual.
- `npm test` pasa hoy con 34 pruebas, enfocadas solo en `store` y `pieces`.
- No encontrado en el proyecto: `README.md` raiz. La documentacion esta dispersa en `docs/`.

## 2. Decision CTO
Decision: Refactorizar antes de crecer

Justificacion:

El proyecto ya supero la etapa de idea. Tiene flujo real, interfaz util, persistencia, control operativo y una propuesta clara para un entorno LAN. No conviene pausarlo ni desecharlo.

Tampoco conviene crecerlo todavia como producto amplio. Hoy la app funciona mas como "solucion interna robusta para un caso concreto" que como "producto listo para escalar". El siguiente movimiento correcto no es agregar mas features ni reescribirla completa; es estabilizar la base para cerrar una version `v1 LAN estable` que pueda instalarse, soportarse y cobrarse de forma repetible.

## 3. Prioridades tecnicas
| Prioridad | Accion | Impacto | Riesgo si no se hace | Esfuerzo |
|---|---|---|---|---|
| P0 | Volver la seguridad `secure-by-default`: `AUTH_ENABLED=true` para despliegues cliente y secretos fuera del paquete | Alto | Exposicion de endpoints administrativos y credenciales distribuidas con el instalable | Bajo-Medio |
| P0 | Redisenar el empaquetado Windows para no copiar `.env` ni `node_modules` completos y separar configuracion por maquina | Alto | Builds pesados, fragiles y con fuga de configuracion sensible | Medio |
| P0 | Partir `server.js` por dominios: auth, whatsapp, lotes/pieces, reportes, snapshots, sistema | Alto | Cada cambio seguira elevando el riesgo de regresion global | Medio-Alto |
| P0 | Agregar `healthz`, backup/restauracion operables y estado visible de BD/WhatsApp/puerto | Alto | Soporte manual, perdida de datos y diagnostico lento en sitio | Medio |
| P1 | Integrar de verdad `helmet`, rate limiting y validacion de payloads, o eliminar dependencias muertas | Alto | Superficie de ataque innecesaria y falsa sensacion de endurecimiento | Bajo-Medio |
| P1 | Crear pruebas de integracion para login, grupos autorizados, logs WhatsApp, restart, snapshots y `/enqueue` | Alto | El flujo de negocio seguira protegido solo por pruebas parciales del frontend | Medio |
| P1 | Resolver deuda de almacenamiento de imagenes: hash + archivos externos, no base64 pesado como camino principal | Medio-Alto | Crecimiento de BD, lentitud de backups y degradacion de rendimiento | Medio |
| P1 | Definir estrategia soportada de persistencia: SQLite LAN pequeno vs MSSQL multiusuario real | Medio-Alto | Configuraciones ambiguas y soporte costoso por modo mixto | Medio |
| P2 | Seguir extrayendo comportamiento del HTML legacy a `public/app/*` sin rehacer la UI desde cero | Medio | La velocidad de cambio seguira limitada por una pagina monolitica | Medio |
| P2 | Limpiar drift de codigo y naming: `whatsapp-bot`, `whatsapp-excel`, `LaserControl`, `bot.js` legado no usado por runtime principal | Medio | Confusion comercial, tecnica y de soporte | Bajo |

## 4. Prioridades de negocio
| Prioridad | Accion | Justificacion | Resultado esperado |
|---|---|---|---|
| P0 | Venderlo como solucion on-prem/LAN para una planta o taller, no como plataforma general | Es el encaje real que el codigo soporta hoy | Oferta honesta y mas facil de cerrar |
| P0 | Cerrar un paquete piloto instalable con checklist de implementacion y soporte remoto | El valor existe, pero la experiencia de despliegue aun no es repetible | Primeras instalaciones cobrables |
| P1 | Posicionar WhatsApp + trazabilidad + reportes como diferenciador comercial principal | Es la parte menos comoditizada del sistema | Mayor valor percibido frente a Excel puro |
| P1 | Estandarizar el proceso de alta de cliente: PC servidor, firewall, QR, grupos, backup, usuarios | El soporte operativo puede comerse el margen si cada alta es artesanal | Implementaciones mas predecibles |
| P1 | Definir precio por instalacion + configuracion + soporte mensual | La naturaleza actual del sistema favorece servicio e implementacion, no suscripcion SaaS pura | Modelo simple y monetizable |
| P2 | Replicar el mismo core a otras operaciones parecidas antes de pensar en producto horizontal | El codigo ya tiene una base reutilizable para entornos operativos similares | Expansion con menor riesgo |

## 5. Lo que NO conviene construir todavia
- SaaS multiempresa.
- App movil nativa.
- Integracion ERP/MRP compleja.
- Reescritura total en React/Next.js.
- Automatizaciones con IA "inteligente" para interpretar cualquier mensaje libre.
- Multi-planta con sincronizacion distribuida.
- Observabilidad enterprise completa antes de cerrar health, backup y soporte basico.
- Un segundo motor de WhatsApp con Baileys mientras el camino principal sigue siendo `whatsapp-web.js`.

## 6. Riesgos principales
### Tecnicos
- `server.js` sigue siendo un monolito de 4236 lineas con demasiadas responsabilidades.
- La UI principal sigue dependiendo de un HTML de 9380 lineas, aunque ya exista modularizacion parcial en `public/app`.
- Hay drift de codigo y producto: el repo se llama `whatsapp-excel`, el package principal `whatsapp-bot`, el desktop `LaserControl` y ademas se sigue empaquetando `bot.js` aunque el runtime real ya vive dentro de `server.js`.
- El proyecto declara dependencias de seguridad y validacion que no estan conectadas al runtime, lo que indica deuda de endurecimiento o limpieza pendiente.

### Comerciales
- Si se ofrece como "software listo para cualquier planta", la promesa hoy queda por encima del estado real.
- Si se vende como "sistema LAN que formaliza la operacion de WhatsApp a produccion", el encaje es mucho mas defendible.
- El costo de soporte puede crecer rapido si el despliegue sigue siendo manual y sensible a configuracion local.

### Operativos
- La propia documentacion ya establece el patron de "1 PC servidor + clientes por navegador". Eso funciona, pero deja claro que no es una arquitectura libre de operacion.
- No hay un `README` raiz que centralice instalacion, release y troubleshooting; el conocimiento operativo esta repartido.
- Existe `scripts/smoke_api.js`, pero no forma parte del flujo de validacion estandar.

### Seguridad
- `AUTH_ENABLED` existe pero por defecto arranca en `false`, lo cual es una mala postura por defecto para un despliegue cliente.
- `desktop/build-package.js` y `desktop/package.json` copian `.env` dentro del paquete distribuido.
- `server.js` usa cookie `lc_auth` y hashing `pbkdf2`, lo cual esta bien como base, pero falta el endurecimiento HTTP y de abuso de endpoints.
- No encontrado en el proyecto: integracion activa de `helmet`, `express-rate-limit`, `zod` o `swagger-ui-express`.

### Escalabilidad
- Para 1 planta y 3-10 usuarios en LAN, el sistema puede sostenerse.
- Para varias plantas, varios servidores o soporte remoto frecuente, el modelo actual empieza a romperse por acoplamiento operativo.
- La convivencia SQLite/MSSQL sin un contrato de despliegue mas estricto puede volverse una fuente recurrente de bugs y soporte.

## 7. Arquitectura recomendada

Arquitectura objetivo para la siguiente etapa:

- `desktop/`
  - launcher Electron
  - panel de estado
  - configuracion local por maquina
  - logs y utilidades de soporte

- `server/` o equivalente por modulos
  - `auth/`
  - `whatsapp/`
  - `production/`
  - `reports/`
  - `snapshots/`
  - `storage/`
  - `system/`

- Persistencia
  - SQLite como modo soportado para piloto LAN pequeno
  - MSSQL como modo soportado solo cuando exista playbook de despliegue y validacion real

- UI
  - conservar la UI actual
  - seguir extrayendo features hacia `public/app/features`, `services`, `state` y `ui`
  - no reescribir frontend completo antes de estabilizar backend y release

- Media
  - imagenes fuera de la BD principal cuando sea posible
  - referencias por hash y politica de retencion clara

## 8. Equipo minimo necesario
- Frontend: 1 dev part-time para seguir modularizando sin romper la operacion.
- Backend: 1 fullstack/backend responsable de server, WhatsApp, DB y seguridad operativa.
- DevOps: no full-time; basta con scripts de release, backup, soporte e instalacion.
- QA: 1 apoyo part-time para checklist de release y pruebas de flujo real.
- Producto: el owner debe fijar el contrato operativo por cliente y lo que si/no entra en el piloto.
- Diseno: apoyo puntual; hoy no es prioridad una capa visual nueva completa.

## 9. Roadmap CTO
### 7 dias
- Forzar modo seguro para cliente: auth activa, secretos fuera del paquete y politica minima de usuarios.
- Agregar `healthz` y un panel de estado util en desktop/UI.
- Definir y probar backup/restauracion.
- Documentar instalacion real en un `README` o guia central de release/soporte.
- Ejecutar y documentar un smoke real del flujo: login -> WhatsApp QR/status -> alta de pieza -> lote -> reporte -> snapshot.

### 30 dias
- Dividir `server.js` sin cambiar comportamiento observable.
- Integrar `helmet`, rate limiting y validacion de entradas en endpoints criticos.
- Incluir pruebas de integracion en `npm test` o en un comando CI separado.
- Limpiar naming y artefactos legacy que ya no forman parte del camino principal.
- Cerrar un paquete `v1 LAN estable` con instalacion repetible.

### 90 dias
- Definir oficialmente los dos modos de despliegue soportados: SQLite LAN y MSSQL multiusuario.
- Mover el manejo de imagenes a un esquema mas ligero y mantenible.
- Agregar CI minima: tests, smoke y build desktop.
- Formalizar documentacion tecnica y comercial para implementacion.
- Medir soporte, fallas y tiempos de operacion por cliente piloto.

### 6 meses
- Replicar el producto en 2-3 instalaciones similares.
- Estandarizar licenciamiento, soporte y actualizacion.
- Evaluar version multiempresa o nube solo si el patron comercial ya se repite con baja variacion.

## 10. Metricas que deben medirse
- Mensajes WhatsApp recibidos por dia.
- Mensajes autorizados vs rechazados.
- Piezas creadas por WhatsApp vs captura manual.
- Tiempo desde mensaje hasta pieza visible en UI.
- Errores de autenticacion o reconexion de WhatsApp.
- Backups exitosos/fallidos.
- Tiempo de recuperacion ante falla.
- Incidentes de soporte por instalacion.
- Tiempo promedio de cierre mensual o snapshot.
- Tamano de BD y crecimiento de imagenes.
- Usuarios activos por planta/turno.

## 11. Proxima accion recomendada
Cerrar una version `v1 LAN estable` y cobrarla como solucion de implementacion, no como plataforma escalable todavia.

Orden recomendado:

1. Seguridad y release: auth por defecto, secretos fuera del paquete, configuracion por maquina.
2. Operacion confiable: backup, restore, healthz y checklist de soporte.
3. Refactor de base: partir `server.js` y seguir sacando logica del HTML legacy.
4. Validacion real: pruebas de integracion del flujo critico y smoke del instalable.

Si se ejecuta eso bien, el proyecto puede pasar de "app interna util" a "producto piloto monetizable y repetible". Antes de eso, agregar mas features o perseguir SaaS es prematuro.
