# Operations Playbook

## 1. Alcance soportado

- Producto actual recomendado: `Electron + Node + SQLite + LAN/on-prem`.
- Instalacion objetivo: una planta o cliente con una maquina principal Windows y acceso local/LAN.
- `MSSQL` solo para escenarios avanzados con personal tecnico que ya administre SQL Server.

## 2. Checklist de preinstalacion

- PC Windows con permisos para instalar y ejecutar Electron.
- Google Chrome o Microsoft Edge instalado para `whatsapp-web.js`.
- Carpeta local disponible para `%LOCALAPPDATA%\LaserControl`.
- Red local estable si habra clientes por navegador.
- Acceso a WhatsApp del telefono que escaneara QR.
- Si se usara MSSQL: servidor, base, usuario y password definidos antes de arrancar.

## 3. Instalacion desktop por cliente

1. Instala o descomprime el paquete Windows.
2. Ejecuta `LaserControl.exe`.
3. Confirma que se creen:
   - `%LOCALAPPDATA%\LaserControl\server.env`
   - `%LOCALAPPDATA%\LaserControl\server-credentials.txt`
4. Guarda el archivo de credenciales iniciales en el expediente del cliente.
5. Abre `http://127.0.0.1:3000/login` si no se abre automaticamente.
6. Inicia sesion con el admin inicial y cambia password si la operacion lo requiere.
7. Escanea el QR de WhatsApp desde la UI.
8. Verifica `GET /healthz` y `GET /readyz`.

## 4. Contrato de configuracion

### Modo recomendado: SQLite

- `USE_MSSQL=false` o vacio.
- `LASER_DB_PATH` opcional.
- Si no se define `LASER_DB_PATH`, desktop usa `%LOCALAPPDATA%\LaserControl\laser_engraving.db`.

### Modo avanzado: MSSQL

Requiere explicitar:

- `USE_MSSQL=true`
- `MSSQL_SERVER`
- `MSSQL_DATABASE`
- `MSSQL_USER`
- `MSSQL_PASSWORD`

Opcionalmente:

- `MSSQL_CONNECTION_STRING`

No vender este modo como default si no sera operado por alguien con experiencia real en SQL Server.

### Variables criticas

- `AUTH_SECRET`
- `RESET_PASSWORD`
- `AUTH_ADMIN_PASSWORD`

En modo manual, si faltan `AUTH_SECRET` o `RESET_PASSWORD`, el servidor falla al arrancar.

## 5. WhatsApp y grupos autorizados

- El filtro de grupos usa `allowed_groups.json`.
- En desktop, ese archivo vive en `%LOCALAPPDATA%\LaserControl\allowed_groups.json`.
- En modo manual sin `LASERCONTROL_ENV_PATH`, por defecto vive junto a `server.js`.
- Si usas `ALLOWED_GROUPS_JSON`, bloquea la edicion del archivo desde la UI.

## 6. Backups y restore

### Ubicacion

- Desktop: `%LOCALAPPDATA%\LaserControl\backups`
- Manual: `.\backups` o la ruta definida por `LASER_BACKUP_DIR`

### Retencion

- Default: `LASER_BACKUP_KEEP_COUNT=30`
- Ajustalo segun politica del cliente.

### Frecuencia recomendada

- Minimo un backup diario si hay operacion diaria.
- Backup adicional antes de cambios de configuracion o restore.

### Restore operativo

1. Crear backup actual antes de restaurar.
2. Ejecutar restore desde `/api/backups/:fileName/restore` o por flujo UI cuando exista.
3. Verificar que piezas, snapshots y grupos autorizados vuelvan al estado esperado.
4. Registrar hora, archivo usado y responsable.

## 7. Logs para soporte

- Launcher desktop:
  - `lasercontrol.log`
  - `lasercontrol-boot.log`
- Servidor:
  - `%LOCALAPPDATA%\LaserControl\logs\server.jsonl`
  - o `.\logs\server.jsonl` en modo manual

Para soporte, pedir siempre:

- log del launcher
- `server.jsonl`
- `server.env` sin exponer secretos en tickets externos
- nombre del backup mas reciente si hubo restore

## 8. Checklist postinstalacion

- Login admin funcional.
- `healthz` responde `200`.
- QR visible o WhatsApp en estado `ready`.
- Alta de una pieza de prueba.
- Creacion de snapshot.
- Creacion y listado de backup.
- Restore probado en ambiente controlado antes de salida a produccion parcial.

## 9. Checklist de release antes de entregar

- `npm test`
- `node desktop/build-server-runtime.js`
- `node desktop/build-package.js`
- `node scripts/validate_release_artifacts.js --require-package`
- Confirmar que `dist` no contiene `.env`, `.wwebjs_auth`, `.wwebjs_cache`, `tokens.json` ni runtime duplicado.

## 10. Limites actuales

- No tratar este producto como SaaS.
- No correr multiples procesos Node contra el mismo SQLite compartido.
- El monolito backend/UI todavia existe; el sistema esta listo para despliegue controlado, no para cambios desordenados en caliente.
