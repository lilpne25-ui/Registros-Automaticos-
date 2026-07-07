// Feature: Historial de Reportes Mensuales
// Muestra lista de snapshots guardados al hacer cierre de mes
// Permite ver reportes históricos sin borrar datos actuales

(function () {
    'use strict';

    const MONTH_NAMES = [
        'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
        'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'
    ];

    const MONTH_COLORS = [
        '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706',
        '#65a30d', '#16a34a', '#0d9488', '#0891b2', '#4f46e5', '#9333ea'
    ];

    function getServerUrl() {
        return window.App?.config?.serverUrl || window.SERVER_URL || window.location.origin;
    }

    let currentSnapshotId = null;
    let currentSnapshot = null;

    function notify(message, type = 'info', duration = 2400) {
        try {
            if (typeof window.showNotification === 'function') {
                window.showNotification(message, type, duration);
                return;
            }
        } catch (e) {
            // noop
        }
        if (type === 'error' || type === 'warning') {
            try { window.alert(String(message || '')); } catch (e) { /* noop */ }
        }
    }

    function normalizeMonthCase(value) {
        const t = String(value || '').trim();
        if (!t) return '';
        if (t === t.toUpperCase()) {
            return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
        }
        return t;
    }

    function parseSnapshotLabelParts(labelRaw) {
        const fullLabel = String(labelRaw || '').trim();
        if (!fullLabel) return { fullLabel: '', monthText: '', yearInLabel: null };

        const m = fullLabel.match(/^(.*?)(?:\s+(\d{4}))?$/);
        const monthText = (m && m[1] ? m[1].trim() : fullLabel) || fullLabel;
        const yearInLabel = (m && m[2]) ? Number(m[2]) : null;
        return {
            fullLabel,
            monthText,
            yearInLabel: Number.isFinite(yearInLabel) ? yearInLabel : null
        };
    }

    function getSnapshotMonthName(snapshot) {
        const parts = parseSnapshotLabelParts(snapshot?.label);
        if (parts.monthText) return parts.monthText;
        const monthNum = Number(snapshot?.month);
        return MONTH_NAMES[monthNum - 1] || `Mes ${monthNum || ''}`;
    }

    function getSnapshotDisplayTitle(snapshot) {
        const parts = parseSnapshotLabelParts(snapshot?.label);
        if (parts.fullLabel) return parts.fullLabel;
        const monthText = normalizeMonthCase(getSnapshotMonthName(snapshot));
        const year = Number(snapshot?.year);
        return Number.isInteger(year) ? `${monthText} ${year}` : monthText;
    }

    function formatSnapshotCreatedDate(value) {
        try {
            if (!value) return '';
            const d = new Date(value);
            if (!Number.isFinite(d.getTime())) return '';
            return d.toLocaleString('es-MX', {
                day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        } catch (e) {
            return '';
        }
    }

    function toPromptDateTime(value) {
        let d = new Date(value || Date.now());
        if (!Number.isFinite(d.getTime())) d = new Date();

        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    }

    function parsePromptDateTime(raw) {
        const text = String(raw || '').trim();
        if (!text) return null;

        const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
        if (m) {
            const yyyy = Number(m[1]);
            const mm = Number(m[2]);
            const dd = Number(m[3]);
            const hh = Number(m[4] || '0');
            const mi = Number(m[5] || '0');
            const d = new Date(yyyy, mm - 1, dd, hh, mi, 0, 0);
            if (Number.isFinite(d.getTime())) return d;
            return null;
        }

        const fallback = new Date(text);
        return Number.isFinite(fallback.getTime()) ? fallback : null;
    }

    function buildSnapshotLabel(monthName, year) {
        const monthText = String(monthName || '').trim();
        if (!monthText) return String(year || '').trim();
        if (/\b\d{4}\b/.test(monthText)) return monthText;
        return `${monthText} ${year}`;
    }

    // Resolver ruta de imagen (base64, URL o nombre de archivo)
    function resolveSnapshotImageSrc(raw) {
        if (!raw) return null;
        const s = String(raw);
        if (s === '(snapshot-excluded)') return null;
        if (s.startsWith('data:')) return s;
        if (s.startsWith('http://') || s.startsWith('https://')) return s;
        return `${getServerUrl()}/engrave/${encodeURIComponent(s)}`;
    }

    // ========== Listar snapshots ==========
    async function loadSnapshotsList() {
        const container = document.getElementById('historial-snapshots-list');
        const viewer = document.getElementById('historial-snapshot-viewer');
        if (!container) return;

        // Ocultar viewer, mostrar lista
        if (viewer) viewer.style.display = 'none';
        container.style.display = 'flex';

        try {
            const resp = await fetch(`${getServerUrl()}/api/monthly-snapshots`, { credentials: 'include' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const snapshots = data.snapshots || [];

            if (snapshots.length === 0) {
                container.innerHTML = `
                    <div style="text-align:center; padding:40px 20px; color:#888; width:100%;">
                        <div style="font-size:48px; margin-bottom:16px;">📋</div>
                        <h3 style="margin:0 0 8px 0; color:#666;">No hay reportes guardados</h3>
                        <p style="margin:0;">Los reportes se guardan automáticamente al hacer <strong>Cierre de Mes</strong> desde el Dashboard.</p>
                    </div>
                `;
                return;
            }

            // Agrupar por año
            const byYear = {};
            snapshots.forEach(s => {
                if (!byYear[s.year]) byYear[s.year] = [];
                byYear[s.year].push(s);
            });

            let html = '';
            const years = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));

            years.forEach(year => {
                html += `<div style="width:100%; margin-bottom:8px;"><h3 style="margin:0 0 12px 0; color:#374151; border-bottom:2px solid #e5e7eb; padding-bottom:8px;">📅 ${year}</h3></div>`;

                const snaps = byYear[year].sort((a, b) => a.month - b.month);
                snaps.forEach(s => {
                    const monthName = getSnapshotMonthName(s);
                    const cardMonth = String(monthName || `Mes ${s.month}`).toUpperCase();
                    const color = MONTH_COLORS[(s.month - 1) % 12];
                    const typeLabel = s.report_type === 'all' ? 'Láser + Pavonado' :
                        s.report_type === 'laser' ? '🔵 Láser' :
                        s.report_type === 'pavonado' ? '🟣 Pavonado' : s.report_type;

                    const createdDate = formatSnapshotCreatedDate(s.created_at);

                    html += `
                        <div class="historial-month-card" data-snapshot-id="${s.id}" 
                             style="background:linear-gradient(135deg, ${color}15, ${color}08); border:2px solid ${color}40; 
                                    border-radius:12px; padding:16px 20px; cursor:pointer; transition:all 0.2s; min-width:200px; flex:1; max-width:300px;
                                    box-shadow: 0 2px 8px rgba(0,0,0,0.06);"
                             onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 16px rgba(0,0,0,0.12)'"
                             onmouseout="this.style.transform=''; this.style.boxShadow='0 2px 8px rgba(0,0,0,0.06)'">
                            <div style="font-size:28px; font-weight:800; color:${color}; margin-bottom:4px;">${cardMonth}</div>
                            <div style="font-size:13px; color:#666; margin-bottom:4px;">${typeLabel}</div>
                            <div style="font-size:11px; color:#999;">${createdDate}</div>
                        </div>
                    `;
                });
            });

            container.innerHTML = html;

            // Vincular clicks
            container.querySelectorAll('.historial-month-card').forEach(card => {
                card.addEventListener('click', function () {
                    const id = this.getAttribute('data-snapshot-id');
                    if (id) loadSnapshotDetail(Number(id));
                });
            });

        } catch (err) {
            console.error('Error cargando historial de snapshots:', err);
            container.innerHTML = `<div style="color:#dc2626; padding:20px;">Error cargando historial: ${err.message}</div>`;
        }
    }

    // ========== Ver detalle de un snapshot ==========
    async function loadSnapshotDetail(snapshotId) {
        const container = document.getElementById('historial-snapshots-list');
        const viewer = document.getElementById('historial-snapshot-viewer');
        if (!viewer) return;

        currentSnapshotId = Number(snapshotId);
        currentSnapshot = null;

        // Ocultar lista, mostrar viewer
        if (container) container.style.display = 'none';
        viewer.style.display = 'block';

        const titleEl = document.getElementById('historial-viewer-title');
        const kpiDiv = document.getElementById('historial-kpi-summary');
        const lotesDiv = document.getElementById('historial-lotes-detail');
        const incidentsDiv = document.getElementById('historial-incidents-section');

        if (titleEl) titleEl.textContent = 'Cargando...';
        if (kpiDiv) kpiDiv.innerHTML = '';
        if (lotesDiv) lotesDiv.innerHTML = '';
        if (incidentsDiv) incidentsDiv.innerHTML = '';

        try {
            const resp = await fetch(`${getServerUrl()}/api/monthly-snapshots/${snapshotId}`, { credentials: 'include' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const snap = data.snapshot;
            if (!snap) throw new Error('Snapshot no encontrado');

            currentSnapshot = snap;
            currentSnapshotId = Number(snap.id || snapshotId);

            const monthName = normalizeMonthCase(getSnapshotMonthName(snap));
            const titleText = getSnapshotDisplayTitle(snap);
            const yearNum = Number(snap.year);
            const displayYear = Number.isInteger(yearNum)
                ? yearNum
                : new Date(snap.created_at || Date.now()).getFullYear();
            if (titleEl) titleEl.textContent = `📊 Reporte: ${titleText}`;

            const snapData = snap.snapshot_data || {};
            renderFullSnapshot(snapData, monthName, displayYear, kpiDiv, lotesDiv, incidentsDiv);

        } catch (err) {
            console.error('Error cargando snapshot:', err);
            if (titleEl) titleEl.textContent = 'Error';
            if (kpiDiv) kpiDiv.innerHTML = `<div style="color:#dc2626; padding:16px;">Error: ${err.message}</div>`;
        }
    }

    async function editCurrentSnapshotMeta() {
        try {
            if (!currentSnapshot || !currentSnapshotId) {
                notify('Abre primero un reporte del historial.', 'warning', 2800);
                return;
            }

            if (typeof window.hasPermission === 'function' && !window.hasPermission('system.reset')) {
                notify('No tienes permiso para editar el historial.', 'error', 3000);
                return;
            }

            const currentMonthName = getSnapshotMonthName(currentSnapshot);
            const monthInput = window.prompt(
                'Nombre del mes a mostrar (ej. Mayo):',
                currentMonthName
            );
            if (monthInput === null) return;

            const monthName = String(monthInput || '').trim();
            if (!monthName) {
                notify('El nombre del mes no puede estar vacío.', 'warning', 3000);
                return;
            }

            const dateInput = window.prompt(
                'Fecha y hora visible (formato: YYYY-MM-DD HH:mm):',
                toPromptDateTime(currentSnapshot.created_at)
            );
            if (dateInput === null) return;

            const parsedDate = parsePromptDateTime(dateInput);
            if (!parsedDate) {
                notify('Fecha inválida. Usa formato YYYY-MM-DD HH:mm', 'error', 4000);
                return;
            }

            const year = parsedDate.getFullYear();
            const month = parsedDate.getMonth() + 1;
            const payload = {
                label: buildSnapshotLabel(monthName, year),
                month,
                year,
                createdAt: parsedDate.toISOString()
            };

            const resp = await fetch(`${getServerUrl()}/api/monthly-snapshots/${currentSnapshotId}`, {
                method: 'PATCH',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            let data = null;
            try { data = await resp.json(); } catch (e) { data = null; }
            if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

            currentSnapshot = data?.snapshot || {
                ...currentSnapshot,
                ...payload,
                created_at: payload.createdAt
            };

            notify('✅ Historial actualizado correctamente.', 'success', 2500);
            await loadSnapshotDetail(currentSnapshotId);
        } catch (err) {
            console.error('Error editando snapshot:', err);
            notify(`❌ No se pudo actualizar: ${err.message}`, 'error', 4000);
        }
    }

    // ========== Generar encabezado estilo Innovax ==========
    function buildReportHeader(titulo, monthName, year, codigoDoc) {
        const logoUrl = `${getServerUrl()}/logo-innovax.png`;
        return `
        <div style="margin-bottom:20px;">
            <table style="width:100%; border-collapse:collapse; border:2px solid #333;">
                <tr style="height:80px;">
                    <td style="width:20%; padding:10px; border-right:1px solid #333; text-align:center; vertical-align:middle;">
                        <img src="${logoUrl}" alt="INNOVAX" style="max-height:55px; max-width:120px;" onerror="this.outerHTML='<div style=\\'font-size:12px;font-weight:bold;\\'>INNOVAX<br/>GRUPO INDUSTRIAL</div>'" />
                    </td>
                    <td style="width:60%; padding:10px; border-right:1px solid #333; text-align:center; vertical-align:middle;">
                        <div style="font-size:16px; font-weight:800;">${titulo}</div>
                    </td>
                    <td style="width:20%; padding:10px; text-align:center; vertical-align:middle;">
                        <div style="font-size:11px;">
                            <div style="font-weight:700;">Código: ${codigoDoc}</div>
                            <div style="margin-top:4px;">Rev. 0</div>
                            <div style="margin-top:4px;">Emisión: Octubre 2025</div>
                        </div>
                    </td>
                </tr>
            </table>
            <table style="width:100%; border-collapse:collapse; border:2px solid #333; border-top:none;">
                <tr>
                    <td style="width:70%; padding:10px; text-align:center; border-right:1px solid #333;">
                        <div style="font-weight:700; font-size:13px;">KPI del Mes de ${monthName}</div>
                    </td>
                    <td style="width:30%; padding:10px; text-align:center;">
                        <div style="font-weight:700; font-size:13px;">${monthName} ${year}</div>
                    </td>
                </tr>
            </table>
        </div>`;
    }

    // ========== Renderizar snapshot completo separado por proceso ==========
    function renderFullSnapshot(snapData, monthName, year, kpiDiv, lotesDiv, incidentsDiv) {
        // Clasificar datos
        let totalLaser = 0, totalPavonado = 0;
        let incLaser = 0, incPavonado = 0;
        const laserLots = [], pavLots = [];
        const laserIncidents = [], pavIncidents = [];

        const lotEntries = Object.keys(snapData)
            .filter(k => k !== 'lotes')
            .map(k => ({ key: k, lot: snapData[k] }))
            .filter(e => e.lot && Array.isArray(e.lot.pieces))
            .sort((a, b) => (a.lot.name || '').localeCompare(b.lot.name || ''));

        lotEntries.forEach(({ key, lot }) => {
            if (lot.process === 'laser') laserLots.push({ key, lot });
            if (lot.process === 'pavonado') pavLots.push({ key, lot });

            lot.pieces.forEach(p => {
                const proc = (p.proceso || '').toLowerCase();
                const qty = Number(p.quantity || 0) || 0;
                const inc = Number(p.incidents || 0) || 0;

                if (proc === 'laser' || proc === 'ambos') {
                    totalLaser += qty;
                    incLaser += inc;
                }
                if (proc === 'pavonado' || proc === 'ambos') {
                    totalPavonado += qty;
                    incPavonado += inc;
                }

                if (inc > 0) {
                    const incData = {
                        lotName: lot.name || key,
                        partNumber: p.partNumber || '-',
                        quantity: p.quantity || 0,
                        incidents: inc,
                        incidentType: p.incidentType || '-',
                        proceso: p.proceso || '-',
                        imagen: p.imagen || null
                    };
                    if (proc === 'laser' || proc === 'ambos') laserIncidents.push(incData);
                    if (proc === 'pavonado' || proc === 'ambos') pavIncidents.push(incData);
                }
            });
        });

        const hasLaser = laserLots.length > 0 || totalLaser > 0;
        const hasPavonado = pavLots.length > 0 || totalPavonado > 0;

        // ═══════════════════════════════════════
        // REPORTE LÁSER
        // ═══════════════════════════════════════
        let laserHtml = '';
        if (hasLaser) {
            laserHtml += buildReportHeader('Registro Grabado Láser', monthName, year, 'FP-17-B');

            const laserDesiredPct = totalLaser > 0 ? ((totalLaser - incLaser) / totalLaser * 100).toFixed(2) + '%' : '100%';
            const laserMaxKpi = totalLaser > 0 ? (incLaser / totalLaser * 100).toFixed(2) + '%' : '0%';

            laserHtml += `
            <h2 style="color:#2563eb; margin:0 0 16px 0;">Reporte Mensual de Grabado Láser - RESULTADOS DEL MES</h2>
            <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
                <thead>
                    <tr style="background:#f5f5f5;">
                        <th style="padding:10px; text-align:left; border:1px solid #ddd;">Indicador (KPI)</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Resultados Esperados</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Método de medición / fuente de datos</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Valores Cuantificables</th>
                        <th style="padding:10px; text-align:left; border:1px solid #ddd;">Objetivo o Interpretación</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Piezas a grabar</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${totalLaser}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Registro automático de piezas aprobadas</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${totalLaser}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Medir la productividad del grabado diario.</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Porcentaje de Grabados Deseados</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">100%</td>
                        <td style="padding:8px; border:1px solid #ddd;">Inspección visual</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${laserDesiredPct}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Evaluar precisión y calidad del grabado.</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">PIEZAS A RETRABAJAR</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">0</td>
                        <td style="padding:8px; border:1px solid #ddd;">Cantidad de piezas con Retrabajo</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${incLaser}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Tener el menos posible de piezas con Retrabajo</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">% KPI MÁXIMO</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">3%</td>
                        <td style="padding:8px; border:1px solid #ddd;">KPI Obtenido</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${laserMaxKpi}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Estar dentro de los Límites de 3%</td>
                    </tr>
                </tbody>
            </table>`;

            // Incidencias Láser
            laserHtml += buildIncidentsTable(laserIncidents, 'LÁSER');

            // Métricas por lote Láser
            laserLots.forEach(({ key, lot }) => {
                laserHtml += buildLaserLotMetrics(key, lot);
            });
        }

        // ═══════════════════════════════════════
        // REPORTE PAVONADO
        // ═══════════════════════════════════════
        let pavHtml = '';
        if (hasPavonado) {
            // Separador visual
            if (hasLaser) {
                pavHtml += `<hr style="margin:40px 0; border:none; border-top:3px solid #e5e7eb;">`;
            }

            pavHtml += buildReportHeader('Registro Pavonado', monthName, year, 'FP-17-C');

            const pavDesiredPct = totalPavonado > 0 ? ((totalPavonado - incPavonado) / totalPavonado * 100).toFixed(2) + '%' : '100%';
            const pavMaxKpi = totalPavonado > 0 ? (incPavonado / totalPavonado * 100).toFixed(2) + '%' : '0%';

            pavHtml += `
            <h2 style="color:#7c3aed; margin:0 0 16px 0;">Reporte Mensual Pavonado - RESULTADOS DEL MES</h2>
            <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
                <thead>
                    <tr style="background:#f5f5f5;">
                        <th style="padding:10px; text-align:left; border:1px solid #ddd;">Indicador (KPI)</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Resultados Esperados</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Método de medición / fuente de datos</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Valores Cuantificables</th>
                        <th style="padding:10px; text-align:left; border:1px solid #ddd;">Objetivo o Interpretación</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Piezas a Pavonar</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${totalPavonado}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Registro automático de piezas aprobadas</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${totalPavonado}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Medir la productividad del pavonado diario.</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Porcentaje de Pavonado Deseados</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">100%</td>
                        <td style="padding:8px; border:1px solid #ddd;">Inspección visual</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${pavDesiredPct}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Evaluar precisión y calidad del pavonado</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">PIEZAS A RETRABAJAR</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">0</td>
                        <td style="padding:8px; border:1px solid #ddd;">Cantidad de piezas con Retrabajo</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${incPavonado}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Tener el menos posible de piezas con Retrabajo</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">% KPI MÁXIMO</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">3%</td>
                        <td style="padding:8px; border:1px solid #ddd;">KPI Obtenido</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${pavMaxKpi}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Estar dentro de los Límites de 3%</td>
                    </tr>
                </tbody>
            </table>`;

            // Incidencias Pavonado
            pavHtml += buildIncidentsTable(pavIncidents, 'PAVONADO');

            // Métricas por lote Pavonado
            pavLots.forEach(({ key, lot }) => {
                pavHtml += buildPavonadoLotMetrics(key, lot);
            });
        }

        // Insertar en los contenedores
        if (kpiDiv) kpiDiv.innerHTML = laserHtml;
        if (lotesDiv) lotesDiv.innerHTML = pavHtml;
        if (incidentsDiv) incidentsDiv.innerHTML = '';
    }

    // ========== Tabla de incidencias por proceso ==========
    function buildIncidentsTable(incidents, processLabel) {
        if (incidents.length === 0) {
            return `
                <div style="padding:12px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; text-align:center; margin-bottom:20px;">
                    ✅ <strong>Sin incidencias registradas (${processLabel})</strong>
                </div>`;
        }

        let html = `
            <h3 style="margin-top:24px;">DETALLE DE PIEZAS CON INCIDENCIAS (${processLabel})</h3>
            <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
                <thead>
                    <tr style="background:#f0f0f0;">
                        <th style="padding:8px; text-align:center; border:1px solid #ddd;">Foto</th>
                        <th style="padding:8px; text-align:left; border:1px solid #ddd;">Número de Parte</th>
                        <th style="padding:8px; text-align:center; border:1px solid #ddd;">Cantidad de Piezas</th>
                        <th style="padding:8px; text-align:center; border:1px solid #ddd;">Nº Incidencias</th>
                        <th style="padding:8px; text-align:left; border:1px solid #ddd;">Tipo de Incidencia</th>
                        <th style="padding:8px; text-align:center; border:1px solid #ddd;">Proceso(s)</th>
                    </tr>
                </thead>
                <tbody>`;

        incidents.forEach(i => {
            const proc = (i.proceso || '').toLowerCase();
            const procDisplay = proc === 'laser' ? '🔵 Láser' :
                proc === 'pavonado' ? '🟣 Pavonado' :
                proc === 'ambos' ? '🔵 Láser<br/>🟣 Pavonado' : i.proceso;
            const imgSrc = resolveSnapshotImageSrc(i.imagen);
            const imgCell = imgSrc
                ? `<td style="padding:8px; text-align:center; border:1px solid #ddd; width:260px;"><img src="${imgSrc}" loading="lazy" alt="img" style="max-width:240px;max-height:180px;border-radius:8px;object-fit:cover;cursor:zoom-in;" onerror="this.style.display='none'" onclick="if(typeof openImageModal==='function') openImageModal('${imgSrc.replace(/'/g, "\\'")}')"/></td>`
                : `<td style="padding:8px; text-align:center; border:1px solid #ddd; color:#999;">Sin foto</td>`;
            html += `
                <tr>
                    ${imgCell}
                    <td style="padding:8px; border:1px solid #ddd;">${i.partNumber}</td>
                    <td style="padding:8px; text-align:center; border:1px solid #ddd;">${i.quantity}</td>
                    <td style="padding:8px; text-align:center; border:1px solid #ddd; color:#dc2626; font-weight:700;">${i.incidents}</td>
                    <td style="padding:8px; border:1px solid #ddd;">${i.incidentType}</td>
                    <td style="padding:8px; text-align:center; border:1px solid #ddd;">${procDisplay}</td>
                </tr>`;
        });

        html += '</tbody></table>';
        return html;
    }

    // ========== Métricas por lote LÁSER ==========
    function buildLaserLotMetrics(key, lot) {
        const sumPieces = lot.pieces.reduce((s, p) => s + (Number(p.quantity || 0) || 0), 0);
        const countDefective = lot.pieces.reduce((c, p) => c + (p.incidents > 0 ? 1 : 0), 0);
        const m = lot.laserMetrics || {};

        const vals = {
            piezas_grabadas: (m.piezas_grabadas !== undefined && m.piezas_grabadas !== null && m.piezas_grabadas !== '') ? m.piezas_grabadas : sumPieces,
            piezas_retrabajo: (m.piezas_retrabajo !== undefined && m.piezas_retrabajo !== null && m.piezas_retrabajo !== '') ? m.piezas_retrabajo : countDefective,
            tiempo_promedio: m.tiempo_promedio || '-',
            potencia_laser: m.potencia_laser || '-',
            velocidad_grabado: m.velocidad_grabado || '-'
        };
        const exp = {
            piezas_grabadas: m.piezas_grabadas_expected ?? sumPieces,
            piezas_retrabajo: m.piezas_retrabajo_expected || '0',
            tiempo_promedio: m.tiempo_promedio_expected || '1h por dispositivo',
            potencia_laser: m.potencia_laser_expected || '40 Watts (W)',
            velocidad_grabado: m.velocidad_grabado_expected || '2000 mm/s'
        };

        return `
        <div style="margin-top:20px; border:1px solid #ddd; padding:15px; border-radius:4px;">
            <h3>Métricas Láser - ${lot.name || key}</h3>
            <table style="width:100%; border-collapse:collapse;">
                <thead>
                    <tr style="background-color:#f5f5f5;">
                        <th style="padding:10px; text-align:left; border:1px solid #ddd;">Indicador (KPI)</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">RESULTADOS ESPERADOS</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Método de medición</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Valor Cuantificable</th>
                        <th style="padding:10px; text-align:left; border:1px solid #ddd;">Objetivo</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Piezas grabadas</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.piezas_grabadas}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Registro automático</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.piezas_grabadas}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Productividad del grabado</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Piezas a retrabajo</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.piezas_retrabajo}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Cantidad con retrabajo</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.piezas_retrabajo}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Precisión y calidad</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Tiempo promedio de grabado</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.tiempo_promedio}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Cronometraje</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.tiempo_promedio}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Tiempos de operación</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Potencia del láser</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.potencia_laser}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Verificación potencia</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.potencia_laser}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Rango establecido</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Velocidad de grabado</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.velocidad_grabado}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Configuración software</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.velocidad_grabado}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Buena definición</td>
                    </tr>
                </tbody>
            </table>
            ${renderSnapshotPiecePhotos(lot.pieces)}
        </div>`;
    }

    // ========== Métricas por lote PAVONADO ==========
    function buildPavonadoLotMetrics(key, lot) {
        const sumPieces = lot.pieces.reduce((s, p) => s + (Number(p.quantity || 0) || 0), 0);
        const countDefective = lot.pieces.reduce((c, p) => c + (p.incidents > 0 ? 1 : 0), 0);
        const m = lot.pavonadoMetrics || {};

        const vals = {
            piezas_pavonadas: (m.piezas_pavonadas !== undefined && m.piezas_pavonadas !== null && m.piezas_pavonadas !== '') ? m.piezas_pavonadas : sumPieces,
            piezas_defectos: (m.piezas_defectos !== undefined && m.piezas_defectos !== null && m.piezas_defectos !== '') ? m.piezas_defectos : countDefective,
            temp_banho: m.temp_banho || '-',
            tiempo_inmersion: m.tiempo_inmersion || '-',
            consumo_quimico: m.consumo_quimico || '-',
            piezas_reprocesadas: (m.piezas_reprocesadas !== undefined && m.piezas_reprocesadas !== null && m.piezas_reprocesadas !== '') ? m.piezas_reprocesadas : countDefective,
            piezas_rechazadas: (m.piezas_rechazadas !== undefined && m.piezas_rechazadas !== null && m.piezas_rechazadas !== '') ? m.piezas_rechazadas : '-',
            temp_ambiente: m.temp_ambiente || '-'
        };
        const exp = {
            piezas_pavonadas: m.piezas_pavonadas_expected ?? sumPieces,
            piezas_defectos: m.piezas_defectos_expected || '0-3',
            temp_banho: m.temp_banho_expected || '140°C',
            tiempo_inmersion: m.tiempo_inmersion_expected || '25Minutos',
            consumo_quimico: m.consumo_quimico_expected || '25Litros / lote',
            piezas_reprocesadas: m.piezas_reprocesadas_expected || '0-5',
            piezas_rechazadas: m.piezas_rechazadas_expected || '0',
            temp_ambiente: m.temp_ambiente_expected || '25°C'
        };

        return `
        <div style="margin-top:20px; border:1px solid #ddd; padding:15px; border-radius:4px;">
            <h3>Métricas Pavonado - ${lot.name || key}</h3>
            <table style="width:100%; border-collapse:collapse;">
                <thead>
                    <tr style="background-color:#f5f5f5;">
                        <th style="padding:10px; text-align:left; border:1px solid #ddd;">Indicador (KPI)</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">RESULTADOS ESPERADOS</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Método de medición</th>
                        <th style="padding:10px; text-align:center; border:1px solid #ddd;">Valor Cuantificable</th>
                        <th style="padding:10px; text-align:left; border:1px solid #ddd;">Objetivo</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Piezas pavonadas</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.piezas_pavonadas}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Registro de producción</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.piezas_pavonadas}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Volumen de producción</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Piezas con defectos (0-3)</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.piezas_defectos}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Inspección visual</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.piezas_defectos}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Calidad del recubrimiento</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Temperatura del baño</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.temp_banho}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Termómetro industrial</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.temp_banho}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Condiciones térmicas</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Tiempo de inmersión</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.tiempo_inmersion}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Cronómetro/temporizador</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.tiempo_inmersion}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Uniformidad del recubrimiento</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Consumo de solución química</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.consumo_quimico}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Registro de insumos</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.consumo_quimico}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Gasto y rendimiento</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; border:1px solid #ddd;">Piezas reprocesadas (0-5)</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${exp.piezas_reprocesadas}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Registro de retrabajos</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${vals.piezas_reprocesadas}</td>
                        <td style="padding:8px; border:1px solid #ddd;">Eficiencia del proceso</td>
                    </tr>
                </tbody>
            </table>
            ${renderSnapshotPiecePhotos(lot.pieces)}
        </div>`;
    }

    // ========== Renderizar fotos de piezas de un lote del snapshot ==========
    function renderSnapshotPiecePhotos(pieces) {
        const list = Array.isArray(pieces) ? pieces : [];
        const withImg = list
            .map(p => ({
                partNumber: p?.partNumber ?? '-',
                quantity: Number(p?.quantity ?? 0) || 0,
                imgSrc: resolveSnapshotImageSrc(p?.imagen || p?.imagenPath || p?.image || p?.imagePath || null)
            }))
            .filter(x => !!x.imgSrc);

        if (withImg.length === 0) {
            return '<div style="margin-top:10px;color:#777;font-size:12px;">Sin fotos registradas en este lote.</div>';
        }

        const MAX = 36;
        const shown = withImg.slice(0, MAX);
        const hidden = withImg.length - shown.length;

        const cards = shown.map(x => {
            const safeSrc = String(x.imgSrc).replace(/'/g, "\\'");
            return `
                <div style="width:280px; border:1px solid #e5e7eb; border-radius:10px; padding:10px; background:#fff;">
                    <div style="width:100%; height:200px; display:flex; align-items:center; justify-content:center; overflow:hidden; border-radius:8px; background:#f8fafc;">
                        <img src="${x.imgSrc}" loading="lazy" alt="img" style="width:100%;height:200px;object-fit:cover;cursor:zoom-in" onerror="this.style.display='none'" onclick="if(typeof openImageModal==='function') openImageModal('${safeSrc}')"/>
                    </div>
                    <div style="margin-top:8px; font-size:13px; line-height:1.25;">
                        <div style="font-weight:700;">${x.partNumber}</div>
                        <div style="color:#475569;">Cant: ${x.quantity}</div>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div style="margin-top:14px;">
                <div style="font-weight:700; margin:6px 0;">Fotos de piezas</div>
                <div style="display:flex; flex-wrap:wrap; gap:10px;">
                    ${cards}
                </div>
                ${hidden > 0 ? `<div style="margin-top:8px;color:#777;font-size:12px;">+${hidden} foto(s) más no mostradas (límite ${MAX}).</div>` : ''}
            </div>
        `;
    }

    // ========== Imprimir snapshot ==========
    function printSnapshot() {
        const viewer = document.getElementById('historial-snapshot-viewer');
        if (!viewer) return;
        const title = document.getElementById('historial-viewer-title')?.textContent || 'Reporte Histórico';

        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('Permite ventanas emergentes para imprimir.');
            return;
        }

        printWindow.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
                h2, h3 { color: #1f2937; }
                table { width: 100%; border-collapse: collapse; margin: 10px 0; }
                th, td { padding: 8px; border: 1px solid #ddd; font-size: 12px; }
                th { background: #f5f5f5; font-weight: bold; }
                img { max-width: 240px; max-height: 180px; border-radius: 8px; object-fit: cover; }
                hr { margin: 40px 0; border: none; border-top: 3px solid #e5e7eb; }
                @media print {
                    body { margin: 0; }
                    @page { margin: 15mm; }
                    img { max-width: 200px; max-height: 150px; }
                    table { page-break-inside: auto; }
                    tr { page-break-inside: avoid; }
                    hr { page-break-before: always; border: none; margin: 0; }
                }
            </style>
        </head><body>
            ${viewer.innerHTML}
        </body></html>`);
        printWindow.document.close();
        setTimeout(() => { printWindow.print(); }, 500);
    }

    // ========== Inicialización ==========
    function initHistorial() {
        // Botón volver
        const backBtn = document.getElementById('historial-back-btn');
        if (backBtn) backBtn.addEventListener('click', loadSnapshotsList);

        // Botón imprimir
        const printBtn = document.getElementById('historial-print-btn');
        if (printBtn) printBtn.addEventListener('click', printSnapshot);

        // Botón editar mes/fecha
        const editBtn = document.getElementById('historial-edit-meta-btn');
        if (editBtn) editBtn.addEventListener('click', editCurrentSnapshotMeta);
    }

    // Exponer para que tabs.js lo invoque
    window.loadHistorialReportes = loadSnapshotsList;

    // Init cuando DOM esté listo
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initHistorial);
    } else {
        initHistorial();
    }
})();
