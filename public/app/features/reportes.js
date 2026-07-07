// Feature: Reportes (Láser + Pavonado) + gráficas
// Extraído del script embebido de sistema_de_grabado_laserv1 (2025-12-18)

function getServerUrl() {
    return window.App?.config?.serverUrl || window.SERVER_URL || window.location.origin;
}

// ============================================
// Firmas en reportes (Láser + Pavonado)
// - Persisten en localData['lotes'].reportSignatures para que se sincronicen a BD
// - Se reflejan en el pie de firmas imprimible (print-footer)
// ============================================

const REPORT_SIGNERS = [
    { name: 'Ludwing Maximiliano Valdes Reyes', role: 'Elaboró' },
    { name: 'Pedro Flores Escobar', role: 'Revisó' },
    { name: 'Fernando Gabriel Moreno Juárez', role: 'Aprobó' }
];

const REPORT_SIGNATURES_STORAGE_KEY = 'lc_report_signatures_v1';

// Permiso RBAC: permitir reemplazar una firma ya registrada
const REPORT_SIGNATURE_EDIT_PERMISSION = 'report.signatures.edit';
let reportSignatureEditAllowed = null; // null=desconocido, boolean cuando ya se evaluó

function normalizePermsForCheck(perms) {
    if (!perms) return [];
    if (perms === '*') return ['*'];
    if (Array.isArray(perms)) return perms.map(p => String(p)).filter(Boolean);
    if (typeof perms === 'string') {
        const s = perms.trim();
        if (!s) return [];
        if (s === '*') return ['*'];
        return s.split(',').map(x => x.trim()).filter(Boolean);
    }
    return [];
}

function hasPermKey(perms, key) {
    const arr = normalizePermsForCheck(perms);
    if (arr.includes('*')) return true;
    return arr.includes(String(key));
}

async function ensureReportSignatureEditPermissionLoaded() {
    if (reportSignatureEditAllowed !== null) return reportSignatureEditAllowed;
    try {
        const resp = await fetch('/api/auth/me', { credentials: 'include' });
        if (!resp.ok) {
            reportSignatureEditAllowed = false;
            return reportSignatureEditAllowed;
        }
        const me = await resp.json();
        const perms = me && me.permissions ? me.permissions : [];
        reportSignatureEditAllowed = hasPermKey(perms, REPORT_SIGNATURE_EDIT_PERMISSION);
        return reportSignatureEditAllowed;
    } catch (e) {
        reportSignatureEditAllowed = false;
        return reportSignatureEditAllowed;
    }
}

let signaturePadSession = {
    reportType: null,
    signerName: null,
    isOpen: false
};

function getSignatureModalEls() {
    return {
        modal: document.getElementById('signature-modal'),
        backdrop: document.querySelector('#signature-modal .signature-modal-backdrop'),
        title: document.getElementById('signature-modal-title'),
        subtitle: document.getElementById('signature-modal-subtitle'),
        canvas: document.getElementById('signature-canvas'),
        btnClear: document.getElementById('signature-clear'),
        btnCancel: document.getElementById('signature-cancel'),
        btnSave: document.getElementById('signature-save')
    };
}

function createCanvasSignaturePad(canvas) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    let drawing = false;
    let hasInk = false;
    let last = null;

    function resizeToDisplaySize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            // Al redimensionar, limpiamos (sesión nueva) para evitar distorsión.
            canvas.width = w;
            canvas.height = h;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(dpr, dpr);
            clear();
        }
    }

    function clear() {
        const rect = canvas.getBoundingClientRect();
        ctx.clearRect(0, 0, rect.width, rect.height);
        // fondo blanco para buena impresión
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        hasInk = false;
        last = null;
    }

    function getPointFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left);
        const y = (e.clientY - rect.top);
        return { x, y };
    }

    function onPointerDown(e) {
        try {
            canvas.setPointerCapture(e.pointerId);
        } catch (err) { /* ignore */ }
        resizeToDisplaySize();
        drawing = true;
        last = getPointFromEvent(e);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!drawing) return;
        const p = getPointFromEvent(e);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last = p;
        hasInk = true;
        e.preventDefault();
    }

    function onPointerUp(e) {
        if (!drawing) return;
        drawing = false;
        last = null;
        e.preventDefault();
    }

    function destroy() {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        window.removeEventListener('resize', resizeToDisplaySize);
    }

    resizeToDisplaySize();
    clear();
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', resizeToDisplaySize);

    return {
        clear,
        destroy,
        hasInk: () => hasInk,
        toDataUrl: () => {
            // Exportar en tamaño real del canvas (ya tiene fondo blanco)
            return canvas.toDataURL('image/png');
        }
    };
}

let signaturePadInstance = null;

function openSignatureModal({ reportType, signerName }) {
    // Asegurar que los handlers estén enlazados (el modal puede estar después de los <script>)
    bindSignatureModalOnce();

    const els = getSignatureModalEls();
    if (!els.modal || !els.canvas) {
        notify('error', 'No se encontró el módulo de firma (signature-modal).');
        return;
    }

    signaturePadSession = { reportType, signerName, isOpen: true };

    if (els.title) els.title.textContent = 'Captura de firma';
    if (els.subtitle) els.subtitle.textContent = `${signerName} — ${String(reportType).toLowerCase() === 'pavonado' ? 'Reporte Pavonado' : 'Reporte Láser'}`;

    // (Re)iniciar pad
    try {
        if (signaturePadInstance) signaturePadInstance.destroy();
    } catch (e) { /* ignore */ }
    signaturePadInstance = createCanvasSignaturePad(els.canvas);

    els.modal.setAttribute('aria-hidden', 'false');
}

function closeSignatureModal() {
    const els = getSignatureModalEls();
    if (!els.modal) return;
    els.modal.setAttribute('aria-hidden', 'true');
    signaturePadSession = { reportType: null, signerName: null, isOpen: false };
}

function saveSignatureFromModal() {
    const els = getSignatureModalEls();
    if (!signaturePadSession?.isOpen || !signaturePadSession.signerName || !signaturePadSession.reportType) return;
    if (!signaturePadInstance || !signaturePadInstance.hasInk()) {
        notify('warning', 'Firma vacía. Dibuja tu firma antes de guardar.');
        return;
    }

    const dataUrl = signaturePadInstance.toDataUrl();
    const t = String(signaturePadSession.reportType).toLowerCase();
    const signer = signaturePadSession.signerName;

    const state = getReportSignatureState(t);
    state.signedBy[signer] = {
        signedAt: new Date().toISOString(),
        signatureDataUrl: dataUrl
    };
    markDirtyReportSignatures(t);
    renderReportSignaturesUI(t);

    // Persistir: 1) localStorage (para refresh inmediato) + 2) servidor (para que quede en BD)
    try { persistReportSignaturesToLocalStorage(); } catch (e) { /* ignore */ }
    try { persistSingleReportSignatureToServer({ reportType: t, signerName: signer, signatureDataUrl: dataUrl }); } catch (e) { /* ignore */ }

    notify('success', `Firma guardada: ${signer}`);
    closeSignatureModal();
}

function bindSignatureModalOnce() {
    const els = getSignatureModalEls();
    if (!els.modal || els.modal.__sigModalBound) return;
    els.modal.__sigModalBound = true;

    if (els.backdrop) {
        els.backdrop.addEventListener('click', () => closeSignatureModal());
    }
    if (els.btnCancel) {
        els.btnCancel.addEventListener('click', () => closeSignatureModal());
    }
    if (els.btnClear) {
        els.btnClear.addEventListener('click', () => {
            try { signaturePadInstance?.clear?.(); } catch (e) { /* ignore */ }
        });
    }
    if (els.btnSave) {
        els.btnSave.addEventListener('click', () => saveSignatureFromModal());
    }
}

function notify(type, message) {
    try {
        if (typeof window.showNotification === 'function') {
            window.showNotification(String(message || ''), String(type || 'info'));
            return;
        }
    } catch (e) { /* ignore */ }
    try { alert(String(message || '')); } catch (e) { /* ignore */ }
}

// ============================================
// MÉTRICAS (Expected) - edición en reportes
// ============================================

function showExpectedMetricsSaveReminder(lotKey, type) {
    try {
        const containerId = type === 'laser' ? `laser-metrics-expected-save-${lotKey}` : `pav-metrics-expected-save-${lotKey}`;
        const container = document.getElementById(containerId);
        if (container) {
            container.style.display = 'flex';
            container.style.alignItems = 'center';
            container.style.justifyContent = 'space-between';
        }
    } catch (e) { /* noop */ }
}

async function saveExpectedMetricsManually(lotKey, type) {
    try {
        const lot = localData && localData[lotKey];
        if (!lot) {
            notify('error', 'No se encontró el lote para guardar métricas.');
            return;
        }

        const metricsKey = type === 'laser' ? 'laserMetrics' : 'pavonadoMetrics';
        if (!lot[metricsKey] || typeof lot[metricsKey] !== 'object') lot[metricsKey] = {};

        // Tomar valores de inputs dentro del contenedor de reportes (solo los esperados)
        const rootId = type === 'laser' ? 'report-lotes-metrics' : 'report-pavonado-lotes-metrics';
        const root = document.getElementById(rootId);
        if (root) {
            const selector = type === 'laser' ? `.laser-metric-expected-input[data-lotkey="${lotKey}"]` : `.pav-metric-expected-input[data-lotkey="${lotKey}"]`;
            const inputs = root.querySelectorAll(selector);
            inputs.forEach(inp => {
                const key = inp.getAttribute('data-key');
                if (!key) return;
                lot[metricsKey][key] = inp.value;
            });
        }

        try {
            if (typeof window.markLocalDataDirty === 'function') {
                window.markLocalDataDirty(`metrics.expected.${type}`);
            }
        } catch (e) { /* noop */ }

        // Persistir en BD si existe helper legacy
        if (typeof window.saveLotMetricsToDatabase === 'function') {
            const metricsData = lot[metricsKey];
            const ok = await window.saveLotMetricsToDatabase(lotKey, type, metricsData);
            if (ok) {
                notify('success', `✅ Resultados esperados (${type}) guardados`);
                const containerId = type === 'laser' ? `laser-metrics-expected-save-${lotKey}` : `pav-metrics-expected-save-${lotKey}`;
                const c = document.getElementById(containerId);
                if (c) c.style.display = 'none';
                try { if (type === 'laser') loadReportData(); else loadReportDataPavonado(); } catch (e) { /* noop */ }
                try { if (typeof window.loadDashboardData === 'function') window.loadDashboardData(); } catch (e) { /* noop */ }
                return;
            }
        }

        // Si no se pudo persistir, al menos queda en memoria/local.
        notify('info', 'Guardado local: resultados esperados actualizados en memoria.');
    } catch (e) {
        console.warn('saveExpectedMetricsManually error', e);
        notify('error', 'No se pudieron guardar los resultados esperados.');
    }
}

