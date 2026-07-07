# Registros Automaticos

Aplicacion local/LAN para captura operativa de produccion desde WhatsApp, administracion de lotes y piezas, y generacion de reportes mensuales con interfaz web y launcher de escritorio.

## Stack

- `Node.js + Express`
- `SQLite` para operacion local
- `MSSQL` para despliegues con SQL Server
- `whatsapp-web.js` y `Baileys`
- `Electron` para distribucion en Windows
- Frontend HTML/CSS/JS

## Capturas de UI

### Login

![Login UI](docs/screenshots/ui-login.png)

### Dashboard

![Dashboard UI](docs/screenshots/ui-dashboard.png)

## Que hace

- Captura registros operativos desde WhatsApp
- Gestiona lotes y piezas manuales
- Genera reportes mensuales de grabado laser y pavonado
- Permite exportar, importar, respaldar y restaurar datos
- Corre en red local sin depender de un despliegue cloud

## Modos soportados

- Recomendado para piloto/operacion: `Electron + Node + SQLite + LAN/on-prem`
- `MSSQL` disponible para instalaciones con infraestructura existente
- No es un SaaS internet-first

## Arranque rapido

### Web / Node

1. Instala dependencias:

```powershell
npm install
```

2. Crea configuracion local:

```powershell
Copy-Item .\server.env.example .\.env
```

3. Define como minimo:

- `AUTH_SECRET`
- `RESET_PASSWORD`
- `AUTH_ADMIN_USER`
- `AUTH_REQUIRE_PASSWORD=false` si quieres modo solo usuario

4. Inicia:

```powershell
npm start
```

5. Abre:

- `http://127.0.0.1:3000/login`

## Autenticacion

- `AUTH_ENABLED=true` por defecto
- El sistema soporta modo `solo usuario` con `AUTH_REQUIRE_PASSWORD=false`
- Si `AUTH_REQUIRE_PASSWORD=true`, exige usuario y contrasena
- `/status` y `/qr` quedan detras de sesion

## MSSQL: backup, schema y restore

Estado actual del repo:

- Backup publicado: `mssql-backups/LaserControl-20260707-164803.bak`
- Tamano aproximado: `188.6 MB`
- Backup validado con `RESTORE VERIFYONLY`
- Schema bootstrap para instalaciones nuevas:
  - `database/mssql/LaserControl.schema.sql`
- La base operativa verificada usa el nombre:
  - `LaserControl`

Hallazgos de la base viva:

- Tablas confirmadas:
  - `auth_users`
  - `lot_metrics`
  - `lotes`
  - `monthly_snapshots`
  - `pieces`
  - `sync_log`
  - `system_kv`
- Indices confirmados:
  - `idx_pieces_lot_id`
  - `idx_pieces_messageId`
  - `idx_pieces_clientId`
  - `idx_lot_metrics_lot_id`
- La base actual no usa foreign keys
- Diferencia conocida:
  - `system_kv.updated_at` en la DB viva esta como `nvarchar(max)`
  - el schema canonico lo define como `datetime2`

### Como dejar otra maquina funcional

Ruta preferida, con datos reales:

1. Instala SQL Server y deja accesible la instancia destino.
2. Restaura `mssql-backups/LaserControl-20260707-164803.bak`.
3. Verifica que la base restaurada se llame `LaserControl`.
4. Configura `.env` o `server.env` con:
   - `USE_MSSQL=true`
   - `MSSQL_SERVER=<instancia>`
   - `MSSQL_DATABASE=LaserControl`
   - `MSSQL_USER=<usuario>` y `MSSQL_PASSWORD=<password>` si usas SQL Auth
   - o `MSSQL_CONNECTION_STRING`
5. Instala dependencias y arranca:

```powershell
npm install
npm start
```

6. Si vas a usar desktop:

```powershell
node .\desktop\build-package.js
```

7. Valida:

- `GET /healthz`
- flujo de login
- reconexion o relink QR de WhatsApp si la sesion anterior no es portable

Ruta alternativa, sin datos reales:

1. Crea una base vacia `LaserControl`.
2. Ejecuta `database/mssql/LaserControl.schema.sql`.
3. Configura `.env` o `server.env` para MSSQL.
4. Arranca la app para que complete bootstrap y seed inicial.
5. Importa o migra datos despues.

## Desktop / Electron

- El paquete no embebe `.env` ni sesiones de WhatsApp
- En el primer inicio genera por maquina:
  - `%LOCALAPPDATA%\LaserControl\server.env`
  - `%LOCALAPPDATA%\LaserControl\server-credentials.txt`
  - `%LOCALAPPDATA%\LaserControl\backups\`
  - `%LOCALAPPDATA%\LaserControl\logs\server.jsonl`
- La base de datos local por defecto queda en `%LOCALAPPDATA%\LaserControl\laser_engraving.db`

## Build Windows

```powershell
node .\desktop\build-package.js
```

Salida principal:

- `dist\LaserControl-win32-x64\LaserControl.exe`

## Validacion

```powershell
npm test
```

Gate de release:

```powershell
npm run release:check
```

## Endpoints utiles

- `GET /healthz`
- `GET /readyz`
- `GET /api/backups`
- `POST /api/backups`
- `POST /api/import`
- `GET /api/export`

## Documentacion adicional

- [Manual de usuario](docs/MANUAL_USUARIO.md)
- [Playbook operativo](docs/OPERATIONS_PLAYBOOK.md)
- [API de WhatsApp](docs/WHATSAPP_API.md)
- [Contexto del proyecto](docs/GUIA_ENTREVISTA_PROYECTO.md)

## Estado tecnico

- El backend principal sigue concentrado en `server.js`
- La UI principal es funcional, pero todavia pesada y con deuda estructural
- El foco actual es estabilidad operativa, empaquetado usable y soporte en entorno real
