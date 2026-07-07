// Feature: Registro (alta de piezas)
// Extraído del script embebido de sistema_de_grabado_laserv1 (2025-12-18)

function setupAddPieceModal() {
    const modal = document.getElementById('add-piece-modal');
    const addBtn = document.getElementById('add-piece');
    const closeBtn = document.querySelector('.close');
    const cancelBtn = document.getElementById('cancel-add');
    const form = document.getElementById('add-piece-form');

    if (!modal || !addBtn || !form) return;

    addBtn.addEventListener('click', function () {
        modal.style.display = 'flex';
    });

    if (closeBtn) {
        closeBtn.addEventListener('click', function () {
            modal.style.display = 'none';
        });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', function () {
            modal.style.display = 'none';
        });
    }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        addNewPiece();
        modal.style.display = 'none';
        form.reset();
    });

    // Cerrar modal al hacer clic fuera
    window.addEventListener('click', function (e) {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
}

async function addNewPiece() {
    const partNumber = document.getElementById('new-part-number').value;
    const quantity = parseInt(document.getElementById('new-quantity').value);
    const incidents = parseInt(document.getElementById('new-incidents').value) || 0;
    const incidentType = document.getElementById('new-incident-type').value || '';
    const proceso = document.getElementById('new-proceso').value;
    const fileInput = document.getElementById('new-image');

    console.log('🆕 addNewPiece called:', { partNumber, quantity, incidents, proceso });

    // Validar entrada de pieza
    const errors = validatePieceInput(partNumber, quantity, incidents);
    if (errors.length > 0) {
        console.warn('❌ Validación fallida:', errors);
        errors.forEach(error => showNotification(error, 'error', 3000));
        return;
    }

    // Leer imagen si existe
    let imagenData = null;
    try {
        if (fileInput && fileInput.files && fileInput.files.length > 0) {
            const file = fileInput.files[0];
            imagenData = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = reject;
                fr.readAsDataURL(file);
            });
        }
    } catch (err) {
        console.warn('No se pudo leer la imagen localmente:', err);
        imagenData = null;
    }

    // Generar clientId para correlacionar petición <-> SSE y evitar duplicados
    const clientId = 'c_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    console.log('📤 Enviando a /enqueue con clientId:', clientId);

    // Intentar enviar directamente al sistema de grabado (servidor)
    try {
        const resp = await fetch(`${SERVER_URL}/enqueue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ numParte: partNumber, numPiezas: quantity, imagen: imagenData, clientId, proceso })
        });

        if (resp.ok) {
            const data = await resp.json();
            console.log('✅ /enqueue respondió OK:', data);
            // No agregamos la pieza local inmediatamente: esperamos el SSE del servidor
            // para evitar duplicados. Si el SSE no llega en X ms, agregamos localmente.

            try {
                if (pendingAdds && pendingAdds[clientId]) clearTimeout(pendingAdds[clientId]);
            } catch (e) { /* noop */ }

            console.debug('ENQUEUE -> enviado clientId:', clientId);
            if (pendingAdds) {
                pendingAdds[clientId] = setTimeout(() => {
                    try {
                        console.warn('⏱️ SSE timeout de 5s para clientId:', clientId, '- agregando fallback local');
                        // Si el SSE no llegó en 5s, agregar localmente como fallback al lote GLOBAL
                        // Antes de agregar, comprobar en TODOS los lotes si ya existe una pieza equivalente
                        const uid = clientId || ('u_' + Date.now() + '_' + Math.floor(Math.random() * 100000));
                        const pieceObj = { partNumber, quantity, incidents, incidentType, timestamp: new Date().toLocaleString('es-ES'), imagen: imagenData, clientId, uid, proceso: '' };

                        // función helper para comparar part+imagen
                        const partImgKey = (pn, img) => (pn ? String(pn) : '') + '||' + (img ? String(img) : '');
                        const targetKey = partImgKey(partNumber, imagenData);

                        let found = false;
                        Object.keys(localData).forEach(lk => {
                            if (found) return;
                            const arr = (localData[lk].pieces || []);
                            for (let i = 0; i < arr.length; i++) {
                                const p = arr[i];
                                if (!p) continue;
                                const pKey = partImgKey(p.partNumber, p.imagen);
                                if ((p.clientId && p.clientId === clientId) || (p.uid && p.uid === uid) || (p.messageId && p.messageId === clientId) || pKey === targetKey || (p.sourceFile && pieceObj.imagen && p.sourceFile === pieceObj.imagen)) {
                                    found = true;
                                    break;
                                }
                            }
                        });

                        if (!found) {
                            // SIEMPRE guardar en el lote global 'lotes'
                            if (!localData['lotes']) localData['lotes'] = { name: 'LOTES', pieces: [] };
                            localData['lotes'].pieces.unshift(pieceObj);

                            // Guardar en historial
                            saveToHistory('add', `Agregó pieza: ${partNumber} (Cant: ${quantity})`);

                            try {
                                if (window.App && window.App.persist && window.App.persist.markDirty) {
                                    window.App.persist.markDirty('registro.fallbackAdd');
                                }
                            } catch (e) { /* noop */ }
                            console.log('💾 Pieza agregada al lote global (fallback):', pieceObj);
                            loadLotRegistration('lotes');
                            loadDashboardData();
                            updateSyncStatus();
                            console.debug('Fallback: se añadió al lote global tras timeout porque no llegó SSE', clientId);
                        } else {
                            console.debug('Fallback: no se añadió porque ya existe en localData (coincidencia encontrada) para', clientId);
                        }
                    } catch (e) {
                        console.warn('Error en fallback add local tras enqueue:', e);
                    }
                    try { delete pendingAdds[clientId]; } catch (e) { }
                }, 5000);
            }

            // Ya devolvimos; el SSE debería añadir la pieza. Actualizar estados UI.
            loadDashboardData();
            updateSyncStatus();
            showNotification('✅ Pieza registrada - esperando sincronización', 'success');

            // Limpiar formulario
            document.getElementById('new-part-number').value = '';
            document.getElementById('new-quantity').value = '';
            document.getElementById('new-incidents').value = '0';
            document.getElementById('new-incident-type').value = '';
            document.getElementById('new-image').value = '';
            return;
        } else {
            throw new Error('Server responded with error');
        }
    } catch (err) {
        console.warn('Servidor inaccesible o error, guardando localmente para sincronizar más tarde', err);
        // Fallback inmediato: guardar en el lote GLOBAL para sincronizar después
        const pieceObj = { partNumber, quantity, incidents, incidentType, timestamp: new Date().toLocaleString('es-ES'), imagen: imagenData, uid: ('u_' + Date.now() + '_' + Math.floor(Math.random() * 100000)), proceso: '' };
        if (!localData['lotes']) localData['lotes'] = { name: 'LOTES', pieces: [] };
        localData['lotes'].pieces.push(pieceObj);

        // Guardar en historial
        saveToHistory('add', `Agregó pieza: ${partNumber} (Cant: ${quantity}) [Offline]`);

        pendingSync.push({ action: 'create', partNumber: partNumber, quantity: quantity, incidents: incidents, lot: 'lotes', timestamp: new Date().toLocaleString('es-ES'), imagen: imagenData });
        // No persistir en localStorage (requisito). pendingSync queda solo en memoria.
        try {
            if (window.App && window.App.persist && window.App.persist.markDirty) {
                window.App.persist.markDirty('registro.offlineAdd');
            }
        } catch (e) { /* noop */ }
        console.log('💾 Pieza guardada localmente (servidor offline):', pieceObj);
        loadLotRegistration('lotes');
        loadDashboardData();
        updateSyncStatus();
        showNotification('⚠️ Servidor no disponible - pieza guardada localmente', 'warning');
    }
}
