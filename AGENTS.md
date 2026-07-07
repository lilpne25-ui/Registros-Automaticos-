# AGENTS.md

## Goal

`Registros Automaticos` is a local/LAN operational app for industrial use. It captures production from WhatsApp, manages lots and pieces, and generates reports with a usable UI and working Windows packaging.

## Priorities

1. Keep the operational flow stable.
2. Do not break Electron packaging.
3. Prefer simple, verifiable, reversible changes.
4. Preserve compatibility with local SQLite and MSSQL when needed.

## Working Rules

- Do not invent business logic.
- Review the current flow before changing auth, backups, restore, or packaging.
- If the change touches UI, improve without rewriting the whole interface.
- Do not version secrets, active sessions, local databases, or caches unless the user explicitly asks for it.

## Important Paths

- `server.js`: main backend
- `db.js` and `db_mssql.js`: persistence layer
- `database/mssql/LaserControl.schema.sql`: canonical MSSQL bootstrap schema
- `mssql-backups/`: published MSSQL backup snapshots tracked with Git LFS
- `public/`: frontend
- `desktop/`: launcher and packaging
- `tests/`: minimum validation
- `docs/`: operational and technical documentation

## Current MSSQL State

- Active database name: `LaserControl`
- Verified instance during backup work: `TI`
- Current published backup snapshot:
  - `mssql-backups/LaserControl-20260707-164803.bak`
  - size: about `188.6 MB`
  - validated with `RESTORE VERIFYONLY`
- The repo did not have a standalone MSSQL schema file before.
- A reusable schema file now exists at:
  - `database/mssql/LaserControl.schema.sql`

## Live DB Findings

- Operational tables confirmed in the live MSSQL database:
  - `auth_users`
  - `lot_metrics`
  - `lotes`
  - `monthly_snapshots`
  - `pieces`
  - `sync_log`
  - `system_kv`
- Operational indexes confirmed:
  - `idx_pieces_lot_id`
  - `idx_pieces_messageId`
  - `idx_pieces_clientId`
  - `idx_lot_metrics_lot_id`
- The current live MSSQL database has no foreign keys enforced.
- There is one live-schema discrepancy to be aware of:
  - `dbo.system_kv.updated_at` in the live database is currently `nvarchar(max)`
  - the canonical bootstrap schema defines it as `datetime2`
  - for a fresh install, the canonical schema is the intended shape

## How To Make Another Machine Functional

Preferred path, with real data:

1. Install SQL Server and make the target instance reachable.
2. Restore `mssql-backups/LaserControl-20260707-164803.bak`.
3. Ensure the restored database name is `LaserControl`.
4. Configure `.env` or `server.env` with:
   - `USE_MSSQL=true`
   - `MSSQL_SERVER=<instance>`
   - `MSSQL_DATABASE=LaserControl`
   - `MSSQL_USER=<user>` and `MSSQL_PASSWORD=<password>` if using SQL Auth
   - or `MSSQL_CONNECTION_STRING`
5. Install app dependencies and start:
   - `npm install`
   - `npm start`
6. If using desktop packaging:
   - `node .\desktop\build-package.js`
   - run `dist\LaserControl-win32-x64\LaserControl.exe`
7. Validate:
   - `GET /healthz`
   - login flow
   - WhatsApp reconnect or QR relink if the old session is not portable

Alternative path, without real data:

1. Create an empty `LaserControl` database.
2. Run `database/mssql/LaserControl.schema.sql`.
3. Configure `.env` or `server.env` for MSSQL.
4. Start the app so bootstrap and admin seed can complete.
5. Import or migrate data later.

## Minimum Validation

```powershell
npm test
```

If release or desktop packaging changes are involved:

```powershell
node .\desktop\build-package.js
```

## Do Not Version By Default

- `.env`
- `server.env`
- `server-credentials.txt`
- `.wwebjs_auth/`
- `.wwebjs_cache/`
- `node_modules/`
- `desktop/node_modules/`
- local databases
- logs