function attachExpectedMetricsHandlersOnce() {
    try {
        // Inputs Láser
        document.querySelectorAll('.laser-metric-expected-input').forEach(inp => {
            if (inp.__expectedBound) return;
            inp.__expectedBound = true;
            inp.addEventListener('input', function () {
                const lotKey = this.getAttribute('data-lotkey');
                if (lotKey) showExpectedMetricsSaveReminder(lotKey, 'laser');
            });
            inp.addEventListener('change', function () {
                const lotKey = this.getAttribute('data-lotkey');
                const key = this.getAttribute('data-key');
                if (!lotKey || !key) return;
                if (!localData[lotKey]) localData[lotKey] = { name: lotKey, pieces: [] };
                if (!localData[lotKey].laserMetrics || typeof localData[lotKey].laserMetrics !== 'object') localData[lotKey].laserMetrics = {};
                localData[lotKey].laserMetrics[key] = this.value;
                try { if (typeof window.markLocalDataDirty === 'function') window.markLocalDataDirty('metrics.expected.laser'); } catch (e) { /* noop */ }
                showExpectedMetricsSaveReminder(lotKey, 'laser');
            });
        });

        // Inputs Pavonado
        document.querySelectorAll('.pav-metric-expected-input').forEach(inp => {
            if (inp.__expectedBound) return;
            inp.__expectedBound = true;
            inp.addEventListener('input', function () {
                const lotKey = this.getAttribute('data-lotkey');
                if (lotKey) showExpectedMetricsSaveReminder(lotKey, 'pavonado');
            });
            inp.addEventListener('change', function () {
                const lotKey = this.getAttribute('data-lotkey');
                const key = this.getAttribute('data-key');
                if (!lotKey || !key) return;
                if (!localData[lotKey]) localData[lotKey] = { name: lotKey, pieces: [] };
                if (!localData[lotKey].pavonadoMetrics || typeof localData[lotKey].pavonadoMetrics !== 'object') localData[lotKey].pavonadoMetrics = {};
                localData[lotKey].pavonadoMetrics[key] = this.value;
                try { if (typeof window.markLocalDataDirty === 'function') window.markLocalDataDirty('metrics.expected.pavonado'); } catch (e) { /* noop */ }
                showExpectedMetricsSaveReminder(lotKey, 'pavonado');
            });
        });

        // Botones Guardar
        document.querySelectorAll('[data-action="save-expected-metrics"]').forEach(btn => {
            if (btn.__saveExpectedBound) return;
            btn.__saveExpectedBound = true;
            btn.addEventListener('click', async function () {
                const lotKey = this.getAttribute('data-lotkey');
                const type = this.getAttribute('data-type');
                if (!lotKey || !type) return;
                await saveExpectedMetricsManually(lotKey, type);
            });
        });
    } catch (e) {
        console.warn('attachExpectedMetricsHandlersOnce error', e);
    }
}

function ensureRootLotForMeta() {
    try {
        if (!localData || typeof localData !== 'object') localData = {};
        if (!localData.lotes || typeof localData.lotes !== 'object') {
            localData.lotes = { id: 'lotes', name: 'LOTES', pieces: [], process: 'all' };
        }
        // Asegurar metadata (exportable/persistible)
        if (!localData.lotes.metadata || typeof localData.lotes.metadata !== 'object') {
            localData.lotes.metadata = {};
        }

        // Migración: si existe reportSignatures en raíz, moverlo a metadata.
        if (localData.lotes.reportSignatures && typeof localData.lotes.reportSignatures === 'object') {
            if (!localData.lotes.metadata.reportSignatures || typeof localData.lotes.metadata.reportSignatures !== 'object') {
                localData.lotes.metadata.reportSignatures = {};
            }
            try {
                localData.lotes.metadata.reportSignatures = {
                    ...localData.lotes.reportSignatures,
                    ...localData.lotes.metadata.reportSignatures
                };
            } catch (e) { /* ignore */ }
            try { delete localData.lotes.reportSignatures; } catch (e) { /* ignore */ }
        }

        if (!localData.lotes.metadata.reportSignatures || typeof localData.lotes.metadata.reportSignatures !== 'object') {
            localData.lotes.metadata.reportSignatures = {};
        }

        // Hidratar desde localStorage (fallback) si no hay nada en metadata
        try {
            const ls = loadReportSignaturesFromLocalStorage();
            if (ls && typeof ls === 'object') {
                const current = localData.lotes.metadata.reportSignatures;
                const isEmpty = !current || (typeof current === 'object' && Object.keys(current).length === 0);
                if (isEmpty) {
                    localData.lotes.metadata.reportSignatures = ls;
                }
            }
        } catch (e) { /* ignore */ }

        return localData.lotes;
    } catch (e) {
        return null;
    }
}

function getReportSignatureState(reportType) {
    const root = ensureRootLotForMeta();
    if (!root) return { signedBy: {} };
    const key = String(reportType || '').toLowerCase();

    const bucket = root?.metadata?.reportSignatures;
    if (!bucket || typeof bucket !== 'object') return { signedBy: {} };

    if (!bucket[key] || typeof bucket[key] !== 'object') {
        bucket[key] = { signedBy: {} };
    }
    if (!bucket[key].signedBy || typeof bucket[key].signedBy !== 'object') {
        bucket[key].signedBy = {};
    }
    return bucket[key];
}

function markDirtyReportSignatures(reportType) {
    try {
        // También persistir localmente para que sobreviva refresh aunque no se sincronice a BD.
        try { persistReportSignaturesToLocalStorage(); } catch (e) { /* ignore */ }

        if (typeof window.markLocalDataDirty === 'function') {
            window.markLocalDataDirty(`reportSignatures.${reportType}`);
        } else if (window.App?.state?.Store?.markDirty) {
            window.App.state.Store.markDirty(`reportSignatures.${reportType}`);
        }
    } catch (e) { /* ignore */ }
}

