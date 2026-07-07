function registerWhatsAppStatusRoutes(app, ctx) {
    const {
        path,
        rootDir,
        db,
        WHATSAPP_INBOX_LOT_ID,
        SERVER_STARTED_AT,
        AUTH_ENABLED,
        AUTH_REQUIRE_PASSWORD,
        USE_GROUP_FILTER,
        ALLOWED_GROUPS,
        ALLOWED_GROUPS_ALL,
        ALLOWED_GROUPS_SOURCE,
        isAuthenticated,
        waInitInProgress,
        waInitAttempt,
        waLastError,
        waLastRestartAt,
        waLastRestartReason,
        WHATSAPP_SESSION_DIR,
        registros,
        qrCode,
        restartWhatsAppSchema,
        restartWhatsAppClient,
        requirePermission,
        readAllowedGroupsDb,
        readAllowedGroupsFile,
        writeAllowedGroupsDb,
        writeAllowedGroupsFile,
        setAllowedGroups,
        dedupeAllowedGroupEntries,
        normalizeAllowedGroupEntries,
        addWhatsAppLog
    } = ctx;

    app.get('/qr', async (req, res) => {
        res.json({
            qr: qrCode || null,
            authenticated: !!isAuthenticated,
            initInProgress: !!waInitInProgress,
            initAttempt: waInitAttempt,
            lastError: waLastError,
            lastRestartAt: waLastRestartAt,
            sessionDir: WHATSAPP_SESSION_DIR
        });
    });

    app.get('/status', async (req, res) => {
        let engraveCount = 0;
        let lotesTotal = 0;
        let lotesNonZero = 0;
        let dbFile = null;
        try {
            const database = db.getDb();
            try {
                dbFile = (typeof db.getDbPath === 'function') ? db.getDbPath() : path.join(rootDir, 'laser_engraving.db');
            } catch (e) {
                dbFile = null;
            }
            engraveCount = await new Promise((resolve) => {
                database.get(
                    'SELECT COUNT(*) AS total FROM pieces WHERE lot_id = ?',
                    [WHATSAPP_INBOX_LOT_ID],
                    (err, row) => {
                        if (err) return resolve(0);
                        resolve(parseInt(row?.total || '0'));
                    }
                );
            });

            lotesTotal = await new Promise((resolve) => {
                database.get(
                    "SELECT COUNT(*) AS total FROM pieces WHERE lot_id = 'lotes'",
                    (err, row) => {
                        if (err) return resolve(0);
                        resolve(parseInt(row?.total || '0'));
                    }
                );
            });
            lotesNonZero = await new Promise((resolve) => {
                database.get(
                    "SELECT COUNT(*) AS total FROM pieces WHERE lot_id = 'lotes' AND quantity IS NOT NULL AND CAST(quantity AS INTEGER) > 0",
                    (err, row) => {
                        if (err) return resolve(0);
                        resolve(parseInt(row?.total || '0'));
                    }
                );
            });
        } catch (e) { /* ignore */ }

        res.json({
            startedAt: SERVER_STARTED_AT,
            auth: {
                enabled: AUTH_ENABLED,
                requirePassword: AUTH_REQUIRE_PASSWORD
            },
            authenticated: isAuthenticated,
            groupFilter: {
                enabled: USE_GROUP_FILTER,
                allowedCount: (() => { try { return Object.keys(ALLOWED_GROUPS || {}).length; } catch (e) { return 0; } })(),
                totalCount: (() => { try { return (ALLOWED_GROUPS_ALL || []).length; } catch (e) { return 0; } })()
            },
            whatsapp: {
                initInProgress: waInitInProgress,
                initAttempt: waInitAttempt,
                lastError: waLastError,
                lastRestartAt: waLastRestartAt,
                lastRestartReason: waLastRestartReason,
                sessionDir: WHATSAPP_SESSION_DIR
            },
            registros,
            engraveCount,
            lotes: {
                total: lotesTotal,
                nonZeroQty: lotesNonZero
            },
            db: {
                file: dbFile
            }
        });
    });

    app.post('/api/whatsapp/restart', requirePermission('whatsapp.restart'), async (req, res) => {
        try {
            const parsed = restartWhatsAppSchema.safeParse(req.body || {});
            if (!parsed.success) {
                return res.status(400).json({ ok: false, error: 'Payload invalido' });
            }
            const killLockedBrowser = parsed.data.killLockedBrowser;
            const result = await restartWhatsAppClient({
                reason: 'manual desde UI',
                killLockedBrowser
            });
            return res.json(result);
        } catch (e) {
            console.error('POST /api/whatsapp/restart error:', e);
            return res.status(500).json({ ok: false, error: e?.message || String(e) });
        }
    });

    app.get('/api/whatsapp/groups', requirePermission('whatsapp.groups'), (req, res) => {
        try {
            let entries = ALLOWED_GROUPS_ALL || [];
            let source = ALLOWED_GROUPS_SOURCE || 'file';
            let editable = true;

            if (process.env.ALLOWED_GROUPS_JSON) {
                source = 'env';
                editable = false;
                try {
                    entries = dedupeAllowedGroupEntries(normalizeAllowedGroupEntries(JSON.parse(process.env.ALLOWED_GROUPS_JSON)));
                } catch (e) {
                    entries = dedupeAllowedGroupEntries(normalizeAllowedGroupEntries(ALLOWED_GROUPS_ALL));
                }
            }

            const totalCount = entries.length;
            const activeCount = entries.filter(e => e && e.active !== false).length;

            return res.json({
                ok: true,
                groups: entries,
                totalCount,
                activeCount,
                filterActive: activeCount > 0,
                source,
                editable
            });
        } catch (e) {
            console.error('GET /api/whatsapp/groups error:', e);
            return res.status(500).json({ error: 'Failed to load groups' });
        }
    });

    app.post('/api/whatsapp/groups', requirePermission('whatsapp.groups'), async (req, res) => {
        try {
            if (process.env.ALLOWED_GROUPS_JSON) {
                return res.status(409).json({ error: 'ALLOWED_GROUPS_JSON activo. Edicion bloqueada.' });
            }

            const body = req.body || {};
            const id = String(body.id || '').trim();
            if (!id) return res.status(400).json({ error: 'id required' });

            const name = String(body.name || '').trim();
            const active = body.active !== false;

            const database = db.getDb();
            let entries = await readAllowedGroupsDb(database);
            if (!entries.length) entries = readAllowedGroupsFile();

            const existing = entries.find(e => e.id === id);
            if (existing) {
                existing.name = name || existing.name || id;
                existing.active = active;
            } else {
                entries.push({ id, name: name || id, active });
            }

            const normalized = dedupeAllowedGroupEntries(entries);
            await writeAllowedGroupsDb(database, normalized);
            writeAllowedGroupsFile(normalized);
            setAllowedGroups(normalized, 'db');

            addWhatsAppLog('group', `Grupo agregado/actualizado: ${id}`, { id, name: name || id, active }, 'info');

            const totalCount = normalized.length;
            const activeCount = normalized.filter(e => e.active !== false).length;
            return res.json({ ok: true, groups: normalized, totalCount, activeCount, filterActive: activeCount > 0 });
        } catch (e) {
            console.error('POST /api/whatsapp/groups error:', e);
            return res.status(500).json({ error: 'Failed to save group' });
        }
    });

    app.put('/api/whatsapp/groups/:id', requirePermission('whatsapp.groups'), async (req, res) => {
        try {
            if (process.env.ALLOWED_GROUPS_JSON) {
                return res.status(409).json({ error: 'ALLOWED_GROUPS_JSON activo. Edicion bloqueada.' });
            }

            const id = String(req.params.id || '').trim();
            if (!id) return res.status(400).json({ error: 'id required' });

            const body = req.body || {};
            const name = typeof body.name === 'string' ? body.name.trim() : null;
            const active = body.active !== undefined ? body.active !== false : undefined;

            const database = db.getDb();
            let entries = await readAllowedGroupsDb(database);
            if (!entries.length) entries = readAllowedGroupsFile();

            const existing = entries.find(e => e.id === id);
            if (!existing) return res.status(404).json({ error: 'group not found' });

            if (name !== null) existing.name = name || existing.name || id;
            if (active !== undefined) existing.active = active;

            const normalized = dedupeAllowedGroupEntries(entries);
            await writeAllowedGroupsDb(database, normalized);
            writeAllowedGroupsFile(normalized);
            setAllowedGroups(normalized, 'db');

            addWhatsAppLog('group', `Grupo actualizado: ${id}`, { id, name: existing.name, active: existing.active }, 'info');

            const totalCount = normalized.length;
            const activeCount = normalized.filter(e => e.active !== false).length;
            return res.json({ ok: true, groups: normalized, totalCount, activeCount, filterActive: activeCount > 0 });
        } catch (e) {
            console.error('PUT /api/whatsapp/groups error:', e);
            return res.status(500).json({ error: 'Failed to update group' });
        }
    });

    app.delete('/api/whatsapp/groups/:id', requirePermission('whatsapp.groups'), async (req, res) => {
        try {
            if (process.env.ALLOWED_GROUPS_JSON) {
                return res.status(409).json({ error: 'ALLOWED_GROUPS_JSON activo. Edicion bloqueada.' });
            }

            const id = String(req.params.id || '').trim();
            if (!id) return res.status(400).json({ error: 'id required' });

            const database = db.getDb();
            let entries = await readAllowedGroupsDb(database);
            if (!entries.length) entries = readAllowedGroupsFile();

            const filtered = entries.filter(e => e.id !== id);
            const normalized = dedupeAllowedGroupEntries(filtered);
            await writeAllowedGroupsDb(database, normalized);
            writeAllowedGroupsFile(normalized);
            setAllowedGroups(normalized, 'db');

            addWhatsAppLog('group', `Grupo eliminado: ${id}`, { id }, 'warn');

            const totalCount = normalized.length;
            const activeCount = normalized.filter(e => e.active !== false).length;
            return res.json({ ok: true, groups: normalized, totalCount, activeCount, filterActive: activeCount > 0 });
        } catch (e) {
            console.error('DELETE /api/whatsapp/groups error:', e);
            return res.status(500).json({ error: 'Failed to delete group' });
        }
    });

    app.get('/api/whatsapp/logs', requirePermission('whatsapp.logs'), (req, res) => {
        try {
            const limit = Math.max(10, Math.min(1000, parseInt(req.query.limit || '200', 10) || 200));
            const logs = ctx.getWhatsAppLogs().slice(-limit);
            return res.json({ ok: true, logs, total: ctx.getWhatsAppLogs().length });
        } catch (e) {
            console.error('GET /api/whatsapp/logs error:', e);
            return res.status(500).json({ error: 'Failed to load logs' });
        }
    });

    app.post('/api/whatsapp/logs/clear', requirePermission('whatsapp.logs'), (req, res) => {
        try {
            ctx.setWhatsAppLogs([]);
            return res.json({ ok: true });
        } catch (e) {
            console.error('POST /api/whatsapp/logs/clear error:', e);
            return res.status(500).json({ error: 'Failed to clear logs' });
        }
    });
}

module.exports = { registerWhatsAppStatusRoutes };
