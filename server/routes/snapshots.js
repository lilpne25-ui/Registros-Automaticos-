const MONTH_NAMES_ES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

async function generateCurrentSnapshot(db) {
    const allLotes = await db.getAllLots();
    const validPrefixes = ['lotes', 'whatsapp_inbox', 'laser-lot-', 'pavonado-lot-'];
    const lotes = allLotes.filter(lot => validPrefixes.some(prefix => lot.id === prefix || lot.id.startsWith(prefix)));

    const result = {};
    for (const lot of lotes) {
        const pieces = await db.getPiecesInLot(lot.id);
        const metrics = await db.getLotMetrics(lot.id);

        result[lot.id] = {
            name: lot.name,
            process: lot.process,
            pieces,
            laserMetrics: metrics.find(m => m.metric_type === 'laser')?.data || {},
            pavonadoMetrics: metrics.find(m => m.metric_type === 'pavonado')?.data || {},
            metadata: lot.metadata
        };
    }
    return result;
}

function registerSnapshotRoutes(app, ctx) {
    const { db, requirePermission } = ctx;

    app.post('/api/monthly-snapshots', requirePermission('system.reset'), async (req, res) => {
        try {
            const body = req.body || {};
            const now = new Date();
            const month = Number.isFinite(body.month) ? body.month : (now.getMonth() + 1);
            const year = Number.isFinite(body.year) ? body.year : now.getFullYear();
            const reportType = body.reportType || 'all';
            const label = body.label || `${MONTH_NAMES_ES[month - 1] || ('Mes ' + month)} ${year}`;

            const snapshotData = await generateCurrentSnapshot(db);
            const saved = await db.saveMonthlySnapshot(month, year, reportType, label, snapshotData);

            res.json({ ok: true, snapshot: saved });
        } catch (err) {
            console.error('Error en POST /api/monthly-snapshots:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/monthly-snapshots', async (req, res) => {
        try {
            const snapshots = await db.getAllMonthlySnapshots();
            res.json({ ok: true, snapshots });
        } catch (err) {
            console.error('Error en GET /api/monthly-snapshots:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/monthly-snapshots/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
            const snapshot = await db.getMonthlySnapshot(id);
            if (!snapshot) return res.status(404).json({ error: 'Snapshot no encontrado' });
            res.json({ ok: true, snapshot });
        } catch (err) {
            console.error('Error en GET /api/monthly-snapshots/:id:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.patch('/api/monthly-snapshots/:id', requirePermission('system.reset'), async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

            const body = req.body || {};
            const updates = {};

            if (Object.prototype.hasOwnProperty.call(body, 'label')) {
                const label = String(body.label || '').trim();
                if (!label) return res.status(400).json({ error: 'label requerido' });
                if (label.length > 120) return res.status(400).json({ error: 'label demasiado largo (máx 120)' });
                updates.label = label;
            }

            if (Object.prototype.hasOwnProperty.call(body, 'month')) {
                const month = Number(body.month);
                if (!Number.isInteger(month) || month < 1 || month > 12) {
                    return res.status(400).json({ error: 'month inválido (1-12)' });
                }
                updates.month = month;
            }

            if (Object.prototype.hasOwnProperty.call(body, 'year')) {
                const year = Number(body.year);
                if (!Number.isInteger(year) || year < 2000 || year > 3000) {
                    return res.status(400).json({ error: 'year inválido (2000-3000)' });
                }
                updates.year = year;
            }

            if (Object.prototype.hasOwnProperty.call(body, 'createdAt')) {
                const d = new Date(body.createdAt);
                if (!Number.isFinite(d.getTime())) return res.status(400).json({ error: 'createdAt inválido' });
                updates.createdAt = d.toISOString();
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ error: 'Sin campos para actualizar' });
            }

            const result = await db.updateMonthlySnapshotMeta(id, updates);
            if (!result || !result.updated) return res.status(404).json({ error: 'Snapshot no encontrado' });

            const snapshot = await db.getMonthlySnapshot(id);
            return res.json({ ok: true, snapshot });
        } catch (err) {
            const msg = String(err && err.message ? err.message : err);
            if (msg.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ error: 'Ya existe un snapshot para ese mes/año/tipo' });
            }
            console.error('Error en PATCH /api/monthly-snapshots/:id:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/monthly-snapshots/:id', requirePermission('system.reset'), async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
            const result = await db.deleteMonthlySnapshot(id);
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('Error en DELETE /api/monthly-snapshots/:id:', err);
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { registerSnapshotRoutes };