function loadReportSignaturesFromLocalStorage() {
    try {
        const raw = window.localStorage ? window.localStorage.getItem(REPORT_SIGNATURES_STORAGE_KEY) : null;
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (e) {
        return null;
    }
}

function persistReportSignaturesToLocalStorage() {
    try {
        if (!window.localStorage) return false;
        const root = ensureRootLotForMeta();
        const sigs = root?.metadata?.reportSignatures;
        if (!sigs || typeof sigs !== 'object') return false;
        window.localStorage.setItem(REPORT_SIGNATURES_STORAGE_KEY, JSON.stringify(sigs));
        return true;
    } catch (e) {
        return false;
    }
}

async function persistSingleReportSignatureToServer({ reportType, signerName, signatureDataUrl }) {
    try {
        const t = String(reportType || '').toLowerCase();
        if (t !== 'laser' && t !== 'pavonado') return false;
        if (!signerName || !signatureDataUrl) return false;

        const SERVER_URL = getServerUrl();
        const resp = await fetch(`${SERVER_URL}/api/report-signatures/${encodeURIComponent(t)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ signerName, signatureDataUrl })
            }
        );
        if (!resp.ok) {
            // No interrumpir flujo: la firma queda al menos en localStorage.
            if (resp.status === 403) {
                notify('error', 'No tienes permiso para modificar una firma ya registrada.');
            }
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

function getReportTabRoot(reportType) {
    const t = String(reportType || '').toLowerCase();
    if (t === 'pavonado') return document.getElementById('reporte-pavonado');
    return document.getElementById('reporte');
}

function formatSignedAt(iso) {
    try {
        const d = new Date(iso);
        if (!isFinite(d.getTime())) return '';
        return d.toLocaleString('es-MX');
    } catch (e) {
        return '';
    }
}

function updatePrintFooterSignatures(reportType) {
    const state = getReportSignatureState(reportType);
    const tab = getReportTabRoot(reportType);
    if (!tab) return;

    const lines = tab.querySelectorAll('.print-footer .print-signature-name');
    if (!lines || lines.length === 0) return;

    const imgs = tab.querySelectorAll('.print-footer .print-signature-image');

    // Hay 3 filas (Elaboró/Revisó/Aprobó). Mapeamos por el orden de REPORT_SIGNERS.
    REPORT_SIGNERS.forEach((s, idx) => {
        const el = lines[idx];
        if (!el) return;
        const signed = state?.signedBy?.[s.name];
        const img = imgs && imgs.length ? imgs[idx] : null;
        if (signed && signed.signedAt) {
            // Nota: el usuario pidió NO mostrar fecha/hora.
            el.textContent = 'Firmado';

            if (img && signed.signatureDataUrl) {
                img.src = signed.signatureDataUrl;
                img.classList.add('has-signature');
            } else if (img) {
                img.removeAttribute('src');
                img.classList.remove('has-signature');
            }
        } else {
            el.innerHTML = '&nbsp;';
            if (img) {
                img.removeAttribute('src');
                img.classList.remove('has-signature');
            }
        }
    });
}

function renderReportSignaturesUI(reportType) {
    const t = String(reportType || '').toLowerCase();
    const state = getReportSignatureState(t);
    const signedBy = state?.signedBy || {};

    const listEl = document.getElementById(t === 'pavonado' ? 'report-signatures-list-pavonado' : 'report-signatures-list-laser');
    const statusEl = document.getElementById(t === 'pavonado' ? 'report-signatures-status-pavonado' : 'report-signatures-status-laser');
    const addBtn = document.getElementById(t === 'pavonado' ? 'add-signature-pavonado' : 'add-signature-laser');
    if (!listEl || !statusEl) return;

    const total = REPORT_SIGNERS.length;
    const done = REPORT_SIGNERS.filter(s => !!signedBy[s.name]).length;
    statusEl.textContent = `${done}/${total} firmadas`;

    const itemsHtml = REPORT_SIGNERS.map(s => {
        const signed = signedBy[s.name];
        // Nota: el usuario pidió NO mostrar fecha/hora.
        const meta = signed?.signedAt ? '✅ Firmado' : '⏳ Pendiente';
        const metaColor = signed?.signedAt ? '#166534' : '#92400e';
        const thumb = signed?.signatureDataUrl ? `<img class="report-signature-thumb" src="${signed.signatureDataUrl}" alt="Firma" />` : '';
        return `
            <div class="report-signatures-item">
                <div>
                    <div class="sig-name">${escapeHtml(s.name)}</div>
                    <div style="font-size:12px;color:#64748b;">${escapeHtml(s.role)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                    ${thumb}
                    <div class="sig-meta" style="color:${metaColor};">${escapeHtml(meta)}</div>
                </div>
            </div>
        `;
    }).join('');

    listEl.innerHTML = itemsHtml;

    if (addBtn) {
        const canEdit = !!reportSignatureEditAllowed;
        addBtn.disabled = (done >= total) && !canEdit;
        if (done >= total) {
            addBtn.title = canEdit ? 'Editar/Reemplazar firma' : 'Todas las firmas requeridas ya fueron capturadas';
        } else {
            addBtn.title = 'Añadir firma';
        }
    }

    updatePrintFooterSignatures(t);
}

function promptSignerSelection() {
    const options = REPORT_SIGNERS.map((s, i) => `${i + 1}) ${s.name}`).join('\n');
    const raw = prompt(`¿Quién va a firmar?\n\n${options}\n\nEscribe el número (1-${REPORT_SIGNERS.length})`);
    if (raw === null) return null;
    const trimmed = String(raw).trim();
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 1 && n <= REPORT_SIGNERS.length) {
        return REPORT_SIGNERS[n - 1].name;
    }

    // También aceptar el nombre completo si lo pegan.
    const byName = REPORT_SIGNERS.find(s => s.name.toLowerCase() === trimmed.toLowerCase());
    return byName ? byName.name : null;
}

async function addSignatureToReport(reportType) {
    const t = String(reportType || '').toLowerCase();
    const state = getReportSignatureState(t);
    const signer = promptSignerSelection();
    if (!signer) {
        notify('warning', 'Firma cancelada o usuario inválido.');
        return;
    }

    if (state?.signedBy?.[signer]) {
        const canEdit = await ensureReportSignatureEditPermissionLoaded();
        if (!canEdit) {
            notify('error', `Ya existe firma registrada para: ${signer}. No tienes permiso para modificarla.`);
            renderReportSignaturesUI(t);
            return;
        }

        const ok = confirm(`Ya existe una firma registrada para:\n\n${signer}\n\n¿Deseas reemplazarla?`);
        if (!ok) {
            renderReportSignaturesUI(t);
            return;
        }
    }

    // Abrir modal para capturar firma
    openSignatureModal({ reportType: t, signerName: signer });
}

function initReportSignatures() {
    try {
        bindSignatureModalOnce();

        // Cargar permisos (best-effort) para habilitar el modo "reemplazar firma".
        ensureReportSignatureEditPermissionLoaded().then(() => {
            try {
                renderReportSignaturesUI('laser');
                renderReportSignaturesUI('pavonado');
            } catch (e) { /* ignore */ }
        });

        const laserBtn = document.getElementById('add-signature-laser');
        if (laserBtn && !laserBtn.__sigBound) {
            laserBtn.__sigBound = true;
            laserBtn.addEventListener('click', () => addSignatureToReport('laser'));
        }
        const pavBtn = document.getElementById('add-signature-pavonado');
        if (pavBtn && !pavBtn.__sigBound) {
            pavBtn.__sigBound = true;
            pavBtn.addEventListener('click', () => addSignatureToReport('pavonado'));
        }

        // Render inicial (si ya hay estado hidratado). Si no, se volverá a pintar al generar el reporte.
        renderReportSignaturesUI('laser');
        renderReportSignaturesUI('pavonado');
    } catch (e) {
        console.warn('initReportSignatures error', e);
    }
}

function resolvePieceImageSrc(raw) {
    if (!raw) return null;
    const s = String(raw);
    if (s.startsWith('data:')) return s;
    if (s.startsWith('http://') || s.startsWith('https://')) return s;
    // En este sistema, las imágenes se sirven desde /engrave/:path
    return `${getServerUrl()}/engrave/${encodeURIComponent(s)}`;
}

function getLotNameForSort(lotKey, lot) {
    const name = lot?.name ?? '';
    return String(name || lotKey || '');
}

function sortLotEntriesByName(a, b) {
    const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
    const an = getLotNameForSort(a.lotKey, a.lot);
    const bn = getLotNameForSort(b.lotKey, b.lot);
    const byName = collator.compare(an, bn);
    if (byName !== 0) return byName;
    return collator.compare(String(a.lotKey), String(b.lotKey));
}

function sortChartLotRows(a, b) {
    // Orden numérico amigable para nombres tipo "LOTE 00-03 (Láser)"
    const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
    const an = String(a?.name ?? a?.lotKey ?? '');
    const bn = String(b?.name ?? b?.lotKey ?? '');
    const byName = collator.compare(an, bn);
    if (byName !== 0) return byName;
    return collator.compare(String(a?.lotKey ?? ''), String(b?.lotKey ?? ''));
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderLotPiecePhotos(pieces) {
    const list = Array.isArray(pieces) ? pieces : [];
    const withImg = list
        .map(p => ({
            partNumber: p?.partNumber ?? p?.numeroParte ?? '-',
            quantity: Number(p?.quantity ?? p?.numPiezas ?? 0) || 0,
            imgSrc: resolvePieceImageSrc(p?.imagen || p?.imagenPath || p?.image || p?.imagePath || null)
        }))
        .filter(x => !!x.imgSrc);

    if (withImg.length === 0) {
        return '<div style="margin-top:10px;color:#777;font-size:12px;">Sin fotos registradas en este lote.</div>';
    }

    // Para que el reporte no se vuelva inmenso, mostramos hasta 36 por lote.
    const MAX = 36;
    const shown = withImg.slice(0, MAX);
    const hidden = withImg.length - shown.length;

    const cards = shown.map(x => {
        const safeSrc = String(x.imgSrc).replace(/'/g, "\\'");
        return `
                <div style="width: 280px; border:1px solid #e5e7eb; border-radius:10px; padding:10px; background:#fff;">
                    <div style="width: 100%; height: 200px; display:flex; align-items:center; justify-content:center; overflow:hidden; border-radius:8px; background:#f8fafc;">
                        <img src="${x.imgSrc}" loading="lazy" alt="img" style="width:100%;height:200px;object-fit:cover;cursor:zoom-in" onerror="setImgFallback(this)" ondblclick="openImageModal('${safeSrc}')"/>
                </div>
                    <div style="margin-top:8px; font-size:13px; line-height:1.25;">
                        <div style="font-weight:700;">${escapeHtml(x.partNumber)}</div>
                        <div style="color:#475569;">Cant: ${escapeHtml(x.quantity)}</div>
                </div>
            </div>
        `;
    }).join('');

    return `
        <div style="margin-top: 14px;">
            <div style="font-weight:700; margin: 6px 0;">Fotos de piezas</div>
            <div style="display:flex; flex-wrap:wrap; gap:10px;">
                ${cards}
            </div>
            ${hidden > 0 ? `<div style="margin-top:8px;color:#777;font-size:12px;">+${hidden} foto(s) más no mostradas (límite ${MAX}).</div>` : ''}
        </div>
    `;
}

function loadReportData() {
    let totalPieces = 0;
    let totalIncidents = 0;
    let piecesWithIncidents = []; // Array para guardar piezas con incidencias

    // Contar SOLO piezas que tienen proceso 'laser' o 'ambos'
    // Y contar incidencias SOLO si el tipo de incidencia coincide con 'laser' o 'ambos'
    Object.keys(localData).forEach(lotKey => {
        // No contar el pool global (Total de piezas) en reportes mensuales.
        // Ahí suelen vivir piezas aún no asignadas a un lote de proceso.
        if (lotKey === 'lotes') return;
        const lot = localData[lotKey];
        if (!lot || !Array.isArray(lot.pieces)) return;
        lot.pieces.forEach(piece => {
            const proc = (piece.proceso || '').toLowerCase();
            if (proc === 'laser' || proc === 'ambos') {
                totalPieces += Number(piece.quantity || 0) || 0;
                // Solo contar incidencias si el tipo coincide con laser o ambos
                const incType = (piece.incidentType || '').toLowerCase();
                if (incType === 'laser' || incType === 'ambos' || incType === '') {
                    const incidentes = Number(piece.incidents || 0) || 0;
                    totalIncidents += incidentes;
                    // Si tiene incidencias, agregarlo a la lista para mostrar en la tabla
                    if (incidentes > 0) {
                        // Formatear el proceso para mostrar correctamente
                        let procesosDisplay = '';
                        if (proc === 'laser') {
                            procesosDisplay = '🔵 Láser';
                        } else if (proc === 'ambos') {
                            procesosDisplay = '🔵 Láser<br/>🟣 Pavonado';
                        }

                        piecesWithIncidents.push({
                            partNumber: piece.partNumber || '-',
                            quantity: Number(piece.quantity || 0) || 0,
                            incidents: incidentes,
                            incidentType: incType || 'Sin especificar',
                            process: procesosDisplay,
                            imagen: piece.imagen || piece.imagenPath || piece.image || piece.imagePath || null
                        });
                    }
                }
            }
        });
    });

    // Calcular KPIs para el reporte
    const desiredPercentage = totalPieces > 0 ?
        ((totalPieces - totalIncidents) / totalPieces * 100).toFixed(2) + '%' : '100%';
    const maxKpi = totalPieces > 0 ?
        (totalIncidents / totalPieces * 100).toFixed(2) + '%' : '0%';

    // Actualizar reporte
    const elExpected = document.getElementById('report-expected-pieces');
    const elTotal = document.getElementById('report-total-pieces');
    const elDesired = document.getElementById('report-desired-percentage');
    const elRework = document.getElementById('report-rework-pieces');
    const elMax = document.getElementById('report-max-kpi');
    if (elExpected) elExpected.textContent = totalPieces;
    if (elTotal) elTotal.textContent = totalPieces;
    if (elDesired) elDesired.textContent = desiredPercentage;
    if (elRework) elRework.textContent = totalIncidents;
    if (elMax) elMax.textContent = maxKpi;

    // Llenar la tabla de incidencias
    const incidentsTableBody = document.getElementById('report-incidents-table-body');
    if (incidentsTableBody) {
        if (piecesWithIncidents.length === 0) {
            incidentsTableBody.innerHTML = '<tr><td colspan="6" style="padding: 8px; text-align: center; color: #999;">No hay piezas con incidencias registradas</td></tr>';
        } else {
            incidentsTableBody.innerHTML = piecesWithIncidents.map(piece => {
                const imgSrc = resolvePieceImageSrc(piece.imagen);
                let imgCell = '<td style="padding: 4px; text-align: center; color: #999;">Sin foto</td>';
                if (imgSrc) {
                    const safeSrc = String(imgSrc).replace(/'/g, "\\'");
                    // Nota: openImageModal y setImgFallback existen en la vista principal (global)
                    imgCell = `<td style="padding: 8px; text-align: center; width: 260px;"><img src="${imgSrc}" loading="lazy" alt="img" style="max-width:240px;max-height:180px;border-radius:8px;object-fit:cover;cursor:zoom-in" onerror="setImgFallback(this)" ondblclick="openImageModal('${safeSrc}')"/></td>`;
                }

                return `
                <tr>
                    ${imgCell}
                    <td style="padding: 8px;">${piece.partNumber}</td>
                    <td style="padding: 8px; text-align: center;">${piece.quantity}</td>
                    <td style="padding: 8px; text-align: center;">${piece.incidents}</td>
                    <td style="padding: 8px;">${piece.incidentType}</td>
                    <td style="padding: 8px; text-align: center;">${piece.process}</td>
                </tr>
            `;
            }).join('');
        }
    }

    // GENERAR MÉTRICAS DE LOTES EN EL REPORTE LÁSER
    const reportLotesMetricsDiv = document.getElementById('report-lotes-metrics');
    if (reportLotesMetricsDiv) {
        let lotesMetricsHtml = '';

        // Iterar sobre todos los lotes y mostrar los que tengan proceso 'laser' (ordenados)
        const laserLotEntries = Object.keys(localData)
            .map(lotKey => ({ lotKey, lot: localData[lotKey] }))
            .filter(e => e.lot && e.lot.process === 'laser')
            .sort(sortLotEntriesByName);

        laserLotEntries.forEach(({ lotKey, lot }) => {

            // Calcular suma de piezas del lote
            const sumPiecesInLot = Array.isArray(lot.pieces) ?
                lot.pieces.reduce((s, p) => s + (Number(p.quantity || 0) || 0), 0) : 0;

            // Auto-calcular piezas defectuosas
            const countDefectivePieces = Array.isArray(lot.pieces) ?
                lot.pieces.reduce((count, p) => count + (p.incidents > 0 ? 1 : 0), 0) : 0;

            // Inicializar métricas si no existen
            if (!lot.laserMetrics || typeof lot.laserMetrics !== 'object') lot.laserMetrics = {};

            const laserDefaults = {
                piezas_grabadas_expected: (lot.laserMetrics.piezas_grabadas_expected !== undefined && lot.laserMetrics.piezas_grabadas_expected !== null && lot.laserMetrics.piezas_grabadas_expected !== '') ? lot.laserMetrics.piezas_grabadas_expected : sumPiecesInLot,
                piezas_retrabajo: lot.laserMetrics.piezas_retrabajo_expected || '0',
                tiempo_promedio: lot.laserMetrics.tiempo_promedio_expected || '1h por dispositivo',
                potencia_laser: lot.laserMetrics.potencia_laser_expected || '40 Watts (W)',
                velocidad_grabado: lot.laserMetrics.velocidad_grabado_expected || '2000 mm/s',
                paros_mantenimiento: lot.laserMetrics.paros_mantenimiento_expected || '1/6 mes',
                cumplimiento_ficha: lot.laserMetrics.cumplimiento_ficha_expected || 'Aceptable/Rechazado',
                cumplimiento_cero_retrabajo: lot.laserMetrics.cumplimiento_cero_retrabajo_expected || '0'
            };

            const laserVals = {
                piezas_grabadas: (lot.laserMetrics.piezas_grabadas !== undefined && lot.laserMetrics.piezas_grabadas !== null && lot.laserMetrics.piezas_grabadas !== '') ? lot.laserMetrics.piezas_grabadas : sumPiecesInLot,
                piezas_retrabajo: (lot.laserMetrics.piezas_retrabajo !== undefined && lot.laserMetrics.piezas_retrabajo !== null && lot.laserMetrics.piezas_retrabajo !== '') ? lot.laserMetrics.piezas_retrabajo : countDefectivePieces,
                tiempo_promedio: lot.laserMetrics.tiempo_promedio || '',
                potencia_laser: lot.laserMetrics.potencia_laser || '',
                velocidad_grabado: lot.laserMetrics.velocidad_grabado || '',
                paros_mantenimiento: lot.laserMetrics.paros_mantenimiento || '',
                cumplimiento_ficha: lot.laserMetrics.cumplimiento_ficha || '',
                cumplimiento_cero_retrabajo: lot.laserMetrics.cumplimiento_cero_retrabajo || ''
            };

            const expectedInputStyle = 'width: 100%; max-width: 180px; text-align: center; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff;';

            lotesMetricsHtml += `
                <div style="margin-top: 20px; border: 1px solid #ddd; padding: 15px; border-radius: 4px;">
                    <h3>Métricas Láser - ${lot.name}</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="background-color: #f5f5f5;">
                                <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Indicador (KPI)</th>
                                <th style="padding: 10px; text-align: center; border: 1px solid #ddd;">RESULTADOS ESPERADOS</th>
                                <th style="padding: 10px; text-align: center; border: 1px solid #ddd;">Método de medición</th>
                                <th style="padding: 10px; text-align: center; border: 1px solid #ddd;">Valor Cuantificable</th>
                                <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Objetivo</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Piezas grabadas</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="number" min="0" step="1" style="${expectedInputStyle}" class="laser-metric-expected-input" data-lotkey="${lotKey}" data-key="piezas_grabadas_expected" value="${escapeHtml(laserDefaults.piezas_grabadas_expected)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Registro automático</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${laserVals.piezas_grabadas}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Productividad del grabado</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Piezas a retrabajo</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="text" style="${expectedInputStyle}" class="laser-metric-expected-input" data-lotkey="${lotKey}" data-key="piezas_retrabajo_expected" value="${escapeHtml(laserDefaults.piezas_retrabajo)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Cantidad con retrabajo</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${laserVals.piezas_retrabajo}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Precisión y calidad</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Tiempo promedio de grabado</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="text" style="${expectedInputStyle}" class="laser-metric-expected-input" data-lotkey="${lotKey}" data-key="tiempo_promedio_expected" value="${escapeHtml(laserDefaults.tiempo_promedio)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Cronometraje</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${laserVals.tiempo_promedio}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Tiempos de operación</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Potencia del láser</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="text" style="${expectedInputStyle}" class="laser-metric-expected-input" data-lotkey="${lotKey}" data-key="potencia_laser_expected" value="${escapeHtml(laserDefaults.potencia_laser)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Verificación potencia</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${laserVals.potencia_laser}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Rango establecido</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Velocidad de grabado</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="text" style="${expectedInputStyle}" class="laser-metric-expected-input" data-lotkey="${lotKey}" data-key="velocidad_grabado_expected" value="${escapeHtml(laserDefaults.velocidad_grabado)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Configuración software</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${laserVals.velocidad_grabado}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Buena definición</td>
                            </tr>
                        </tbody>
                    </table>
                    <div class="metrics-save-container" id="laser-metrics-expected-save-${lotKey}" style="display:none; padding:10px 16px; background:linear-gradient(135deg, #fff3cd, #ffe69c); border:2px solid #ffc107; border-radius:8px; box-shadow: 0 2px 8px rgba(255,193,7,0.3); margin-top:10px;">
                        <div style="font-weight:700; color:#92400e;">Cambios en resultados esperados</div>
                        <button class="btn-save-metrics" data-action="save-expected-metrics" data-type="laser" data-lotkey="${lotKey}">💾 Guardar Resultados Esperados</button>
                    </div>
                    ${renderLotPiecePhotos(lot.pieces)}
                </div>
            `;
        });

        reportLotesMetricsDiv.innerHTML = lotesMetricsHtml;

        // Activar edición de esperados
        attachExpectedMetricsHandlersOnce();
    }

    // Firmas del reporte Láser
    renderReportSignaturesUI('laser');
}

function createCharts() {
    // Destruir gráficas existentes (Láser)
    try {
        if (typeof kpiChart !== 'undefined' && kpiChart) {
            try { kpiChart.destroy(); } catch (e) { console.warn('Error destruyendo kpiChart', e); }
            kpiChart = null;
        }
    } catch (e) { /* noop */ }
    try {
        if (typeof lotChart !== 'undefined' && lotChart) {
            try { lotChart.destroy(); } catch (e) { console.warn('Error destruyendo lotChart', e); }
            lotChart = null;
        }
    } catch (e) { /* noop */ }

    // Calcular datos para las gráficas (SOLO piezas con proceso 'laser' o 'ambos')
    let totalPieces = 0;
    let totalIncidents = 0;
    const lotRows = [];

    Object.keys(localData || {}).forEach(lotKey => {
        // Excluir pool global: evita que la dona/barra cuenten piezas aún no asignadas
        if (lotKey === 'lotes') return;
        const lot = localData[lotKey];
        let lotPieces = 0;
        let lotIncidents = 0;

        const pieces = (lot && Array.isArray(lot.pieces)) ? lot.pieces : [];
        pieces.forEach(piece => {
            const proc = (piece.proceso || '').toString().toLowerCase();
            // SOLO contar si tiene proceso 'laser' o 'ambos'
            if (proc === 'laser' || proc === 'ambos') {
                lotPieces += Number(piece.quantity || 0);
                // Solo contar incidencias si el tipo coincide con laser o ambos
                const incType = (piece.incidentType || '').toLowerCase();
                if (incType === 'laser' || incType === 'ambos' || incType === '') {
                    lotIncidents += Number(piece.incidents || 0);
                }
            }
        });

        totalPieces += lotPieces;
        totalIncidents += lotIncidents;

        // Incluir en la gráfica por-lote SOLO si el lote corresponde a Láser
        try {
            const nameLower = (lot && lot.name) ? String(lot.name).toLowerCase() : '';
            const isLaserLot = (lot && lot.process === 'laser') || lotKey.startsWith('laser-lot-') || lotKey.startsWith('laser-') || nameLower.includes('láser') || nameLower.includes('laser');
            if (lotKey !== 'lotes' && isLaserLot) {
                lotRows.push({ lotKey, name: lot?.name ?? lotKey, pieces: Number(lotPieces), incidents: Number(lotIncidents) });
            }
        } catch (e) {
            if (lotKey !== 'lotes') {
                lotRows.push({ lotKey, name: lot?.name ?? lotKey, pieces: Number(lotPieces), incidents: Number(lotIncidents) });
            }
        }
    });

    // Ordenar para mostrar 00-01, 00-02, 00-03...
    lotRows.sort(sortChartLotRows);
    const lotNames = lotRows.map(r => r.name);
    const lotPiecesData = lotRows.map(r => r.pieces);
    const lotIncidentsData = lotRows.map(r => r.incidents);

    const successfulPieces = totalPieces - totalIncidents;

    // Gráfica de KPIs
    const kpiCanvas = document.getElementById('kpi-chart');
    if (!kpiCanvas || !window.Chart) return;
    // Por seguridad: si Chart.js ya tiene una instancia en este canvas, destruirla
    try {
        const existing = (typeof window.Chart.getChart === 'function') ? window.Chart.getChart(kpiCanvas) : null;
        if (existing) existing.destroy();
    } catch (e) { /* noop */ }
    const kpiCtx = kpiCanvas.getContext('2d');
    kpiChart = new Chart(kpiCtx, {
        type: 'doughnut',
        data: {
            labels: ['Piezas Correctas', 'Piezas con Incidencias'],
            datasets: [{
                data: [successfulPieces, totalIncidents],
                backgroundColor: ['#27ae60', '#e74c3c'],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: 'Distribución de Piezas Grabadas', font: { size: 16 } },
                legend: { position: 'bottom' },
                datalabels: { display: true, color: '#fff', font: { weight: 'bold', size: 14 } }
            }
        },
        plugins: [{
            id: 'datalabelsPlugin',
            afterDatasetsDraw(chart) {
                const { ctx, data, chartArea } = chart;
                ctx.save();

                const dataset = chart.getDatasetMeta(0);
                const centerX = (chartArea.left + chartArea.right) / 2;
                const centerY = (chartArea.top + chartArea.bottom) / 2;

                dataset.data.forEach((datapoint, index) => {
                    const value = data.datasets[0].data[index];
                    const angle = (datapoint.startAngle + datapoint.endAngle) / 2;
                    const radius = (datapoint.innerRadius + datapoint.outerRadius) / 2;
                    const labelX = centerX + Math.cos(angle - Math.PI / 2) * radius;
                    const labelY = centerY + Math.sin(angle - Math.PI / 2) * radius;

                    ctx.fillStyle = '#fff';
                    ctx.font = 'bold 16px Arial, sans-serif';
                    const textWidth = ctx.measureText(value).width;
                    ctx.fillRect(labelX - textWidth / 2 - 4, labelY - 10, textWidth + 8, 20);

                    ctx.fillStyle = '#000';
                    ctx.font = 'bold 16px Arial, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(value, labelX, labelY);
                });

                ctx.restore();
            }
        }]
    });

    // Gráfica de producción por lote
    const lotCanvas = document.getElementById('lot-chart');
    if (!lotCanvas || !window.Chart) return;
    try {
        const existing = (typeof window.Chart.getChart === 'function') ? window.Chart.getChart(lotCanvas) : null;
        if (existing) existing.destroy();
    } catch (e) { /* noop */ }
    const lotCtx = lotCanvas.getContext('2d');
    lotChart = new Chart(lotCtx, {
        type: 'bar',
        data: {
            labels: lotNames,
            datasets: [
                { label: 'Piezas Grabadas', data: lotPiecesData, backgroundColor: '#3498db' },
                { label: 'Piezas con Incidencias', data: lotIncidentsData, backgroundColor: '#e74c3c' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: 'Producción por Lote', font: { size: 16 } }
            },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: 'Cantidad de Piezas' } }
            }
        }
    });
}

function printReport() {
    // Asegurar que el encabezado indique "Grabado Láser" antes de imprimir
    try {
        const h = document.getElementById('header-main-title');
        const r = document.getElementById('report-card-title');
        if (h) h.textContent = 'Registro Grabado Láser';
        if (r) r.textContent = 'Registro Grabado Láser';
    } catch (e) { /* ignore */ }
    window.print();
}

function printReportPavonado() {
    // Asegurar que el encabezado indique "Pavonado" antes de imprimir
    try {
        const h = document.getElementById('header-main-title');
        const r = document.getElementById('report-card-title');
        if (h) h.textContent = 'Registro Pavonado';
        if (r) r.textContent = 'Registro Pavonado';
    } catch (e) { /* ignore */ }
    window.print();
}

function loadReportDataPavonado() {
    let totalPieces = 0;
    let totalIncidents = 0;
    let piecesWithIncidents = [];

    // Contar SOLO piezas que tienen proceso 'pavonado' o 'ambos'
    // Y contar incidencias SOLO si el tipo de incidencia coincide con 'pavonado' o 'ambos'
    Object.keys(localData).forEach(lotKey => {
        // No contar el pool global (Total de piezas) en reportes mensuales.
        if (lotKey === 'lotes') return;
        const lot = localData[lotKey];
        if (!lot || !Array.isArray(lot.pieces)) return;
        lot.pieces.forEach(piece => {
            const proc = (piece.proceso || '').toLowerCase();
            if (proc === 'pavonado' || proc === 'ambos') {
                totalPieces += Number(piece.quantity || 0) || 0;
                const incType = (piece.incidentType || '').toLowerCase();
                if (incType === 'pavonado' || incType === 'ambos' || incType === '') {
                    const incidentes = Number(piece.incidents || 0) || 0;
                    totalIncidents += incidentes;
                    if (incidentes > 0) {
                        let procesosDisplay = '';
                        if (proc === 'pavonado') {
                            procesosDisplay = '🟣 Pavonado';
                        } else if (proc === 'ambos') {
                            procesosDisplay = '🔵 Láser<br/>🟣 Pavonado';
                        }

                        piecesWithIncidents.push({
                            partNumber: piece.partNumber || '-',
                            quantity: Number(piece.quantity || 0) || 0,
                            incidents: incidentes,
                            incidentType: incType || 'Sin especificar',
                            process: procesosDisplay,
                            imagen: piece.imagen || piece.imagenPath || piece.image || piece.imagePath || null
                        });
                    }
                }
            }
        });
    });

    // Sumar valores cuantificables introducidos por lote (si existen) para "Piezas pavonadas"
    let expectedFromMetrics = 0;
    try {
        Object.keys(localData).forEach(lk => {
            const lot = localData[lk];
            if (!lot || typeof lot !== 'object') return;
            const nameLower = (lot && lot.name) ? String(lot.name).toLowerCase() : '';
            const isPav = (lot && lot.process === 'pavonado') || lk.startsWith('pavonado-') || nameLower.includes('pavonado');
            if (!isPav) return;

            let v = 0;
            v = Array.isArray(lot.pieces) ? lot.pieces.reduce((s, p) => s + (Number(p.quantity || p.numPiezas || 0) || 0), 0) : 0;
            expectedFromMetrics += v;
        });
    } catch (e) {
        console.warn('Error summing pavonadoMetrics for expected:', e);
    }

    const desiredPercentage = totalPieces > 0 ?
        ((totalPieces - totalIncidents) / totalPieces * 100).toFixed(2) + '%' : '100%';
    const maxKpi = totalPieces > 0 ?
        (totalIncidents / totalPieces * 100).toFixed(2) + '%' : '0%';
    const expectedPieces = expectedFromMetrics > 0 ? expectedFromMetrics : totalPieces;

    const elExp = document.getElementById('report-pavonado-expected-pieces');
    const elTot = document.getElementById('report-pavonado-total-pieces');
    const elDes = document.getElementById('report-pavonado-desired-percentage');
    const elRw = document.getElementById('report-pavonado-rework-pieces');
    const elMx = document.getElementById('report-pavonado-max-kpi');
    if (elExp) elExp.textContent = expectedPieces;
    if (elTot) elTot.textContent = totalPieces;
    if (elDes) elDes.textContent = desiredPercentage;
    if (elRw) elRw.textContent = totalIncidents;
    if (elMx) elMx.textContent = maxKpi;

    // Llenar la tabla de incidencias Pavonado
    const incidentsTableBody = document.getElementById('report-pavonado-incidents-table-body');
    if (incidentsTableBody) {
        if (piecesWithIncidents.length === 0) {
            incidentsTableBody.innerHTML = '<tr><td colspan="6" style="padding: 8px; text-align: center; color: #999;">No hay piezas con incidencias registradas</td></tr>';
        } else {
            incidentsTableBody.innerHTML = piecesWithIncidents.map(piece => {
                const imgSrc = resolvePieceImageSrc(piece.imagen);
                let imgCell = '<td style="padding: 4px; text-align: center; color: #999;">Sin foto</td>';
                if (imgSrc) {
                    const safeSrc = String(imgSrc).replace(/'/g, "\\'");
                    imgCell = `<td style="padding: 8px; text-align: center; width: 260px;"><img src="${imgSrc}" loading="lazy" alt="img" style="max-width:240px;max-height:180px;border-radius:8px;object-fit:cover;cursor:zoom-in" onerror="setImgFallback(this)" ondblclick="openImageModal('${safeSrc}')"/></td>`;
                }

                return `
                <tr>
                    ${imgCell}
                    <td style="padding: 8px;">${piece.partNumber}</td>
                    <td style="padding: 8px; text-align: center;">${piece.quantity}</td>
                    <td style="padding: 8px; text-align: center;">${piece.incidents}</td>
                    <td style="padding: 8px;">${piece.incidentType}</td>
                    <td style="padding: 8px; text-align: center;">${piece.process}</td>
                </tr>
            `;
            }).join('');
        }
    }

    // GENERAR MÉTRICAS DE LOTES EN EL REPORTE PAVONADO
    const reportPavonadoLotesMetricsDiv = document.getElementById('report-pavonado-lotes-metrics');
    if (reportPavonadoLotesMetricsDiv) {
        let lotesMetricsHtml = '';

        // Lotes Pavonado (ordenados)
        const pavLotEntries = Object.keys(localData)
            .map(lotKey => ({ lotKey, lot: localData[lotKey] }))
            .filter(e => e.lot && e.lot.process === 'pavonado')
            .sort(sortLotEntriesByName);

        pavLotEntries.forEach(({ lotKey, lot }) => {

            const sumPiecesInLot = Array.isArray(lot.pieces) ?
                lot.pieces.reduce((s, p) => s + (Number(p.quantity || 0) || 0), 0) : 0;

            const countDefectivePieces = Array.isArray(lot.pieces) ?
                lot.pieces.reduce((count, p) => count + (p.incidents > 0 ? 1 : 0), 0) : 0;

            if (!lot.pavonadoMetrics || typeof lot.pavonadoMetrics !== 'object') lot.pavonadoMetrics = {};

            const defaults = {
                piezas_pavonadas_expected: (lot.pavonadoMetrics.piezas_pavonadas_expected !== undefined && lot.pavonadoMetrics.piezas_pavonadas_expected !== null && lot.pavonadoMetrics.piezas_pavonadas_expected !== '') ? lot.pavonadoMetrics.piezas_pavonadas_expected : sumPiecesInLot,
                piezas_defectos: lot.pavonadoMetrics.piezas_defectos_expected || '0-3',
                temp_banho: lot.pavonadoMetrics.temp_banho_expected || '140°C',
                tiempo_inmersion: lot.pavonadoMetrics.tiempo_inmersion_expected || '25Minutos',
                consumo_quimico: lot.pavonadoMetrics.consumo_quimico_expected || '25Litros / lote',
                piezas_reprocesadas: lot.pavonadoMetrics.piezas_reprocesadas_expected || '0-5',
                piezas_rechazadas: lot.pavonadoMetrics.piezas_rechazadas_expected || 0,
                temp_ambiente: lot.pavonadoMetrics.temp_ambiente_expected || '25°C'
            };

            const vals = {
                piezas_pavonadas: (lot.pavonadoMetrics.piezas_pavonadas !== undefined && lot.pavonadoMetrics.piezas_pavonadas !== null && lot.pavonadoMetrics.piezas_pavonadas !== '') ? lot.pavonadoMetrics.piezas_pavonadas : sumPiecesInLot,
                piezas_defectos: (lot.pavonadoMetrics.piezas_defectos !== undefined && lot.pavonadoMetrics.piezas_defectos !== null && lot.pavonadoMetrics.piezas_defectos !== '') ? lot.pavonadoMetrics.piezas_defectos : countDefectivePieces,
                temp_banho: lot.pavonadoMetrics.temp_banho || '',
                tiempo_inmersion: lot.pavonadoMetrics.tiempo_inmersion || '',
                consumo_quimico: lot.pavonadoMetrics.consumo_quimico || '',
                piezas_reprocesadas: (lot.pavonadoMetrics.piezas_reprocesadas !== undefined && lot.pavonadoMetrics.piezas_reprocesadas !== null && lot.pavonadoMetrics.piezas_reprocesadas !== '') ? lot.pavonadoMetrics.piezas_reprocesadas : countDefectivePieces,
                piezas_rechazadas: (lot.pavonadoMetrics.piezas_rechazadas !== undefined && lot.pavonadoMetrics.piezas_rechazadas !== null && lot.pavonadoMetrics.piezas_rechazadas !== '') ? lot.pavonadoMetrics.piezas_rechazadas : '',
                temp_ambiente: lot.pavonadoMetrics.temp_ambiente || ''
            };

            const expectedInputStyle = 'width: 100%; max-width: 180px; text-align: center; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff;';

            lotesMetricsHtml += `
                <div style="margin-top: 20px; border: 1px solid #ddd; padding: 15px; border-radius: 4px;">
                    <h3>Métricas Pavonado - ${lot.name}</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="background-color: #f5f5f5;">
                                <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Indicador (KPI)</th>
                                <th style="padding: 10px; text-align: center; border: 1px solid #ddd;">RESULTADOS ESPERADOS</th>
                                <th style="padding: 10px; text-align: center; border: 1px solid #ddd;">Método de medición</th>
                                <th style="padding: 10px; text-align: center; border: 1px solid #ddd;">Valor Cuantificable</th>
                                <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Objetivo</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Piezas pavonadas</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="number" min="0" step="1" style="${expectedInputStyle}" class="pav-metric-expected-input" data-lotkey="${lotKey}" data-key="piezas_pavonadas_expected" value="${escapeHtml(defaults.piezas_pavonadas_expected)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Registro de producción</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${vals.piezas_pavonadas}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Volumen de producción</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Piezas con defectos (0-3)</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="text" style="${expectedInputStyle}" class="pav-metric-expected-input" data-lotkey="${lotKey}" data-key="piezas_defectos_expected" value="${escapeHtml(defaults.piezas_defectos)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Inspección visual</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${vals.piezas_defectos}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Calidad del recubrimiento</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Temperatura del baño</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="text" style="${expectedInputStyle}" class="pav-metric-expected-input" data-lotkey="${lotKey}" data-key="temp_banho_expected" value="${escapeHtml(defaults.temp_banho)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Termómetro industrial</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${vals.temp_banho}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Condiciones térmicas</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Tiempo de inmersión</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="text" style="${expectedInputStyle}" class="pav-metric-expected-input" data-lotkey="${lotKey}" data-key="tiempo_inmersion_expected" value="${escapeHtml(defaults.tiempo_inmersion)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Cronómetro/temporizador</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${vals.tiempo_inmersion}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Uniformidad del recubrimiento</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Consumo de solución química</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="text" style="${expectedInputStyle}" class="pav-metric-expected-input" data-lotkey="${lotKey}" data-key="consumo_quimico_expected" value="${escapeHtml(defaults.consumo_quimico)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Registro de insumos</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${vals.consumo_quimico}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Gasto y rendimiento</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Piezas reprocesadas (0-5)</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">
                                    <input type="text" style="${expectedInputStyle}" class="pav-metric-expected-input" data-lotkey="${lotKey}" data-key="piezas_reprocesadas_expected" value="${escapeHtml(defaults.piezas_reprocesadas)}" />
                                </td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Registro de retrabajos</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${vals.piezas_reprocesadas}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">Eficiencia del proceso</td>
                            </tr>
                        </tbody>
                    </table>
                    <div class="metrics-save-container" id="pav-metrics-expected-save-${lotKey}" style="display:none; padding:10px 16px; background:linear-gradient(135deg, #fff3cd, #ffe69c); border:2px solid #ffc107; border-radius:8px; box-shadow: 0 2px 8px rgba(255,193,7,0.3); margin-top:10px;">
                        <div style="font-weight:700; color:#92400e;">Cambios en resultados esperados</div>
                        <button class="btn-save-metrics" data-action="save-expected-metrics" data-type="pavonado" data-lotkey="${lotKey}">💾 Guardar Resultados Esperados</button>
                    </div>
                    ${renderLotPiecePhotos(lot.pieces)}
                </div>
            `;
        });

        reportPavonadoLotesMetricsDiv.innerHTML = lotesMetricsHtml;

        // Activar edición de esperados
        attachExpectedMetricsHandlersOnce();
    }

    // Firmas del reporte Pavonado
    renderReportSignaturesUI('pavonado');
}

// Bind cuando el DOM esté listo (el HTML del modal puede estar después de los <script>)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initReportSignatures());
} else {
    initReportSignatures();
}

function createChartsPavonado() {
    // Destruir gráficas existentes (Pavonado)
    try {
        if (typeof kpiChartPavonado !== 'undefined' && kpiChartPavonado) {
            try { kpiChartPavonado.destroy(); } catch (e) { console.warn('Error destruyendo kpiChartPavonado', e); }
            kpiChartPavonado = null;
        }
    } catch (e) { /* noop */ }
    try {
        if (typeof lotChartPavonado !== 'undefined' && lotChartPavonado) {
            try { lotChartPavonado.destroy(); } catch (e) { console.warn('Error destruyendo lotChartPavonado', e); }
            lotChartPavonado = null;
        }
    } catch (e) { /* noop */ }

    // Calcular datos para las gráficas (SOLO piezas con proceso 'pavonado' o 'ambos')
    let totalPieces = 0;
    let totalIncidents = 0;
    const lotRows = [];

    Object.keys(localData || {}).forEach(lotKey => {
        // Excluir pool global: evita que la dona/barra cuenten piezas aún no asignadas
        if (lotKey === 'lotes') return;
        const lot = localData[lotKey];
        let lotPieces = 0;
        let lotIncidents = 0;

        (lot.pieces || []).forEach(piece => {
            const proc = (piece.proceso || '').toString().toLowerCase();
            if (proc === 'pavonado' || proc === 'ambos') {
                lotPieces += Number(piece.quantity || 0);
                const incType = (piece.incidentType || '').toLowerCase();
                if (incType === 'pavonado' || incType === 'ambos' || incType === '') {
                    lotIncidents += Number(piece.incidents || 0);
                }
            }
        });

        totalPieces += lotPieces;
        totalIncidents += lotIncidents;

        // Incluir en la gráfica por-lote SOLO si el lote corresponde a Pavonado
        try {
            const nameLower = (lot && lot.name) ? String(lot.name).toLowerCase() : '';
            const isPavonadoLot = (lot && lot.process === 'pavonado') || lotKey.startsWith('pavonado-lot-') || lotKey.startsWith('pavonado-') || nameLower.includes('pavonado');
            if (lotKey !== 'lotes' && isPavonadoLot) {
                lotRows.push({ lotKey, name: lot?.name ?? lotKey, pieces: Number(lotPieces), incidents: Number(lotIncidents) });
            }
        } catch (e) {
            if (lotKey !== 'lotes') {
                lotRows.push({ lotKey, name: lot?.name ?? lotKey, pieces: Number(lotPieces), incidents: Number(lotIncidents) });
            }
        }
    });

    lotRows.sort(sortChartLotRows);
    const lotNames = lotRows.map(r => r.name);
    const lotPiecesData = lotRows.map(r => r.pieces);
    const lotIncidentsData = lotRows.map(r => r.incidents);

    const successfulPieces = totalPieces - totalIncidents;
    console.debug('createChartsPavonado computed:', { totalPieces, totalIncidents, successfulPieces, lotNames, lotPiecesData, lotIncidentsData });

    const kpiCanvas = document.getElementById('kpi-chart-pavonado');
    if (!kpiCanvas || !window.Chart) return;
    try {
        const existing = (typeof window.Chart.getChart === 'function') ? window.Chart.getChart(kpiCanvas) : null;
        if (existing) existing.destroy();
    } catch (e) { /* noop */ }
    const kpiCtx = kpiCanvas.getContext('2d');
    kpiChartPavonado = new Chart(kpiCtx, {
        type: 'doughnut',
        data: {
            labels: ['Piezas Correctas', 'Piezas con Incidencias'],
            datasets: [{
                data: [successfulPieces, totalIncidents],
                backgroundColor: ['#27ae60', '#e74c3c'],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: 'Distribución de Piezas Pavonadas', font: { size: 16 } },
                legend: { position: 'bottom' },
                datalabels: { display: true, color: '#fff', font: { weight: 'bold', size: 14 } }
            }
        },
        plugins: [{
            id: 'datalabelsPlugin',
            afterDatasetsDraw(chart) {
                const { ctx, data, chartArea } = chart;
                ctx.save();

                const dataset = chart.getDatasetMeta(0);
                const centerX = (chartArea.left + chartArea.right) / 2;
                const centerY = (chartArea.top + chartArea.bottom) / 2;

                dataset.data.forEach((datapoint, index) => {
                    const value = data.datasets[0].data[index];
                    const angle = (datapoint.startAngle + datapoint.endAngle) / 2;
                    const radius = (datapoint.innerRadius + datapoint.outerRadius) / 2;
                    const labelX = centerX + Math.cos(angle - Math.PI / 2) * radius;
                    const labelY = centerY + Math.sin(angle - Math.PI / 2) * radius;

                    ctx.fillStyle = '#fff';
                    ctx.font = 'bold 16px Arial, sans-serif';
                    const textWidth = ctx.measureText(value).width;
                    ctx.fillRect(labelX - textWidth / 2 - 4, labelY - 10, textWidth + 8, 20);

                    ctx.fillStyle = '#000';
                    ctx.font = 'bold 16px Arial, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(value, labelX, labelY);
                });

                ctx.restore();
            }
        }]
    });

    const lotCanvas = document.getElementById('lot-chart-pavonado');
    if (!lotCanvas || !window.Chart) return;
    try {
        const existing = (typeof window.Chart.getChart === 'function') ? window.Chart.getChart(lotCanvas) : null;
        if (existing) existing.destroy();
    } catch (e) { /* noop */ }
    const lotCtx = lotCanvas.getContext('2d');
    lotChartPavonado = new Chart(lotCtx, {
        type: 'bar',
        data: {
            labels: lotNames,
            datasets: [
                { label: 'Piezas Pavonadas', data: lotPiecesData, backgroundColor: '#3498db' },
                { label: 'Piezas con Incidencias', data: lotIncidentsData, backgroundColor: '#e74c3c' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: 'Producción por Lote', font: { size: 16 } }
            },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: 'Cantidad de Piezas' } }
            }
        }
    });
}

// Reiniciar campos y tablas del reporte (no borra datos de piezas)
function reiniciarReporte(tipo) {
    console.debug('reiniciarReporte called with tipo=', tipo);
    if (!tipo || tipo === 'laser') {
        ['report-expected-pieces', 'report-total-pieces', 'report-desired-percentage', 'report-rework-pieces', 'report-max-kpi'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '-';
        });

        try { if (kpiChart) { kpiChart.destroy(); kpiChart = null; } } catch (e) { console.warn('Error destruyendo kpiChart', e); }
        try { if (lotChart) { lotChart.destroy(); lotChart = null; } } catch (e) { console.warn('Error destruyendo lotChart', e); }

        ['kpi-chart', 'lot-chart'].forEach(id => {
            const old = document.getElementById(id);
            if (old && old.parentNode) {
                const clone = old.cloneNode(false);
                old.parentNode.replaceChild(clone, old);
            }
        });
    }

    if (!tipo || tipo === 'pavonado') {
        ['report-pavonado-expected-pieces', 'report-pavonado-total-pieces', 'report-pavonado-desired-percentage', 'report-pavonado-rework-pieces', 'report-pavonado-max-kpi'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '-';
        });

        try { if (kpiChartPavonado) { kpiChartPavonado.destroy(); kpiChartPavonado = null; } } catch (e) { console.warn('Error destruyendo kpiChart pavonado', e); }
        try { if (lotChartPavonado) { lotChartPavonado.destroy(); lotChartPavonado = null; } } catch (e) { console.warn('Error destruyendo lotChart pavonado', e); }

        ['kpi-chart-pavonado', 'lot-chart-pavonado'].forEach(id => {
            const old = document.getElementById(id);
            if (old && old.parentNode) {
                const clone = old.cloneNode(false);
                old.parentNode.replaceChild(clone, old);
            }
        });
    }

    alert('Campos y gráficas del reporte reiniciados (los datos de registro se han preservado).');
}

function confirmReiniciarReporte(tipo) {
    try {
        const msg = '¿Quieres reiniciar los campos del reporte?\n\nAceptar = Reinicio PERMANENTE (las piezas con proceso "' + tipo + '" se marcarán como no asignadas y esto es irreversible).\nCancelar = Solo reinicio visual (temporal)';
        const permanent = confirm(msg);
        if (permanent) {
            const ok = permanentClearReportData(tipo);
            if (ok) {
                reiniciarReporte(tipo);
                alert('Reinicio permanente completado: los registros fueron desasignados.');
            } else {
                alert('No se pudieron modificar los datos.');
            }
        } else {
            reiniciarReporte(tipo);
        }
    } catch (e) {
        console.error('confirmReiniciarReporte error', e);
        alert('Error al intentar reiniciar el reporte');
    }
}

function permanentClearReportData(tipo) {
    try {
        if (!localData) return false;
        const lowerTipo = (tipo || '').toString().toLowerCase();

        Object.keys(localData).forEach(lotKey => {
            const lot = localData[lotKey];
            if (!lot || !Array.isArray(lot.pieces)) return;
            for (let i = lot.pieces.length - 1; i >= 0; i--) {
                const piece = lot.pieces[i];
                const proc = (piece.proceso || '').toString().toLowerCase();
                if (lowerTipo === '' || proc === lowerTipo || proc === 'ambos') {
                    piece.proceso = '';
                }
            }
        });

        try {
            if (window.App && window.App.persist && window.App.persist.markDirty) {
                window.App.persist.markDirty('reportes.permanentClear');
            }
        } catch (e) { /* noop */ }
        return true;
    } catch (e) {
        console.error('permanentClearReportData error', e);
        return false;
    }
}

// ============================================
// Editor de Reporte (pre-impresión)
// Permite editar, agregar y reordenar bloques antes de imprimir
// ============================================

const ReportEditor = (function() {
    let currentReportType = null; // 'laser' | 'pavonado'
    let editorBlocks = [];
    let originalContent = '';
    let blockIdCounter = 0;
    let draggedBlock = null;

    const modal = () => document.getElementById('report-editor-modal');
    const canvas = () => document.getElementById('report-editor-canvas');

    function generateBlockId() {
        return 'block-' + (++blockIdCounter) + '-' + Date.now();
    }

    function openModal(reportType) {
        currentReportType = reportType;
        const m = modal();
        if (!m) return;
        m.setAttribute('aria-hidden', 'false');
        m.style.display = 'flex';
        initializeEditorContent(reportType);
    }

    function closeModal() {
        const m = modal();
        if (!m) return;
        m.setAttribute('aria-hidden', 'true');
        m.style.display = 'none';
        currentReportType = null;
        editorBlocks = [];
    }

    function getReportContentElement(reportType) {
        const tabId = reportType === 'pavonado' ? 'reporte-pavonado' : 'reporte';
        const tab = document.getElementById(tabId);
        if (!tab) return null;
        return tab.querySelector('.card');
    }

    function initializeEditorContent(reportType) {
        const contentEl = getReportContentElement(reportType);
        if (!contentEl) {
            notify('error', 'No se encontró el contenido del reporte');
            return;
        }

        originalContent = contentEl.innerHTML;
        editorBlocks = [];
        blockIdCounter = 0;

        // Parsear el contenido existente en bloques editables
        const children = contentEl.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const tagName = child.tagName.toLowerCase();
            let blockType = 'html';
            let blockTitle = 'Contenido';

            if (tagName === 'h1' || tagName === 'h2' || tagName === 'h3' || tagName === 'h4') {
                blockType = 'heading';
                blockTitle = 'Título';
            } else if (tagName === 'p' || tagName === 'div' && !child.querySelector('table')) {
                blockType = 'text';
                blockTitle = 'Texto';
            } else if (tagName === 'table' || child.querySelector('table')) {
                blockType = 'table';
                blockTitle = 'Tabla';
            }

            editorBlocks.push({
                id: generateBlockId(),
                type: blockType,
                title: blockTitle,
                content: child.outerHTML
            });
        }

        renderBlocks();
    }

    function renderBlocks() {
        const c = canvas();
        if (!c) return;
        c.innerHTML = '';

        if (editorBlocks.length === 0) {
            c.innerHTML = '<div class="report-editor-empty">No hay contenido. Usa la barra de herramientas para agregar bloques.</div>';
            return;
        }

        editorBlocks.forEach((block, index) => {
            const blockEl = createBlockElement(block, index);
            c.appendChild(blockEl);
        });

        setupDragAndDrop();
    }

    function createBlockElement(block, index) {
        const div = document.createElement('div');
        div.className = 'report-editor-block';
        div.setAttribute('data-block-id', block.id);
        div.setAttribute('draggable', 'true');

        const header = document.createElement('div');
        header.className = 'report-editor-block-header';

        const handle = document.createElement('span');
        handle.className = 'report-editor-block-handle';
        handle.innerHTML = '⋮⋮';
        handle.title = 'Arrastrar para reordenar';

        const title = document.createElement('span');
        title.className = 'report-editor-block-title';
        title.textContent = block.title + ' #' + (index + 1);

        const actions = document.createElement('div');
        actions.className = 'report-editor-block-actions';

        const moveUpBtn = document.createElement('button');
        moveUpBtn.type = 'button';
        moveUpBtn.className = 'action-btn btn-sm btn-secondary';
        moveUpBtn.innerHTML = '↑';
        moveUpBtn.title = 'Mover arriba';
        moveUpBtn.disabled = index === 0;
        moveUpBtn.addEventListener('click', () => moveBlock(index, -1));

        const moveDownBtn = document.createElement('button');
        moveDownBtn.type = 'button';
        moveDownBtn.className = 'action-btn btn-sm btn-secondary';
        moveDownBtn.innerHTML = '↓';
        moveDownBtn.title = 'Mover abajo';
        moveDownBtn.disabled = index === editorBlocks.length - 1;
        moveDownBtn.addEventListener('click', () => moveBlock(index, 1));

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'action-btn btn-sm btn-danger';
        deleteBtn.innerHTML = '✕';
        deleteBtn.title = 'Eliminar bloque';
        deleteBtn.addEventListener('click', () => deleteBlock(index));

        actions.appendChild(moveUpBtn);
        actions.appendChild(moveDownBtn);
        actions.appendChild(deleteBtn);

        header.appendChild(handle);
        header.appendChild(title);
        header.appendChild(actions);

        const content = document.createElement('div');
        content.className = 'report-editor-block-content';
        content.setAttribute('contenteditable', 'true');
        content.innerHTML = block.content;

        content.addEventListener('blur', () => {
            block.content = content.innerHTML;
        });

        content.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text/html') || e.clipboardData.getData('text/plain');
            document.execCommand('insertHTML', false, text);
        });

        div.appendChild(header);
        div.appendChild(content);

        return div;
    }

    function moveBlock(index, direction) {
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= editorBlocks.length) return;

        const temp = editorBlocks[index];
        editorBlocks[index] = editorBlocks[newIndex];
        editorBlocks[newIndex] = temp;

        renderBlocks();
    }

    function deleteBlock(index) {
        if (editorBlocks.length <= 1) {
            notify('warning', 'Debe haber al menos un bloque en el reporte');
            return;
        }
        editorBlocks.splice(index, 1);
        renderBlocks();
    }

    function addBlock(type) {
        let newBlock = {
            id: generateBlockId(),
            type: type,
            title: '',
            content: ''
        };

        switch (type) {
            case 'heading':
                newBlock.title = 'Título';
                newBlock.content = '<h3>Nuevo título</h3>';
                break;
            case 'text':
                newBlock.title = 'Texto';
                newBlock.content = '<p>Nuevo párrafo de texto...</p>';
                break;
            case 'table':
                newBlock.title = 'Tabla';
                newBlock.content = `<table class="report-table" style="width:100%;border-collapse:collapse;">
                    <thead><tr><th style="border:1px solid #333;padding:8px;">Columna 1</th><th style="border:1px solid #333;padding:8px;">Columna 2</th><th style="border:1px solid #333;padding:8px;">Columna 3</th></tr></thead>
                    <tbody><tr><td style="border:1px solid #333;padding:8px;">Dato 1</td><td style="border:1px solid #333;padding:8px;">Dato 2</td><td style="border:1px solid #333;padding:8px;">Dato 3</td></tr></tbody>
                </table>`;
                break;
            default:
                newBlock.title = 'Contenido';
                newBlock.content = '<div>Contenido nuevo</div>';
        }

        editorBlocks.push(newBlock);
        renderBlocks();

        // Scroll al nuevo bloque
        const c = canvas();
        if (c) c.scrollTop = c.scrollHeight;

        notify('success', 'Bloque agregado');
    }

    function resetContent() {
        if (!currentReportType) return;
        initializeEditorContent(currentReportType);
        notify('info', 'Contenido restablecido');
    }

    function setupDragAndDrop() {
        const c = canvas();
        if (!c) return;

        const blocks = c.querySelectorAll('.report-editor-block');

        blocks.forEach((block, index) => {
            block.addEventListener('dragstart', (e) => {
                draggedBlock = index;
                block.classList.add('is-dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            block.addEventListener('dragend', () => {
                block.classList.remove('is-dragging');
                draggedBlock = null;
            });

            block.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });

            block.addEventListener('drop', (e) => {
                e.preventDefault();
                if (draggedBlock === null || draggedBlock === index) return;

                const movedBlock = editorBlocks.splice(draggedBlock, 1)[0];
                editorBlocks.splice(index, 0, movedBlock);
                renderBlocks();
            });
        });
    }

    function saveChanges(andPrint = false) {
        // Guardar tipo antes de cerrar modal
        const reportType = currentReportType;

        // Sincronizar contenido de los bloques editables
        const c = canvas();
        if (c) {
            const blockEls = c.querySelectorAll('.report-editor-block');
            blockEls.forEach((el, i) => {
                const contentEl = el.querySelector('.report-editor-block-content');
                if (contentEl && editorBlocks[i]) {
                    editorBlocks[i].content = contentEl.innerHTML;
                }
            });
        }

        // Generar HTML final
        const finalHtml = editorBlocks.map(b => b.content).join('\n');

        // Guardar en el contenedor de salida para impresión
        const outputId = reportType === 'pavonado' ? 'report-editor-output-pavonado' : 'report-editor-output-laser';
        const outputEl = document.getElementById(outputId);
        if (outputEl) {
            outputEl.innerHTML = finalHtml;
            outputEl.setAttribute('data-active', 'true');
        }

        // Marcar el tab como editado
        const tabId = reportType === 'pavonado' ? 'reporte-pavonado' : 'reporte';
        const tabEl = document.getElementById(tabId);
        if (tabEl) {
            tabEl.setAttribute('data-editor-active', 'true');
        }

        notify('success', 'Cambios guardados');
        closeModal();

        if (andPrint) {
            setTimeout(() => {
                if (reportType === 'pavonado') {
                    executePrintPavonado();
                } else {
                    executePrintLaser();
                }
            }, 100);
        }
    }

    function executePrintLaser() {
        try {
            const h = document.getElementById('header-main-title');
            const r = document.getElementById('report-card-title');
            if (h) h.textContent = 'Registro Grabado Láser';
            if (r) r.textContent = 'Registro Grabado Láser';
        } catch (e) { /* ignore */ }
        window.print();
    }

    function executePrintPavonado() {
        try {
            const h = document.getElementById('header-main-title');
            const r = document.getElementById('report-card-title');
            if (h) h.textContent = 'Registro Pavonado';
            if (r) r.textContent = 'Registro Pavonado';
        } catch (e) { /* ignore */ }
        window.print();
    }

    function cancelEdit() {
        closeModal();
    }

    function promptEditBeforePrint(reportType, directPrintFn) {
        if (typeof showConfirmationModal === 'function') {
            showConfirmationModal({
                title: 'Imprimir Reporte',
                message: '¿Deseas editar el reporte antes de imprimir?',
                confirmText: 'Sí, editar',
                cancelText: 'No, imprimir directo',
                onConfirm: () => {
                    openModal(reportType);
                },
                onCancel: () => {
                    directPrintFn();
                }
            });
        } else {
            // Fallback si no existe showConfirmationModal
            const edit = confirm('¿Deseas editar el reporte antes de imprimir?');
            if (edit) {
                openModal(reportType);
            } else {
                directPrintFn();
            }
        }
    }

    function init() {
        // Botones del toolbar
        const addHeadingBtn = document.getElementById('report-editor-add-heading');
        const addTextBtn = document.getElementById('report-editor-add-text');
        const addTableBtn = document.getElementById('report-editor-add-table');
        const resetBtn = document.getElementById('report-editor-reset');

        if (addHeadingBtn) addHeadingBtn.addEventListener('click', () => addBlock('heading'));
        if (addTextBtn) addTextBtn.addEventListener('click', () => addBlock('text'));
        if (addTableBtn) addTableBtn.addEventListener('click', () => addBlock('table'));
        if (resetBtn) resetBtn.addEventListener('click', resetContent);

        // Botones de acciones del modal
        const cancelBtn = document.getElementById('report-editor-cancel');
        const saveBtn = document.getElementById('report-editor-save');
        const savePrintBtn = document.getElementById('report-editor-save-print');
        const closeBtn = document.getElementById('report-editor-close');

        if (cancelBtn) cancelBtn.addEventListener('click', cancelEdit);
        if (saveBtn) saveBtn.addEventListener('click', () => saveChanges(false));
        if (savePrintBtn) savePrintBtn.addEventListener('click', () => saveChanges(true));
        if (closeBtn) closeBtn.addEventListener('click', cancelEdit);

        // Cerrar con Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const m = modal();
                if (m && m.getAttribute('aria-hidden') === 'false') {
                    cancelEdit();
                }
            }
        });

        // Cerrar al hacer clic fuera del contenido
        const m = modal();
        if (m) {
            m.addEventListener('click', (e) => {
                if (e.target === m) {
                    cancelEdit();
                }
            });
        }
    }

    return {
        init,
        openModal,
        closeModal,
        promptEditBeforePrint,
        executePrintLaser,
        executePrintPavonado
    };
})();

// ============================================
// Editor de Reportes - Pestaña completa
// ============================================

const ReportEditorFullPage = (function() {
    let currentReportType = null;
    let editorBlocks = [];
    let blockIdCounter = 0;
    let draggedBlockIndex = null;

    function getReportContentElement(reportType) {
        const tabId = reportType === 'pavonado' ? 'reporte-pavonado' : 'reporte';
        const tab = document.getElementById(tabId);
        if (!tab) return null;
        return tab.querySelector('.card');
    }

    function generateBlockId() {
        return 'fp-block-' + (++blockIdCounter) + '-' + Date.now();
    }

    function loadReportContent(reportType) {
        currentReportType = reportType;
        const contentEl = getReportContentElement(reportType);
        if (!contentEl) {
            notify('error', 'No se encontró el contenido del reporte');
            return;
        }

        editorBlocks = [];
        blockIdCounter = 0;

        const children = contentEl.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const tagName = child.tagName.toLowerCase();
            let blockType = 'html';
            let blockTitle = 'Contenido';

            if (tagName === 'h1' || tagName === 'h2' || tagName === 'h3' || tagName === 'h4') {
                blockType = 'heading';
                blockTitle = 'Título';
            } else if (tagName === 'p' || (tagName === 'div' && !child.querySelector('table'))) {
                blockType = 'text';
                blockTitle = 'Texto';
            } else if (tagName === 'table' || child.querySelector('table')) {
                blockType = 'table';
                blockTitle = 'Tabla';
            } else if (tagName === 'hr') {
                blockType = 'separator';
                blockTitle = 'Separador';
            } else if (child.querySelector('img')) {
                blockType = 'image';
                blockTitle = 'Imagen';
            }

            editorBlocks.push({
                id: generateBlockId(),
                type: blockType,
                title: blockTitle,
                content: child.outerHTML
            });
        }

        showEditor();
        renderBlocks();
    }

    function showEditor() {
        const workspace = document.getElementById('report-editor-workspace');
        const toolbar = document.getElementById('report-editor-toolbar-main');
        const canvas = document.getElementById('report-editor-canvas-main');

        if (workspace) workspace.style.display = 'none';
        if (toolbar) toolbar.style.display = 'flex';
        if (canvas) canvas.style.display = 'block';

        // Marcar tarjeta activa
        document.querySelectorAll('.report-selector-card').forEach(card => {
            card.classList.remove('active');
            if (card.dataset.report === currentReportType) {
                card.classList.add('active');
            }
        });
    }

    function hideEditor() {
        const workspace = document.getElementById('report-editor-workspace');
        const toolbar = document.getElementById('report-editor-toolbar-main');
        const canvas = document.getElementById('report-editor-canvas-main');

        if (workspace) workspace.style.display = 'block';
        if (toolbar) toolbar.style.display = 'none';
        if (canvas) canvas.style.display = 'none';

        document.querySelectorAll('.report-selector-card').forEach(card => {
            card.classList.remove('active');
        });

        currentReportType = null;
        editorBlocks = [];
    }

    function renderBlocks() {
        const container = document.getElementById('editor-canvas-blocks');
        if (!container) return;
        container.innerHTML = '';

        if (editorBlocks.length === 0) {
            container.innerHTML = '<div class="report-editor-empty">No hay contenido. Usa la barra de herramientas para agregar bloques.</div>';
            return;
        }

        editorBlocks.forEach((block, index) => {
            const blockEl = createBlockElement(block, index);
            container.appendChild(blockEl);
        });

        setupDragAndDrop();
    }

    function createBlockElement(block, index) {
        const div = document.createElement('div');
        div.className = 'report-editor-block';
        div.setAttribute('data-block-id', block.id);
        div.setAttribute('data-index', index);
        div.setAttribute('draggable', 'true');

        const header = document.createElement('div');
        header.className = 'report-editor-block-header';

        const handle = document.createElement('span');
        handle.className = 'report-editor-block-handle';
        handle.innerHTML = '⋮⋮';
        handle.title = 'Arrastrar para reordenar';

        const title = document.createElement('span');
        title.className = 'report-editor-block-title';
        title.textContent = block.title + ' #' + (index + 1);

        const actions = document.createElement('div');
        actions.className = 'report-editor-block-actions';

        const moveUpBtn = document.createElement('button');
        moveUpBtn.type = 'button';
        moveUpBtn.className = 'action-btn btn-sm btn-secondary';
        moveUpBtn.innerHTML = '↑';
        moveUpBtn.title = 'Mover arriba';
        moveUpBtn.disabled = index === 0;
        moveUpBtn.addEventListener('click', () => moveBlock(index, -1));

        const moveDownBtn = document.createElement('button');
        moveDownBtn.type = 'button';
        moveDownBtn.className = 'action-btn btn-sm btn-secondary';
        moveDownBtn.innerHTML = '↓';
        moveDownBtn.title = 'Mover abajo';
        moveDownBtn.disabled = index === editorBlocks.length - 1;
        moveDownBtn.addEventListener('click', () => moveBlock(index, 1));

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'action-btn btn-sm btn-danger';
        deleteBtn.innerHTML = '✕';
        deleteBtn.title = 'Eliminar bloque';
        deleteBtn.addEventListener('click', () => deleteBlock(index));

        actions.appendChild(moveUpBtn);
        actions.appendChild(moveDownBtn);
        actions.appendChild(deleteBtn);

        header.appendChild(handle);
        header.appendChild(title);
        header.appendChild(actions);

        const content = document.createElement('div');
        content.className = 'report-editor-block-content';
        content.setAttribute('contenteditable', 'true');
        content.innerHTML = block.content;

        content.addEventListener('blur', () => {
            block.content = content.innerHTML;
        });

        content.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text/html') || e.clipboardData.getData('text/plain');
            document.execCommand('insertHTML', false, text);
        });

        div.appendChild(header);
        div.appendChild(content);

        return div;
    }

    function moveBlock(index, direction) {
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= editorBlocks.length) return;

        const temp = editorBlocks[index];
        editorBlocks[index] = editorBlocks[newIndex];
        editorBlocks[newIndex] = temp;

        renderBlocks();
    }

    function deleteBlock(index) {
        if (editorBlocks.length <= 1) {
            notify('warning', 'Debe haber al menos un bloque en el reporte');
            return;
        }
        editorBlocks.splice(index, 1);
        renderBlocks();
    }

    function addBlock(type) {
        if (!currentReportType) {
            notify('warning', 'Primero selecciona un reporte para editar');
            return;
        }

        let newBlock = {
            id: generateBlockId(),
            type: type,
            title: '',
            content: ''
        };

        switch (type) {
            case 'heading':
                newBlock.title = 'Título';
                newBlock.content = '<h3>Nuevo título</h3>';
                break;
            case 'text':
                newBlock.title = 'Texto';
                newBlock.content = '<p>Nuevo párrafo de texto...</p>';
                break;
            case 'table':
                newBlock.title = 'Tabla';
                newBlock.content = `<table class="report-table" style="width:100%;border-collapse:collapse;">
                    <thead><tr><th style="border:1px solid #333;padding:8px;">Columna 1</th><th style="border:1px solid #333;padding:8px;">Columna 2</th><th style="border:1px solid #333;padding:8px;">Columna 3</th></tr></thead>
                    <tbody><tr><td style="border:1px solid #333;padding:8px;">Dato 1</td><td style="border:1px solid #333;padding:8px;">Dato 2</td><td style="border:1px solid #333;padding:8px;">Dato 3</td></tr></tbody>
                </table>`;
                break;
            case 'image':
                newBlock.title = 'Imagen';
                newBlock.content = '<div class="image-placeholder" style="text-align:center;padding:20px;background:#f0f0f0;border:2px dashed #ccc;border-radius:8px;"><p>📷 Haz clic para agregar una imagen</p></div>';
                break;
            case 'separator':
                newBlock.title = 'Separador';
                newBlock.content = '<hr style="border:none;border-top:2px solid #e2e8f0;margin:20px 0;">';
                break;
            default:
                newBlock.title = 'Contenido';
                newBlock.content = '<div>Contenido nuevo</div>';
        }

        editorBlocks.push(newBlock);
        renderBlocks();

        const container = document.getElementById('editor-canvas-blocks');
        if (container) container.scrollTop = container.scrollHeight;

        notify('success', 'Bloque agregado');
    }

    function resetContent() {
        if (!currentReportType) return;
        loadReportContent(currentReportType);
        notify('info', 'Contenido restablecido');
    }

    function setupDragAndDrop() {
        const container = document.getElementById('editor-canvas-blocks');
        if (!container) return;

        const blocks = container.querySelectorAll('.report-editor-block');

        blocks.forEach((block) => {
            const index = parseInt(block.dataset.index, 10);

            block.addEventListener('dragstart', (e) => {
                draggedBlockIndex = index;
                block.classList.add('is-dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            block.addEventListener('dragend', () => {
                block.classList.remove('is-dragging');
                draggedBlockIndex = null;
            });

            block.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });

            block.addEventListener('drop', (e) => {
                e.preventDefault();
                const targetIndex = parseInt(block.dataset.index, 10);
                if (draggedBlockIndex === null || draggedBlockIndex === targetIndex) return;

                const movedBlock = editorBlocks.splice(draggedBlockIndex, 1)[0];
                editorBlocks.splice(targetIndex, 0, movedBlock);
                renderBlocks();
            });
        });
    }

    function syncBlockContent() {
        const container = document.getElementById('editor-canvas-blocks');
        if (container) {
            const blockEls = container.querySelectorAll('.report-editor-block');
            blockEls.forEach((el, i) => {
                const contentEl = el.querySelector('.report-editor-block-content');
                if (contentEl && editorBlocks[i]) {
                    editorBlocks[i].content = contentEl.innerHTML;
                }
            });
        }
    }

    function saveChanges(andPrint = false) {
        if (!currentReportType) {
            notify('warning', 'No hay reporte seleccionado');
            return;
        }

        const reportType = currentReportType;
        syncBlockContent();

        const finalHtml = editorBlocks.map(b => b.content).join('\n');

        const outputId = reportType === 'pavonado' ? 'report-editor-output-pavonado' : 'report-editor-output-laser';
        const outputEl = document.getElementById(outputId);
        if (outputEl) {
            outputEl.innerHTML = finalHtml;
            outputEl.setAttribute('data-active', 'true');
        }

        const tabId = reportType === 'pavonado' ? 'reporte-pavonado' : 'reporte';
        const tabEl = document.getElementById(tabId);
        if (tabEl) {
            tabEl.setAttribute('data-editor-active', 'true');
        }

        notify('success', 'Cambios guardados');

        if (andPrint) {
            setTimeout(() => {
                if (reportType === 'pavonado') {
                    ReportEditor.executePrintPavonado();
                } else {
                    ReportEditor.executePrintLaser();
                }
            }, 100);
        }
    }

    function previewReport() {
        if (!currentReportType) {
            notify('warning', 'No hay reporte seleccionado');
            return;
        }
        syncBlockContent();
        const finalHtml = editorBlocks.map(b => b.content).join('\n');
        
        const previewWindow = window.open('', '_blank');
        if (previewWindow) {
            previewWindow.document.write(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Vista Previa - Reporte</title>
                    <style>
                        body { font-family: 'Segoe UI', Tahoma, sans-serif; padding: 20px; max-width: 1000px; margin: 0 auto; }
                        table { width: 100%; border-collapse: collapse; margin: 10px 0; }
                        th, td { border: 1px solid #333; padding: 8px; }
                        th { background: #f0f0f0; }
                        h1, h2, h3, h4 { margin: 1rem 0; }
                        img { max-width: 100%; height: auto; }
                    </style>
                </head>
                <body>${finalHtml}</body>
                </html>
            `);
            previewWindow.document.close();
        }
    }

    function init() {
        // Botones de selección de reporte
        const editLaserBtn = document.getElementById('edit-report-laser');
        const editPavBtn = document.getElementById('edit-report-pavonado');

        if (editLaserBtn) editLaserBtn.addEventListener('click', () => loadReportContent('laser'));
        if (editPavBtn) editPavBtn.addEventListener('click', () => loadReportContent('pavonado'));

        // Botones del toolbar
        const addHeadingBtn = document.getElementById('editor-add-heading');
        const addTextBtn = document.getElementById('editor-add-text');
        const addTableBtn = document.getElementById('editor-add-table');
        const addImageBtn = document.getElementById('editor-add-image');
        const addSeparatorBtn = document.getElementById('editor-add-separator');
        const resetBtn = document.getElementById('editor-reset');
        const previewBtn = document.getElementById('editor-preview');
        const saveBtn = document.getElementById('editor-save');
        const savePrintBtn = document.getElementById('editor-save-print');

        if (addHeadingBtn) addHeadingBtn.addEventListener('click', () => addBlock('heading'));
        if (addTextBtn) addTextBtn.addEventListener('click', () => addBlock('text'));
        if (addTableBtn) addTableBtn.addEventListener('click', () => addBlock('table'));
        if (addImageBtn) addImageBtn.addEventListener('click', () => addBlock('image'));
        if (addSeparatorBtn) addSeparatorBtn.addEventListener('click', () => addBlock('separator'));
        if (resetBtn) resetBtn.addEventListener('click', resetContent);
        if (previewBtn) previewBtn.addEventListener('click', previewReport);
        if (saveBtn) saveBtn.addEventListener('click', () => saveChanges(false));
        if (savePrintBtn) savePrintBtn.addEventListener('click', () => saveChanges(true));
    }

    return {
        init,
        loadReportContent,
        hideEditor
    };
})();

// Inicializar editor de reportes
document.addEventListener('DOMContentLoaded', function() {
    ReportEditor.init();
    ReportEditorFullPage.init();
});

// Sobrescribir funciones de impresión para incluir el prompt de edición
(function() {
    const originalPrintReport = window.printReport;
    const originalPrintReportPavonado = window.printReportPavonado;

    window.printReport = function() {
        ReportEditor.promptEditBeforePrint('laser', function() {
            if (typeof originalPrintReport === 'function') {
                originalPrintReport();
            } else {
                ReportEditor.executePrintLaser();
            }
        });
    };

    window.printReportPavonado = function() {
        ReportEditor.promptEditBeforePrint('pavonado', function() {
            if (typeof originalPrintReportPavonado === 'function') {
                originalPrintReportPavonado();
            } else {
                ReportEditor.executePrintPavonado();
            }
        });
    };
})();
