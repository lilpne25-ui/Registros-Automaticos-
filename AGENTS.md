# AGENTS.md

## Objetivo

`Registros Automáticos` es una app local/LAN para operación industrial. Captura producción desde WhatsApp, administra lotes/piezas y genera reportes con una UI usable y un empaquetado Windows funcional.

## Prioridades

1. Mantener estable el flujo operativo.
2. No romper el empaquetado Electron.
3. Favorecer cambios simples, verificables y reversibles.
4. Preservar compatibilidad con SQLite local y MSSQL cuando aplique.

## Reglas de trabajo

- No inventar lógica de negocio.
- Revisar el flujo actual antes de tocar auth, backups, restore o empaquetado.
- Si el cambio toca UI, mejorar sin rehacer toda la interfaz.
- No versionar secretos, sesiones, bases locales ni caches.

## Rutas importantes

- `server.js`: backend principal
- `db.js` y `db_mssql.js`: persistencia
- `public/`: frontend
- `desktop/`: launcher y empaquetado
- `tests/`: validación mínima
- `docs/`: documentación operativa y técnica

## Validación mínima

```powershell
npm test
```

Si se toca release o desktop:

```powershell
node .\desktop\build-package.js
```

## No versionar

- `.env`
- `server.env`
- `server-credentials.txt`
- `.wwebjs_auth/`
- `.wwebjs_cache/`
- `node_modules/`
- `desktop/node_modules/`
- bases de datos locales
- logs
