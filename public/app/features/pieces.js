// Pieces - Gestión de piezas (agregar, editar, eliminar)
// Extraído para modularización (2025-12-18)

(function(global) {
    'use strict';
    
    const getServerUrl = () => global.App?.config?.serverUrl || 'http://localhost:3000';
    
    // Obtener localData
    function getLocalData() {
        return global.Store ? global.Store.getLocalData() : global.localData;
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
    // REFRESCO DE VISTAS (Reportes/Gráficas)
    // ============================================

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
        // Si existe el helper legacy del HTML, úsalo (deja debounce y refresca todo).
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
    // VALIDACIÓN
    // ============================================
    
    function validatePieceInput(partNumber, quantity, incidents) {
        const errors = [];
        
        if (!partNumber || String(partNumber).trim() === '') {
            errors.push('⚠️ El número de parte es requerido');
        }
        
        if (quantity === undefined || quantity === null || isNaN(Number(quantity))) {
            errors.push('⚠️ La cantidad debe ser un número válido');
        } else if (Number(quantity) < 0) {
            errors.push('⚠️ La cantidad no puede ser negativa');
        }
        
        if (incidents !== undefined && incidents !== null && incidents !== '') {
            if (isNaN(Number(incidents))) {
                errors.push('⚠️ Las incidencias deben ser un número válido');
            } else if (Number(incidents) < 0) {
                errors.push('⚠️ Las incidencias no pueden ser negativas');
            }
        }
        
        return errors;
    }
    
    // ============================================
    // GUARDAR PIEZA EN BD
    // ============================================
    
    async function savePieceToDatabase(piece, lotKey) {
        try {
            if (!piece || !piece.uid) {
                console.warn('⚠️ savePieceToDatabase: pieza sin uid, no se puede guardar');
                return false;
            }

            const lotId = (piece.lot_id || lotKey || '').toString();
            if (!lotId) {
                console.warn('⚠️ savePieceToDatabase: falta lot_id/lotKey');
                return false;
            }

            const payload = {
                uid: String(piece.uid),
                lot_id: lotId,
                partNumber: piece.partNumber || '',
                quantity: (piece.quantity !== undefined ? piece.quantity : (piece.numPiezas !== undefined ? piece.numPiezas : (piece.piezas !== undefined ? piece.piezas : 0))),
                incidents: (piece.incidents !== undefined ? piece.incidents : 0),
                incidentType: piece.incidentType || '',
                timestamp: piece.timestamp || new Date().toISOString(),
                imagen: (piece.imagen !== undefined ? piece.imagen : null),
                sourceFile: piece.sourceFile || null,
                clientId: piece.clientId || null,
                messageId: piece.messageId || null,
                proceso: piece.proceso || '',
                metadata: (piece.metadata && typeof piece.metadata === 'object') ? piece.metadata : undefined
            };

            const response = await fetch(`${getServerUrl()}/api/pieces`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const txt = await response.text().catch(() => '');
                console.warn('⚠️ Error guardando pieza en BD:', response.status, response.statusText, txt);
                return false;
            }

            console.log('✅ Pieza guardada en BD:', payload.uid, '->', payload.lot_id);
            return true;
        } catch (err) {
            console.warn('⚠️ Error guardando pieza en BD:', err);
            return false;
        }
    }
    
    // ============================================
    // ELIMINAR PIEZA
    // ============================================
    
    function removePieceByUid(lotKey, uid) {
        try {
            const localData = getLocalData();
            const idx = (localData[lotKey]?.pieces || []).findIndex(p => p.uid === uid);
            
            if (idx === -1) {
                if (typeof handleError === 'function') {
                    handleError('removePieceByUid', 'Pieza no encontrada', 'No se pudo encontrar la pieza a eliminar');
                }
                return;
            }
            
            const piece = localData[lotKey].pieces[idx];
            
            // Mostrar modal de confirmación
            if (typeof showConfirmationModal === 'function') {
                showConfirmationModal({
                    title: '⚠️ Eliminar Pieza',
                    message: '¿Deseas eliminar esta pieza? Esta acción no se puede deshacer.',
                    details: [
                        { label: 'Parte', value: piece.partNumber },
                        { label: 'Cantidad', value: piece.quantity },
                        { label: 'Lote', value: lotKey }
                    ],
                    dangerMode: true,
                    confirmText: 'Eliminar',
                    cancelText: 'Cancelar',
                    onConfirm: async () => {
                        await executeRemovePiece(lotKey, idx, piece);
                    }
                });
            } else {
                // Fallback con confirm simple
                const confirmMsg = `¿Eliminar pieza ${piece.partNumber}?`;
                if (confirm(confirmMsg)) {
                    executeRemovePiece(lotKey, idx, piece);
                }
            }
        } catch (e) {
            console.error('removePieceByUid error', e);
        }
    }
    
    async function executeRemovePiece(lotKey, idx, piece) {
        try {
            const localData = getLocalData();
            
            // 1. PRIMERO: Eliminar de la base de datos del servidor PERMANENTEMENTE
            let serverDeleteOk = false;
            try {
                if (piece.uid) {
                    const deleteResp = await fetch(`${getServerUrl()}/api/pieces/${encodeURIComponent(piece.uid)}`, {
                        method: 'DELETE'
                    });
                    const deleteResult = await deleteResp.json();
                    console.debug('DELETE /api/pieces response:', deleteResult);
                    
                    if (deleteResult.deleted > 0) {
                        console.log(`✅ Pieza ${piece.uid} eliminada de la BD`);
                        serverDeleteOk = true;
                    } else {
                        console.warn('⚠️ La pieza no se encontró en la BD, intentando engrave/delete...');
                        // Fallback: intentar con engrave/delete
                        const payload = { filename: piece.uid };
                        if (piece.messageId) payload.messageId = piece.messageId;
                        if (piece.sourceFile) payload.filename = String(piece.sourceFile).split('\\').pop().split('/').pop();
                        
                        const fallbackResp = await fetch(`${getServerUrl()}/engrave/delete`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const fallbackResult = await fallbackResp.json();
                        serverDeleteOk = fallbackResult.ok;
                    }
                }
            } catch (e) {
                console.warn('Error eliminando del servidor:', e);
            }
            
            // 2. Guardar en historial ANTES de eliminar
            if (typeof saveToHistory === 'function') {
                saveToHistory('delete', `Eliminó pieza: ${piece.partNumber} (Cant: ${piece.quantity})`);
            }
            
            // 3. Eliminar de localData
            localData[lotKey].pieces.splice(idx, 1);
            
            // 4. Recalcular métricas
            if (typeof recalculateMetricsForLot === 'function') {
                recalculateMetricsForLot(lotKey);
            }
            
            // 5. Sync
            markDirty('piece.delete');
            
            // 6. Mostrar notificación
            if (typeof showNotification === 'function') {
                showNotification(`✅ Pieza eliminada${serverDeleteOk ? ' permanentemente' : ''}`, 'success');
            }
            
            // 7. AHORA actualizar UI (después de eliminar del servidor)
            if (typeof loadLotRegistration === 'function') {
                loadLotRegistration(lotKey);
            }
            if (typeof loadDashboardData === 'function') {
                loadDashboardData();
            }
            if (typeof updateSyncStatus === 'function') {
                updateSyncStatus();
            }

            // Si el usuario está viendo reportes, refrescar métricas/gráficas.
            refreshReportsIfActive();
        } catch (e) {
            console.error('executeRemovePiece error', e);
        }
    }
    
    // ============================================
    // RECALCULAR MÉTRICAS
    // ============================================
    
    function recalculateMetricsForLot(lotKey) {
        const localData = getLocalData();
        if (!localData[lotKey]) return;
        
        const lot = localData[lotKey];
        const totalQuantity = (lot.pieces || []).reduce((sum, piece) => {
            return sum + (Number(piece.quantity || piece.numPiezas || 0) || 0);
        }, 0);
        
        if (lotKey.startsWith('laser-')) {
            if (!lot.laserMetrics) lot.laserMetrics = {};
            if (totalQuantity === 0) {
                delete lot.laserMetrics.piezas_grabadas;
            } else {
                lot.laserMetrics.piezas_grabadas = totalQuantity;
            }
            console.debug(`Recalculated metrics for ${lotKey}: piezas_grabadas = ${totalQuantity}`);
        } else if (lotKey.startsWith('pavonado-')) {
            if (!lot.pavonadoMetrics) lot.pavonadoMetrics = {};
            if (totalQuantity === 0) {
                delete lot.pavonadoMetrics.piezas_pavonadas;
            } else {
                lot.pavonadoMetrics.piezas_pavonadas = totalQuantity;
            }
            console.debug(`Recalculated metrics for ${lotKey}: piezas_pavonadas = ${totalQuantity}`);
        }
    }
    
    // ============================================
    // EDITAR PIEZA - MODAL
    // ============================================
    
    function openEditPieceModal(lotKey, uid) {
        try {
            const localData = getLocalData();
            const lot = localData[lotKey];
            if (!lot) return alert('Lote no encontrado');
            
            const piece = (lot.pieces || []).find(p => p.uid === uid);
            if (!piece) return alert('Pieza no encontrada');

            const elLot = document.getElementById('edit-lot-key');
            const elUid = document.getElementById('edit-uid');
            const elPart = document.getElementById('edit-part-number');
            const elQty = document.getElementById('edit-quantity');
            const elInc = document.getElementById('edit-incidents');
            const preview = document.getElementById('edit-image-preview');
            const fileInput = document.getElementById('edit-image');

            if (elLot) elLot.value = lotKey;
            if (elUid) elUid.value = uid;
            if (elPart) elPart.value = piece.partNumber || '';
            if (elQty) elQty.value = piece.quantity || 0;
            if (elInc) elInc.value = piece.incidents || 0;

            if (preview) {
                if (piece.imagen) {
                    let src = piece.imagen;
                    if (typeof src === 'string' && !src.startsWith('data:')) {
                        src = getServerUrl() + '/engrave/' + encodeURIComponent(src);
                    }
                    preview.src = src;
                    preview.style.display = 'block';
                } else {
                    preview.src = '';
                    preview.style.display = 'none';
                }
            }
            if (fileInput) fileInput.value = '';

            const modal = document.getElementById('edit-piece-modal');
            if (modal) modal.style.display = 'flex';
        } catch (e) {
            console.error('openEditPieceModal error', e);
            alert('Error abriendo editor');
        }
    }

    function closeEditPieceModal() {
        try {
            const modal = document.getElementById('edit-piece-modal');
            if (modal) modal.style.display = 'none';
            
            const preview = document.getElementById('edit-image-preview');
            if (preview) {
                preview.src = '';
                preview.style.display = 'none';
            }
            
            const fileInput = document.getElementById('edit-image');
            if (fileInput) fileInput.value = '';
        } catch (e) { /* noop */ }
    }

    function saveEditedPiece() {
        try {
            const localData = getLocalData();
            const lotKey = document.getElementById('edit-lot-key')?.value;
            const uid = document.getElementById('edit-uid')?.value;
            const partNumber = document.getElementById('edit-part-number')?.value;
            const quantity = parseInt(document.getElementById('edit-quantity')?.value) || 0;
            const incidents = parseInt(document.getElementById('edit-incidents')?.value) || 0;
            const incidentType = document.getElementById('edit-incident-type')?.value || '';
            const fileInput = document.getElementById('edit-image');

            // Validar entrada
            const errors = validatePieceInput(partNumber, quantity, incidents);
            if (errors.length > 0) {
                errors.forEach(error => {
                    if (typeof showNotification === 'function') {
                        showNotification(error, 'error', 3000);
                    }
                });
                return;
            }

            if (!localData[lotKey]) {
                if (typeof showNotification === 'function') {
                    showNotification('❌ Lote no encontrado', 'error');
                }
                return;
            }
            
            const idx = (localData[lotKey].pieces || []).findIndex(p => p.uid === uid);
            if (idx === -1) {
                if (typeof showNotification === 'function') {
                    showNotification('❌ Pieza no encontrada', 'error');
                }
                return;
            }

            const finalize = async (imageData) => {
                const piece = localData[lotKey].pieces[idx];
                piece.partNumber = partNumber;
                piece.quantity = quantity;
                piece.incidents = incidents;
                piece.incidentType = incidentType;
                if (imageData !== null) piece.imagen = imageData;

                // Recalcular métricas del lote (piezas grabadas/pavonadas)
                try {
                    if (typeof recalculateMetricsForLot === 'function') {
                        recalculateMetricsForLot(lotKey);
                    }
                } catch (e) { /* noop */ }
                
                try {
                    await savePieceToDatabase(piece, lotKey);
                } catch (e) {
                    console.warn('Error guardando pieza editada en BD', e);
                }
                
                markDirty('piece.edit');
                
                if (typeof loadLotRegistration === 'function') loadLotRegistration(lotKey);
                if (typeof loadDashboardData === 'function') loadDashboardData();
                if (typeof updateSyncStatus === 'function') updateSyncStatus();

                // Si el usuario está viendo reportes, refrescar métricas/gráficas.
                refreshReportsIfActive();
                
                closeEditPieceModal();
                
                if (typeof showNotification === 'function') {
                    showNotification('✅ Pieza actualizada correctamente', 'success');
                }
            };

            if (fileInput && fileInput.files && fileInput.files.length > 0) {
                const file = fileInput.files[0];
                const fr = new FileReader();
                fr.onload = () => { finalize(fr.result).catch(e => console.warn('Error finalizando edición', e)); };
                fr.onerror = () => { console.warn('No se pudo leer la imagen'); finalize(null).catch(e => console.warn('Error finalizando edición', e)); };
                fr.readAsDataURL(file);
            } else {
                finalize(null).catch(e => console.warn('Error finalizando edición', e));
            }
        } catch (e) {
            console.error('saveEditedPiece error', e);
            if (typeof showNotification === 'function') {
                showNotification('❌ Error guardando la pieza', 'error');
            }
        }
    }
    
    // ============================================
    // PAGINACIÓN
    // ============================================
    
    function changePageLotes(page) {
        if (global.Store) {
            global.Store.setCurrentPageLotes(page);
        } else {
            global.currentPageLotes = page;
        }
        
        if (typeof renderLotes === 'function') {
            renderLotes();
        }
    }
    
    // ============================================
    // EXPORT API
    // ============================================
    
    // Exponer globalmente
    global.validatePieceInput = validatePieceInput;
    global.savePieceToDatabase = savePieceToDatabase;
    global.removePieceByUid = removePieceByUid;
    global.recalculateMetricsForLot = recalculateMetricsForLot;
    global.openEditPieceModal = openEditPieceModal;
    global.closeEditPieceModal = closeEditPieceModal;
    global.saveEditedPiece = saveEditedPiece;
    global.changePageLotes = changePageLotes;
    
    // También en window.App.features
    if (!global.App) global.App = {};
    if (!global.App.features) global.App.features = {};
    global.App.features.Pieces = {
        validate: validatePieceInput,
        save: savePieceToDatabase,
        remove: removePieceByUid,
        recalculateMetrics: recalculateMetricsForLot,
        openEditModal: openEditPieceModal,
        closeEditModal: closeEditPieceModal,
        saveEdited: saveEditedPiece,
        changePage: changePageLotes
    };
    
    console.log('✅ [Pieces] Módulo de gestión de piezas inicializado');
    
})(typeof window !== 'undefined' ? window : this);
