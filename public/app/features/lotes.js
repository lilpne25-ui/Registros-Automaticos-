// Lotes - Gestión de lotes (crear, eliminar, renderizar)
// Extraído para modularización (2025-12-18)

(function(global) {
    'use strict';
    
    const getServerUrl = () => global.App?.config?.serverUrl || 'http://localhost:3000';

    // Guardar referencias legacy (definidas en el HTML inline) para no romper compatibilidad.
    // El flujo "Enviar a Lote Específico" usa un grid (#lote-chooser-grid) y pendingLoteSelections.
    const legacy = {
        processAddSelectedToLotes: global.processAddSelectedToLotes,
        showLoteChooser: global.showLoteChooser,
        hideLoteChooser: global.hideLoteChooser
    };
    
    // Obtener localData del store o variable global
    function getLocalData() {
        return global.Store ? global.Store.getLocalData() : global.localData;
    }

    function isValidLotId(id) {
        const key = String(id || '');
        const validPrefixes = ['lotes', 'whatsapp_inbox', 'laser-lot-', 'pavonado-lot-'];
        return validPrefixes.some(prefix => key === prefix || key.startsWith(prefix));
    }

    // Limpieza defensiva: si por alguna razón quedan lotes legacy en memoria, quitarlos
    function purgeInvalidLotsInMemory() {
        try {
            const localData = getLocalData();
            let removed = 0;
            for (const key of Object.keys(localData || {})) {
                if (!isValidLotId(key)) {
                    delete localData[key];
                    removed++;
                }
            }
            if (removed > 0) {
                console.warn(`🧹 [Lotes] Removidos ${removed} lote(s) inválido(s) de memoria`);
                markDirty('purgeInvalidLotsInMemory');
            }
        } catch (e) { /* noop */ }
    }
    
    // Marcar datos como modificados
    function markDirty(reason) {
        if (global.markLocalDataDirty) {
            global.markLocalDataDirty(reason);
        } else if (global.Store) {
            global.Store.markDirty(reason);
        }
    }

    // ============================================
    // HELPERS: proceso por lote + refresco de reportes
    // ============================================

    function inferProcessForLotKey(lotKey) {
        const lk = String(lotKey || '').toLowerCase();
        if (lk === 'lotes') return '';
        if (lk.startsWith('pavonado-')) return 'pavonado';
        if (lk.startsWith('laser-')) return 'laser';
        return '';
    }

    function normalizeLotProcessForPiece(lot) {
        const p = String(lot?.process || '').toLowerCase();
        if (p === 'laser') return 'laser';
        if (p === 'pavonado') return 'pavonado';
        // En este sistema, process='all' equivale a pieza con proceso 'ambos'.
        if (p === 'all' || p === 'ambos') return 'ambos';
        return '';
    }

    function getActiveTabId() {
        try {
            const t = global.document && global.document.querySelector
                ? global.document.querySelector('.tab.active')
                : null;
            return t ? t.getAttribute('data-tab') : null;
        } catch (e) {
            return null;
        }
    }

    function refreshReportsIfActive() {
        try {
            if (typeof global.refreshAllViewsDebounced === 'function') {
                global.refreshAllViewsDebounced();
                return;
            }
        } catch (e) { /* noop */ }

        const tab = getActiveTabId();
        if (tab === 'reporte') {
            try { if (typeof global.loadReportData === 'function') global.loadReportData(); } catch (e) { /* noop */ }
            try { if (typeof global.createCharts === 'function') global.createCharts(); } catch (e) { /* noop */ }
        } else if (tab === 'reporte-pavonado') {
            try { if (typeof global.loadReportDataPavonado === 'function') global.loadReportDataPavonado(); } catch (e) { /* noop */ }
            try { if (typeof global.createChartsPavonado === 'function') global.createChartsPavonado(); } catch (e) { /* noop */ }
        }
    }
    
    // ============================================
    // CREAR LOTE
    // ============================================
    
    function createNewLot() {
        const lotName = document.getElementById('new-lot-name')?.value?.trim();
        const lotDescription = document.getElementById('new-lot-description')?.value?.trim() || '';
        const lotProcess = document.getElementById('new-lot-process')?.value || '';

        console.log('🎯 createNewLot START - name:', lotName, 'process:', lotProcess);

        if (!lotName) {
            alert('Por favor ingresa un nombre para el lote');
            return;
        }
        
        if (!lotProcess || String(lotProcess).trim() === '') {
            alert('Por favor selecciona un proceso válido (Láser, Pavonado o Ambos)');
            return;
        }

        const localData = getLocalData();
        // ✅ IDs válidos: evitar `lot-...` (eso crea duplicados y rompe borrado)
        const nowId = String(Date.now());
        const idPrefix = (function () {
            if (lotProcess === 'pavonado') return 'pavonado-lot-';
            // Para "ambos" y "laser" usamos prefijo láser (process='all' para ambos)
            return 'laser-lot-';
        })();
        const lotId = idPrefix + nowId;
        
        // Nombre visible basado en proceso
        let displayName = lotName;
        if (lotProcess === 'laser') displayName = `${lotName} (Láser)`;
        else if (lotProcess === 'pavonado') displayName = `${lotName} (Pavonado)`;
        else if (lotProcess === 'ambos') displayName = `${lotName} (Láser y Pavonado)`;

        // Crear estructura del lote
        localData[lotId] = {
            name: displayName,
            description: lotDescription,
            pieces: [],
            createdAt: new Date().toLocaleString('es-ES'),
            process: (lotProcess === 'ambos' ? 'all' : (lotProcess || null))
        };
        
        console.log('✅ Lote agregado a localData:', lotId, 'con process:', localData[lotId].process);

        // Agregar opciones a selects
        addLotToSelects(lotId, displayName);

        // Guardar en BD
        console.log('💾 Guardando lote en BD:', lotId);
        saveLotToDatabase(lotId, localData[lotId]).then(success => {
            if (success) {
                console.log('✅ Lote guardado en BD exitosamente');
                alert(`✅ Lote "${lotName}" creado exitosamente`);
                if (typeof hideAddNewLotModal === 'function') hideAddNewLotModal();
                if (typeof renderLotes === 'function') renderLotes();
                
                // Auto-cargar el nuevo lote
                setTimeout(() => {
                    const lotSelect = document.getElementById('lot-select');
                    if (lotSelect && global.loadLotRegistrationHandler) {
                        lotSelect.value = lotId;
                        global.loadLotRegistrationHandler.call(lotSelect);
                        console.log('✅ Nuevo lote cargado automáticamente:', lotId);
                    }
                }, 100);
            } else {
                console.error('❌ Error guardando lote en BD');
                alert('❌ Error guardando lote en BD');
                delete localData[lotId];
            }
        }).catch(err => {
            console.error('❌ Error guardando lote:', err);
            alert('❌ Error guardando lote: ' + err.message);
            delete localData[lotId];
        });
    }
    
    function addLotToSelects(lotId, displayName) {
        const selects = ['lote-chooser-select', 'lot-select'];
        selects.forEach(selId => {
            const sel = document.getElementById(selId);
            if (sel) {
                const option = document.createElement('option');
                option.value = lotId;
                option.textContent = displayName;
                sel.appendChild(option);
            }
        });
    }
    
    async function saveLotToDatabase(lotId, lotData) {
        try {
            if (!lotId) return false;

            const metaIn = (lotData && typeof lotData === 'object') ? lotData : {};
            const payload = {
                id: String(lotId),
                name: (metaIn.name || lotId),
                process: metaIn.process || 'all',
                metadata: {
                    ...(metaIn.metadata && typeof metaIn.metadata === 'object' ? metaIn.metadata : {}),
                    description: metaIn.description || '',
                    createdAt: metaIn.createdAt || null
                }
            };

            const response = await fetch(`${getServerUrl()}/api/lotes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const txt = await response.text().catch(() => '');
                console.warn('⚠️ Error guardando lote en BD:', response.status, response.statusText, txt);
                return false;
            }

            console.log('✅ Lote guardado en BD:', lotId);
            return true;
        } catch (err) {
            console.warn('⚠️ Error guardando lote en BD:', err);
            return false;
        }
    }
    
    // ============================================
    // ELIMINAR LOTE
    // ============================================
    
    async function promptDeleteSelectedLot() {
        try {
            const sel = document.getElementById('lot-select');
            const lotId = sel ? sel.value : null;
            if (!lotId) return alert('No hay lote seleccionado');
            if (lotId === 'lotes') return alert('No se puede eliminar el pool "lotes"');

            const localData = getLocalData();
            const lot = localData[lotId] || { name: lotId, pieces: [] };
            const count = Array.isArray(lot.pieces) ? lot.pieces.length : 0;
            
            const confirmMsg = count > 0
                ? `El lote "${lot.name}" contiene ${count} pieza(s). Al eliminar el lote, las piezas se moverán al pool general y NO se borrarán del registro. ¿Deseas continuar?`
                : `¿Eliminar el lote "${lot.name}"?`;

            if (!confirm(confirmMsg)) return;
            
            const ok = await deleteLot(lotId);
            if (ok) {
                alert('Lote eliminado. Las piezas se preservaron en el pool general.');
            } else {
                alert('No se pudo eliminar el lote.');
            }
        } catch (e) {
            console.error('promptDeleteSelectedLot error', e);
            alert('Error al intentar eliminar lote');
        }
    }

    async function deleteLot(lotId) {
        try {
            const localData = getLocalData();
            
            if (!lotId || lotId === 'lotes') return false;
            if (!localData[lotId]) return false;

            // Asegurar pool general
            if (!localData.lotes) {
                localData.lotes = { name: 'LOTES', pieces: [] };
            }

            const pieces = Array.isArray(localData[lotId].pieces) ? localData[lotId].pieces : [];

            // ✅ Persistencia: primero mover piezas en BD y borrar el lote en BD
            const movedOk = await movePiecesToPoolInDatabase(pieces);
            if (!movedOk) {
                console.warn('⚠️ No se pudieron mover todas las piezas a pool en BD; se intentará borrar el lote igualmente.');
            }

            const deleted = await deleteLotFromDatabase(lotId);
            if (!deleted) {
                console.warn('⚠️ No se pudo eliminar lote en BD:', lotId);
                return false;
            }

            // Mover piezas al pool general localmente
            localData.lotes.pieces = (localData.lotes.pieces || []).concat(pieces);

            // Eliminar el lote local
            delete localData[lotId];

            // Recalcular métricas
            if (localData.lotes && localData.lotes.process && typeof recalculateMetricsForLot === 'function') {
                recalculateMetricsForLot('lotes');
            }

            // Eliminar opciones en los selects
            removeLotFromSelects(lotId);

            // Marcar dirty para que otros cambios locales (selects, métricas, etc.) se sincronicen
            markDirty('deleteLot');

            // Actualizar UI
            updateDeleteButtonState();
            if (typeof renderLotes === 'function') renderLotes();

            return true;
        } catch (e) {
            console.error('deleteLot error', e);
            return false;
        }
    }
    
    function removeLotFromSelects(lotId) {
        const selects = ['lot-select', 'lote-chooser-select'];
        selects.forEach(selId => {
            const sel = document.getElementById(selId);
            if (!sel) return;
            const opt = sel.querySelector(`option[value="${lotId}"]`);
            if (opt) opt.remove();
        });
    }
    
    async function deleteLotFromDatabase(lotId) {
        try {
            const url = `${getServerUrl()}/api/lotes/${encodeURIComponent(lotId)}`;
            console.log('🗑️ [Lotes] DELETE:', url);
            const response = await fetch(url, { method: 'DELETE' });
            if (!response.ok) {
                const txt = await response.text().catch(() => '');
                console.warn('⚠️ [Lotes] DELETE falló:', response.status, response.statusText, txt);
                return false;
            }
            const json = await response.json().catch(() => ({}));
            // db.deleteLot devuelve { deleted: <n> }
            const deleted = (json && typeof json.deleted === 'number') ? json.deleted : 0;
            return deleted > 0;
        } catch (err) {
            console.warn('Error eliminando lote de BD:', err);
            return false;
        }
    }

    async function movePiecesToPoolInDatabase(pieces) {
        try {
            if (!Array.isArray(pieces) || pieces.length === 0) return true;
            let ok = true;
            for (const piece of pieces) {
                if (!piece || !piece.uid) continue;
                try {
                    const resp = await fetch(`${getServerUrl()}/api/pieces`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            ...piece,
                            lot_id: 'lotes'
                        })
                    });
                    if (!resp.ok) ok = false;
                } catch (e) {
                    ok = false;
                }
            }
            return ok;
        } catch (e) {
            return false;
        }
    }
    
    function updateDeleteButtonState() {
        try {
            const delBtn = document.getElementById('delete-lot-btn');
            const sel = document.getElementById('lot-select');
            const selVal = sel ? sel.value : null;
            if (!delBtn) return;
            
            if (!selVal || selVal === 'lotes') {
                delBtn.disabled = true;
                delBtn.style.opacity = 0.6;
            } else {
                delBtn.disabled = false;
                delBtn.style.opacity = 1;
            }
        } catch (e) { /* noop */ }
    }
    
    // ============================================
    // MOVER PIEZAS ENTRE LOTES
    // ============================================
    
    function processAddSelectedToLotes(targetLotKeyOrArray, options) {
        try {
            const mode = (options && String(options.mode).toLowerCase() === 'copy') ? 'copy' : 'move';

            const localData = getLocalData();
            const currentLotKey = global.currentRegistroLot || 'lotes';
            const currentLot = localData[currentLotKey];
            if (!currentLot || !Array.isArray(currentLot.pieces)) return;

            // Obtener piezas seleccionadas
            const checkboxes = document.querySelectorAll('.piece-checkbox:checked');
            if (checkboxes.length === 0) {
                if (typeof showNotification === 'function') {
                    showNotification('⚠️ Selecciona al menos una pieza', 'warning');
                }
                return;
            }

            const selectedUids = Array.from(checkboxes).map(cb => cb.dataset.uid);
            
            // Determinar lotes destino
            const targetKeys = Array.isArray(targetLotKeyOrArray) ? targetLotKeyOrArray : [targetLotKeyOrArray];

            const uniqueTargets = Array.from(new Set(targetKeys.filter(Boolean)));
            const isMultiDest = uniqueTargets.length > 1;
            const isCopy = (mode === 'copy');

            if (!isCopy && isMultiDest) {
                if (typeof showNotification === 'function') {
                    showNotification('⚠️ Para MOVER selecciona solo 1 lote destino. Para varios, usa COPIAR.', 'warning');
                } else {
                    alert('⚠️ Para MOVER selecciona solo 1 lote destino. Para varios, usa COPIAR.');
                }
                return;
            }

            let movedCount = 0;
            const upserts = [];
            const deletes = [];
            selectedUids.forEach(uid => {
                const pieceIndex = currentLot.pieces.findIndex(p => p.uid === uid);
                if (pieceIndex === -1) return;

                const piece = currentLot.pieces[pieceIndex];
                
                uniqueTargets.forEach(targetKey => {
                    if (!localData[targetKey]) {
                        // Fallback defensivo: si el destino no existe, crear con proceso inferido por prefijo.
                        const inferred = inferProcessForLotKey(targetKey) || 'laser';
                        localData[targetKey] = { name: targetKey, pieces: [], process: inferred };
                    }
                    
                    // Clonar pieza para cada lote destino
                    const clonedPiece = JSON.parse(JSON.stringify(piece));

                    // Regla:
                    // - move (1 destino) => preservar uid (BD interpreta como update de lot_id)
                    // - copy o multi-destino => uid distinto por destino
                    if (isCopy || isMultiDest) {
                        clonedPiece.uid = 'u_' + Date.now() + '_' + Math.floor(Math.random()*100000);
                    }

                    // Mantener el campo "proceso" consistente con el lote destino.
                    // Esto es lo que alimenta las métricas (piezas grabadas/pavonadas) y los reportes.
                    if (targetKey === 'lotes') {
                        clonedPiece.proceso = '';
                    } else {
                        const proc = normalizeLotProcessForPiece(localData[targetKey]) || inferProcessForLotKey(targetKey);
                        if (proc) clonedPiece.proceso = proc;
                    }
                    localData[targetKey].pieces.push(clonedPiece);

                    // Persistencia en servidor: upsert por cada destino
                    upserts.push({
                        uid: clonedPiece.uid,
                        lot_id: targetKey,
                        partNumber: clonedPiece.partNumber || '',
                        quantity: (clonedPiece.quantity !== undefined ? clonedPiece.quantity : (clonedPiece.numPiezas !== undefined ? clonedPiece.numPiezas : (clonedPiece.piezas !== undefined ? clonedPiece.piezas : 0))),
                        incidents: (clonedPiece.incidents !== undefined ? clonedPiece.incidents : 0),
                        incidentType: clonedPiece.incidentType || '',
                        timestamp: clonedPiece.timestamp || new Date().toISOString(),
                        imagen: (clonedPiece.imagen !== undefined ? clonedPiece.imagen : null),
                        sourceFile: clonedPiece.sourceFile || null,
                        clientId: clonedPiece.clientId || null,
                        messageId: clonedPiece.messageId || null,
                        proceso: clonedPiece.proceso || '',
                        metadata: (clonedPiece.metadata && typeof clonedPiece.metadata === 'object') ? clonedPiece.metadata : undefined
                    });
                });

                // Remover del lote origen solo en MOVE
                if (!isCopy) {
                    currentLot.pieces.splice(pieceIndex, 1);
                }
                movedCount++;
            });

            if (movedCount > 0) {
                // Recalcular métricas de lotes afectados (piezas grabadas/pavonadas)
                try {
                    if (typeof global.recalculateMetricsForLot === 'function') {
                        global.recalculateMetricsForLot(currentLotKey);
                        uniqueTargets.forEach(tk => {
                            try { global.recalculateMetricsForLot(tk); } catch (e) { /* noop */ }
                        });
                    }
                } catch (e) { /* noop */ }

                markDirty('processAddSelectedToLotes');
                if (typeof showNotification === 'function') {
                    showNotification(`✅ ${movedCount} pieza(s) ${isCopy ? 'copiada(s)' : 'movida(s)'}`, 'success');
                }
                if (typeof loadLotRegistration === 'function') {
                    loadLotRegistration(currentLotKey);
                }
                if (typeof renderLotes === 'function') {
                    renderLotes();
                }

                // Refrescar KPIs y, si aplica, reportes/gráficas
                try { if (typeof global.loadDashboardData === 'function') global.loadDashboardData(); } catch (e) { /* noop */ }
                refreshReportsIfActive();

                // Persistir en servidor sin bloquear la UI
                try {
                    (async () => {
                        const baseUrl = getServerUrl();
                        // Upserts
                        for (const p of upserts) {
                            if (!p || !p.uid || !p.lot_id) continue;
                            try {
                                const r = await fetch(`${baseUrl}/api/pieces`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    credentials: 'include',
                                    body: JSON.stringify(p)
                                });
                                if (!r.ok) {
                                    const t = await r.text().catch(() => '');
                                    console.warn('⚠️ [Lotes] Upsert pieza falló:', p.uid, r.status, r.statusText, t);
                                }
                            } catch (e) {
                                console.warn('⚠️ [Lotes] Upsert pieza error:', p.uid, e);
                            }
                        }

                        // En COPY no se borra el original.
                    })();
                } catch (e) { /* noop */ }
            }
        } catch (err) {
            console.error('processAddSelectedToLotes error', err);
        }
    }
    
    // ============================================
    // GENERAR NOMBRE DE LOTE
    // ============================================
    
    function generateNextLotName() {
        try {
            const localData = getLocalData();
            const existingLots = Object.values(localData || {});

            // Buscar el número más alto dentro del patrón: "LOTE 00-XX"
            let maxNum = 0;
            for (const lot of existingLots) {
                const name = (lot && lot.name) ? String(lot.name) : '';
                const m = name.match(/\bLOTE\s+\d{2}-(\d{2,})\b/i);
                if (!m) continue;
                const n = parseInt(m[1], 10);
                if (Number.isFinite(n) && n > maxNum) maxNum = n;
            }

            const next = String(maxNum + 1).padStart(2, '0');
            return `LOTE 00-${next}`;
        } catch (e) {
            return `LOTE 00-01`;
        }
    }
    
    // ============================================
    // MODALES
    // ============================================
    
    function showAddNewLotModal() {
        const modal = document.getElementById('add-new-lot-modal');
        if (!modal) return;
        
        // Pre-llenar nombre sugerido
        const nameInput = document.getElementById('new-lot-name');
        if (nameInput) {
            nameInput.value = generateNextLotName();
        }
        
        modal.style.display = 'flex';
    }
    
    function hideAddNewLotModal() {
        const modal = document.getElementById('add-new-lot-modal');
        if (!modal) return;
        modal.style.display = 'none';
        
        // Limpiar campos
        const nameInput = document.getElementById('new-lot-name');
        const descInput = document.getElementById('new-lot-description');
        const processSelect = document.getElementById('new-lot-process');
        
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        if (processSelect) processSelect.selectedIndex = 0;
    }
    
    function showLoteChooser() {
        const modal = document.getElementById('lote-chooser-modal');
        if (!modal) return;
        
        // Poblar select con lotes disponibles
        const select = document.getElementById('lote-chooser-select');
        if (select) {
            const localData = getLocalData();
            select.innerHTML = '';
            
            Object.keys(localData).forEach(key => {
                if (key === 'lotes') return; // Excluir pool general
                if (!isValidLotId(key)) return;
                const lot = localData[key];
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = lot.name || key;
                select.appendChild(opt);
            });
        }
        
        modal.style.display = 'flex';
    }
    
    function hideLoteChooser() {
        const modal = document.getElementById('lote-chooser-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }
    
    // ============================================
    // EXPORT API
    // ============================================
    
    // Exponer globalmente
    global.createNewLot = createNewLot;
    global.promptDeleteSelectedLot = promptDeleteSelectedLot;
    global.deleteLot = deleteLot;
    global.updateDeleteButtonState = updateDeleteButtonState;
    // ⚠️ No sobreescribir si ya existe implementación legacy (la del HTML inline)
    if (typeof legacy.processAddSelectedToLotes !== 'function') {
        global.processAddSelectedToLotes = processAddSelectedToLotes;
    }
    global.generateNextLotName = generateNextLotName;
    global.showAddNewLotModal = showAddNewLotModal;
    global.hideAddNewLotModal = hideAddNewLotModal;
    if (typeof legacy.showLoteChooser !== 'function') {
        global.showLoteChooser = showLoteChooser;
    }
    if (typeof legacy.hideLoteChooser !== 'function') {
        global.hideLoteChooser = hideLoteChooser;
    }
    global.saveLotToDatabase = saveLotToDatabase;
    global.deleteLotFromDatabase = deleteLotFromDatabase;
    
    // También en window.App.features
    if (!global.App) global.App = {};
    if (!global.App.features) global.App.features = {};
    global.App.features.Lotes = {
        create: createNewLot,
        delete: deleteLot,
        promptDelete: promptDeleteSelectedLot,
        moveSelected: (typeof legacy.processAddSelectedToLotes === 'function') ? legacy.processAddSelectedToLotes : processAddSelectedToLotes,
        generateName: generateNextLotName,
        updateDeleteButton: updateDeleteButtonState,
        showAddModal: showAddNewLotModal,
        hideAddModal: hideAddNewLotModal,
        showChooser: (typeof legacy.showLoteChooser === 'function') ? legacy.showLoteChooser : showLoteChooser,
        hideChooser: (typeof legacy.hideLoteChooser === 'function') ? legacy.hideLoteChooser : hideLoteChooser
    };
    
    console.log('✅ [Lotes] Módulo de gestión de lotes inicializado');

    // Ejecutar limpieza una vez tras iniciar (cuando el legacy ya pudo poblar localData)
    try { setTimeout(purgeInvalidLotsInMemory, 0); } catch (e) { /* noop */ }
    
})(typeof window !== 'undefined' ? window : this);
