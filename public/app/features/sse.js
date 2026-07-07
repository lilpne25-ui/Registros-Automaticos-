// SSE (Server-Sent Events) - Recepción de registros en tiempo real
// Extraído para modularización (2025-12-18)

(function(global) {
    'use strict';
    
    const getServerUrl = () => global.App?.config?.serverUrl || 'http://localhost:3000';
    
    // Normalizar ID (string, número, o null)
    function normalizeId(v) {
        if (v === null || v === undefined) return null;
        if (typeof v === 'boolean') return null;
        if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
        if (typeof v !== 'string') return null;
        const s = v.trim();
        if (s === '' || s === 'false' || s === 'null' || s === 'undefined') return null;
        return s;
    }

    // Obtener basename de una ruta (Windows o POSIX)
    function basename(p) {
        if (!p) return '';
        const str = String(p);
        const parts = str.split(/[\\/]/);
        return parts[parts.length - 1] || '';
    }

    // Este módulo está DESHABILITADO porque el SSE se maneja en sistema_de_grabado_laserv1.html
    // para evitar múltiples conexiones que congelan el sistema
    function setupSSE() {
        console.warn('⚠️ setupSSE en sse.js está DESHABILITADO - usar el del HTML principal');
        return null;
    }
    
    // Manejar un nuevo registro entrante
    function handleIncomingRegistro(reg) {
        try {
            // Obtener localData del store o variable global
            const localData = global.Store ? global.Store.getLocalData() : global.localData;
            const pendingAdds = global.Store ? global.Store.getPendingAdds() : (global.pendingAdds || {});
            
            // SIEMPRE guardar en el lote global 'lotes'
            const lotKey = 'lotes';
            if (!localData[lotKey]) {
                localData[lotKey] = { name: lotKey, pieces: [] };
            }

            const numParte = reg.numeroParte || reg.numParte || '';
            const piezas = Number(reg.piezas || reg.numPiezas || 0);
            const timestamp = reg.timestamp || reg.fecha || new Date().toLocaleString('es-ES');

            // Normalizar ids y cancelar pendingAdds si existe
            try {
                reg.clientId = normalizeId(reg.clientId);
                reg.messageId = normalizeId(reg.messageId);
                
                if (reg.clientId) console.debug('SSE -> recibido clientId:', reg.clientId);
                
                if (reg.clientId && pendingAdds[reg.clientId]) {
                    console.debug('SSE -> cancelando pendingAdd para', reg.clientId);
                    if (global.Store) {
                        global.Store.clearPendingAdd(reg.clientId);
                    } else {
                        clearTimeout(pendingAdds[reg.clientId]);
                        delete pendingAdds[reg.clientId];
                    }
                }
                if (reg.messageId && pendingAdds[reg.messageId]) {
                    console.debug('SSE -> cancelando pendingAdd para messageId', reg.messageId);
                    if (global.Store) {
                        global.Store.clearPendingAdd(reg.messageId);
                    } else {
                        clearTimeout(pendingAdds[reg.messageId]);
                        delete pendingAdds[reg.messageId];
                    }
                }
            } catch (e) { /* noop */ }

            // Buscar pieza existente que coincida
            function findExistingMatch() {
                try {
                    const rBase = basename(reg.rutaEngrave || reg.ruta);
                    const partImgKey = (reg.numeroParte || reg.numParte || '') + '||' + (reg.imagen || reg.imagenPath || '');
                    
                    for (const lk of Object.keys(localData)) {
                        const arr = localData[lk].pieces || [];
                        for (let i = 0; i < arr.length; i++) {
                            const p = arr[i];
                            if (!p) continue;
                            
                            // Match por messageId
                            if (reg.messageId && (p.uid === reg.messageId || p.messageId === reg.messageId)) {
                                return { lot: lk, index: i, piece: p };
                            }
                            // Match por clientId
                            if (reg.clientId && p.clientId && p.clientId === reg.clientId) {
                                return { lot: lk, index: i, piece: p };
                            }
                            // Match por sourceFile basename
                            try {
                                const pBase = basename(p.sourceFile);
                                if (rBase && pBase && rBase === pBase) {
                                    return { lot: lk, index: i, piece: p };
                                }
                            } catch (e) {}
                            // Fallback: part+imagen
                            const pPartImg = (p.partNumber || '') + '||' + (p.imagen || '');
                            if (pPartImg && partImgKey && pPartImg === partImgKey) {
                                return { lot: lk, index: i, piece: p };
                            }
                        }
                    }
                } catch (e) {
                    console.warn('findExistingMatch error', e);
                }
                return null;
            }

            const existing = findExistingMatch();
            if (existing) {
                // Reconciliar pieza existente
                try {
                    const p = existing.piece;
                    if (reg.messageId) {
                        p.messageId = reg.messageId;
                        p.uid = reg.messageId;
                    }
                    if (reg.clientId) p.clientId = p.clientId || reg.clientId;
                    p.partNumber = p.partNumber || (reg.numeroParte || reg.numParte || '');
                    p.quantity = p.quantity || Number(reg.piezas || reg.numPiezas || 0);
                    p.timestamp = p.timestamp || timestamp;

                    // Mover si estaba en otro lote
                    if (existing.lot !== lotKey) {
                        try { localData[existing.lot].pieces.splice(existing.index, 1); } catch (e) {}
                        if (!localData[lotKey]) localData[lotKey] = { name: lotKey, pieces: [] };
                        localData[lotKey].pieces.unshift(p);
                    }

                    // Sync y refrescar UI
                    if (global.markLocalDataDirty) global.markLocalDataDirty('SSE.reconcile');
                    if (typeof loadLotRegistration === 'function') loadLotRegistration(lotKey);
                    
                    console.debug('SSE: reconciliado registro con elemento local existente');
                    return;
                } catch (e) {
                    console.warn('Error reconciling existing piece', e);
                }
            }

            // Crear nueva pieza
            const pieceObj = {
                partNumber: numParte,
                quantity: piezas,
                incidents: 0,
                timestamp,
                imagen: reg.imagen || reg.imagenPath || null,
                sourceFile: reg.rutaEngrave || reg.ruta || null,
                clientId: reg.clientId || null,
                uid: reg.messageId || reg.clientId || ('u_' + Date.now() + '_' + Math.floor(Math.random()*100000)),
                messageId: reg.messageId || null,
                proceso: ''
            };

            // Agregar al inicio del lote
            localData[lotKey].pieces.unshift(pieceObj);
            if (global.markLocalDataDirty) global.markLocalDataDirty('SSE.insert');

            // Limpiar duplicados residuales
            try {
                const newMatchKey = {
                    uid: pieceObj.uid || null,
                    messageId: reg.messageId || null,
                    clientId: reg.clientId || null,
                    sourceBase: basename(pieceObj.sourceFile),
                    partImg: (pieceObj.partNumber || '') + '||' + (pieceObj.imagen || '')
                };

                Object.keys(localData).forEach(otherLotKey => {
                    if (!Array.isArray(localData[otherLotKey].pieces)) return;
                    for (let j = localData[otherLotKey].pieces.length - 1; j >= 0; j--) {
                        const p = localData[otherLotKey].pieces[j];
                        if (!p) continue;
                        if (otherLotKey === lotKey && j === 0) continue;

                        const pPartImg = (p.partNumber || '') + '||' + (p.imagen || '');
                        const pBase = basename(p.sourceFile);

                        // IMPORTANTE: solo deduplicar por uid exacto.
                        // No deduplicar globalmente por messageId/clientId/sourceFile/part+img porque esos criterios
                        // son compartidos por COPIAS válidas (por ejemplo pieza en lote Láser y Pavonado).
                        if (newMatchKey.uid && p.uid === newMatchKey.uid) {
                            localData[otherLotKey].pieces.splice(j, 1);
                            console.debug('Removed residual duplicate after SSE');
                        }
                    }
                });
                if (global.markLocalDataDirty) global.markLocalDataDirty('SSE.cleanup');
            } catch(e) {
                console.warn('Error during post-SSE duplicate cleanup', e);
            }

            // Refrescar UI
            try {
                console.debug(`handleIncomingRegistro: refrescando UI para lote '${lotKey}'`);
                if (typeof loadLotRegistration === 'function') loadLotRegistration(lotKey);
            } catch (e) {
                console.warn('Error refrescando UI del lote:', e);
            }
            
            try {
                if (typeof loadDashboardData === 'function') loadDashboardData();
            } catch (e) {
                console.warn('Error actualizando dashboard:', e);
            }

            // Agregar a lista de recientes en UI
            updateRecentRegistrations(pieceObj, numParte, timestamp, piezas);

        } catch (err) {
            console.error('Error manejando registro entrante:', err);
        }
    }
    
    // Actualizar lista de registros recientes en la UI
    function updateRecentRegistrations(pieceObj, numParte, timestamp, piezas) {
        const recentList = document.querySelector('.recent-registrations');
        if (!recentList) return;
        
        const item = document.createElement('div');
        item.className = 'registration-item';
        
        let inner = `
            <div style="flex:1">
                <strong>${numParte}</strong>
                <div style="font-size:0.9rem;color:#666">${timestamp}</div>
            </div>
            <div style="width:70px;text-align:center">${piezas} pz</div>
        `;
        
        if (pieceObj && pieceObj.imagen) {
            let imgSrc = pieceObj.imagen;
            try {
                if (typeof imgSrc === 'string' && !imgSrc.startsWith('data:')) {
                    imgSrc = `${getServerUrl()}/engrave/${encodeURIComponent(imgSrc)}`;
                }
            } catch (e) {
                imgSrc = pieceObj.imagen;
            }

            const safeRecentSrc = String(imgSrc).replace(/'/g, "\\'");
            inner += `
                <div style="margin-left:10px">
                    <img src="${imgSrc}" alt="img" 
                         style="max-width:160px;max-height:120px;border-radius:4px;object-fit:cover;cursor:zoom-in" 
                         onerror="setImgFallback(this)" 
                         ondblclick="openImageModal('${safeRecentSrc}')"/>
                </div>
            `;
        }
        
        item.innerHTML = inner;
        recentList.prepend(item);
    }
    
    // Exponer globalmente
    global.setupSSE = setupSSE;
    global.handleIncomingRegistro = handleIncomingRegistro;
    
    // También en window.App.features
    if (!global.App) global.App = {};
    if (!global.App.features) global.App.features = {};
    global.App.features.SSE = {
        setup: setupSSE,
        handleIncoming: handleIncomingRegistro,
        normalizeId,
        basename
    };
    
    console.log('✅ [SSE] Módulo de eventos en tiempo real inicializado');
    
})(typeof window !== 'undefined' ? window : this);
