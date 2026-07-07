// Feature: Dashboard/KPIs (Láser + Pavonado)
// Extraído del script embebido de sistema_de_grabado_laserv1 (2025-12-18)

function loadDashboardData() {
    // Contar SOLO piezas que explícitamente tengan un proceso ('laser' o 'ambos')
    // No contar piezas en el lote global 'lotes' sin proceso asignado.
    let totalPieces = 0;
    let totalIncidents = 0;

    // Usar mapa para evitar doble conteo si una pieza aparece en varias colecciones
    const uniqueLaser = new Map();

    Object.keys(localData).forEach(lotKey => {
        const lot = localData[lotKey];
        const arr = Array.isArray(lot.pieces) ? lot.pieces : [];

        arr.forEach(p => {
            try {
                const proc = (p.proceso || '').toString().toLowerCase();
                // Incluir SOLO si tiene proceso 'laser' o 'ambos'
                if (proc !== 'laser' && proc !== 'ambos') return;

                const normalizeIdLocal = v => {
                    if (typeof v === 'string' && v.trim()) return v.trim();
                    if (typeof v === 'number') return String(v);
                    return null;
                };

                const key = normalizeIdLocal(p.uid) || normalizeIdLocal(p.messageId) || normalizeIdLocal(p.clientId) || ((p.partNumber || '') + '||' + (p.imagen || '') + '||' + (p.sourceFile || ''));
                const qty = Number(p.quantity || p.numPiezas || 0) || 0;
                const inc = Number(p.incidents || 0) || 0;
                // Solo contar incidencias si el tipo coincide con laser o ambos
                const incType = (p.incidentType || '').toLowerCase();
                const incidentsToCount = (incType === 'laser' || incType === 'ambos' || incType === '') ? inc : 0;

                if (!uniqueLaser.has(key)) {
                    uniqueLaser.set(key, { quantity: qty, incidents: incidentsToCount });
                } else {
                    const ex = uniqueLaser.get(key);
                    ex.incidents = (ex.incidents || 0) + inc;
                    uniqueLaser.set(key, ex);
                }
            } catch (e) { /* noop */ }
        });
    });

    uniqueLaser.forEach(v => {
        totalPieces += Number(v.quantity || 0);
        totalIncidents += Number(v.incidents || 0);
    });

    // Actualizar resumen por lote (SOLO piezas con proceso 'laser' o 'ambos')
    Object.keys(localData).forEach(lotKey => {
        const lot = localData[lotKey];
        const arr = Array.isArray(lot.pieces) ? lot.pieces : [];
        let lotPieces = 0;
        arr.forEach(piece => {
            const proc = (piece.proceso || '').toString().toLowerCase();
            // SOLO contar si tiene proceso 'laser' o 'ambos'
            if (proc === 'laser' || proc === 'ambos') {
                lotPieces += Number(piece.quantity || piece.numPiezas || 0) || 0;
            }
        });
        const summaryEl = document.getElementById(`${lotKey}-pieces`);
        if (summaryEl) summaryEl.textContent = lotPieces;
    });

    // Calcular KPIs
    const desiredPercentage = totalPieces > 0 ?
        ((totalPieces - totalIncidents) / totalPieces * 100).toFixed(2) + '%' : '100%';

    const maxKpi = totalPieces > 0 ?
        (totalIncidents / totalPieces * 100).toFixed(2) + '%' : '0%';

    // Actualizar dashboard (solo si los elementos existen en el DOM)
    // Calcular total global de piezas (todas las piezas registradas en localData)
    let totalGlobalPieces = 0;
    Object.keys(localData).forEach(lk => {
        const arr = Array.isArray(localData[lk].pieces) ? localData[lk].pieces : [];
        arr.forEach(p => { totalGlobalPieces += Number(p.quantity || p.numPiezas || 0) || 0; });
    });

    const topTotalEl = document.getElementById('dashboard-total-pieces');
    if (topTotalEl) topTotalEl.textContent = totalGlobalPieces;

    const totalEl = document.getElementById('total-pieces');
    if (totalEl) totalEl.textContent = totalPieces;

    const desiredEl = document.getElementById('desired-percentage');
    if (desiredEl) desiredEl.textContent = desiredPercentage;

    const reworkEl = document.getElementById('rework-pieces');
    if (reworkEl) reworkEl.textContent = totalIncidents;

    const maxEl = document.getElementById('max-kpi');
    if (maxEl) maxEl.textContent = maxKpi;

    // Aplicar colores según cumplimiento (si existen)
    if (desiredEl) desiredEl.className = desiredPercentage === '100.00%' ? 'kpi-value good' : 'kpi-value warning';
    if (maxEl) maxEl.className = parseFloat(maxKpi) <= 3 ? 'kpi-value good' : 'kpi-value warning';

    // --- Calcular KPIs para Pavonado ---
    let totalPavPieces = 0;
    let totalPavIncidents = 0;
    const uniquePav = new Map();
    Object.keys(localData).forEach(lotKey => {
        const lot = localData[lotKey];
        const arr = Array.isArray(lot.pieces) ? lot.pieces : [];
        arr.forEach(p => {
            try {
                const proc = (p.proceso || '').toString().toLowerCase();
                if (proc !== 'pavonado' && proc !== 'ambos') return;
                const normalizeIdLocal = v => {
                    if (typeof v === 'string' && v.trim()) return v.trim();
                    if (typeof v === 'number') return String(v);
                    return null;
                };
                const key = normalizeIdLocal(p.uid) || normalizeIdLocal(p.messageId) || normalizeIdLocal(p.clientId) || ((p.partNumber || '') + '||' + (p.imagen || '') + '||' + (p.sourceFile || ''));
                const qty = Number(p.quantity || p.numPiezas || 0) || 0;
                const inc = Number(p.incidents || 0) || 0;
                const incType = (p.incidentType || '').toLowerCase();
                const incidentsToCount = (incType === 'pavonado' || incType === 'ambos' || incType === '') ? inc : 0;
                if (!uniquePav.has(key)) {
                    uniquePav.set(key, { quantity: qty, incidents: incidentsToCount });
                } else {
                    const ex = uniquePav.get(key);
                    ex.incidents = (ex.incidents || 0) + inc;
                    uniquePav.set(key, ex);
                }
            } catch (e) { /* noop */ }
        });
    });
    uniquePav.forEach(v => {
        totalPavPieces += Number(v.quantity || 0);
        totalPavIncidents += Number(v.incidents || 0);
    });

    // Actualizar dashboard Pavonado
    const pavDesired = totalPavPieces > 0 ? ((totalPavPieces - totalPavIncidents) / totalPavPieces * 100).toFixed(2) + '%' : '100%';
    const pavMaxKpi = totalPavPieces > 0 ? (totalPavIncidents / totalPavPieces * 100).toFixed(2) + '%' : '0%';
    const pavTotalEl = document.getElementById('pav-total-pieces');
    const pavDesiredEl = document.getElementById('pav-desired-percentage');
    const pavReworkEl = document.getElementById('pav-rework-pieces');
    const pavMaxEl = document.getElementById('pav-max-kpi');
    if (pavTotalEl) pavTotalEl.textContent = totalPavPieces;
    if (pavDesiredEl) pavDesiredEl.textContent = pavDesired;
    if (pavReworkEl) pavReworkEl.textContent = totalPavIncidents;
    if (pavMaxEl) pavMaxEl.textContent = pavMaxKpi;
    if (pavDesiredEl) pavDesiredEl.className = pavDesired === '100.00%' ? 'kpi-value good' : 'kpi-value warning';
    if (pavMaxEl) pavMaxEl.className = parseFloat(pavMaxKpi) <= 3 ? 'kpi-value good' : 'kpi-value warning';

    // Actualizar estado de sincronización
    updateSyncStatus();
}
