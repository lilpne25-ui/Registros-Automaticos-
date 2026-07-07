// Servicios de servidor (status/QR/sync/SSE helpers)
// Extraído del script embebido de sistema_de_grabado_laserv1 (2025-12-18)

// Verificar conexión con el servidor
async function checkServerConnection() {
    try {
        const response = await fetch(`${SERVER_URL}/status`);
        if (response.status === 401) {
            try { window.location.href = '/login'; } catch (e) { /* noop */ }
            return false;
        }
        if (response.ok) {
            const data = await response.json();
            serverConnected = true;
            whatsappConnected = data.authenticated;

            updateConnectionStatus();
            return true;
        }
    } catch (error) {
        serverConnected = false;
        whatsappConnected = false;
        updateConnectionStatus();
    }
    return false;
}

// Actualizar indicador de estado
function updateConnectionStatus() {
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('server-status');

    if (indicator) {
        indicator.className = serverConnected ? 'status-indicator connected' : 'status-indicator';
    } else {
        // Elemento no está en DOM, evitar excepción
        console.warn('updateConnectionStatus: #status-indicator no encontrado en el DOM');
    }

    if (statusText) {
        statusText.textContent = serverConnected ? 'Conectado al servidor' : 'Servidor no disponible - Modo local';
    } else {
        console.warn('updateConnectionStatus: #server-status no encontrado en el DOM');
    }

    // Actualizar estado de WhatsApp con comprobaciones de existencia
    const whatsappStatus = document.getElementById('whatsapp-status');
    const qrContainer = document.getElementById('qr-container');
    if (whatsappStatus) {
        if (whatsappConnected) {
            whatsappStatus.textContent = 'Conectado';
            if (qrContainer) qrContainer.style.display = 'none';
        } else {
            whatsappStatus.textContent = 'Desconectado - Escanear QR';
            if (qrContainer) qrContainer.style.display = 'block';
        }
    } else {
        if (qrContainer) {
            // Si no tenemos el texto de estado, solo ocultar/mostrar el contenedor según convenga
            qrContainer.style.display = whatsappConnected ? 'none' : 'block';
        }
        console.warn('updateConnectionStatus: #whatsapp-status no encontrado en el DOM');
    }

    // Notificar que la gestión de usuarios fue removida
    try {
        const usersList = document.getElementById('users-list');
        if (usersList) {
            usersList.innerHTML = '<div>No hay gestión de usuarios. El bot aceptará mensajes de cualquiera.</div>';
        }
    } catch (e) { /* noop */ }
}

// Cargar información del servidor
async function loadServerInfo() {
    try {
        const response = await fetch(`${SERVER_URL}/info-excel`);
        if (response.ok) {
            const data = await response.json();

            const infoText = `Archivo: ${data.archivo} | Registros: ${data.registros} | ${data.existe ? 'Archivo encontrado' : 'Archivo no encontrado'}`;
            const el = document.getElementById('server-info');
            if (el) el.innerHTML = `<strong>Información del Servidor:</strong> ${infoText}`;
        }
    } catch (error) {
        const el = document.getElementById('server-info');
        if (el) el.innerHTML = '<strong>Información del Servidor:</strong> No disponible - Modo local activado';
    }
}

// Cargar estado de WhatsApp
async function loadWhatsAppStatus() {
    try {
        const response = await fetch(`${SERVER_URL}/qr`);
        if (response.status === 401) {
            try { window.location.href = '/login'; } catch (e) { /* noop */ }
            return;
        }
        if (response.ok) {
            const data = await response.json();
            const qrContainer = document.getElementById('qr-container');
            if (!qrContainer) return;

            // Asegurar que exista el elemento de imagen
            let qrImg = document.getElementById('qr-code');
            if (!qrImg) {
                qrImg = document.createElement('img');
                qrImg.id = 'qr-code';
                qrImg.className = 'qr-code';
                qrContainer.appendChild(qrImg);
            }

            // Área de depuración/estado para el QR
            let qrDebug = document.getElementById('qr-debug');
            if (!qrDebug) {
                qrDebug = document.createElement('div');
                qrDebug.id = 'qr-debug';
                qrDebug.style.marginTop = '8px';
                qrDebug.style.fontSize = '12px';
                qrDebug.style.color = '#666';
                qrContainer.appendChild(qrDebug);
            }

            if (data.qr) {
                qrImg.src = data.qr;
                qrImg.style.display = 'block';
                qrImg.alt = 'QR de conexión WhatsApp';
                qrContainer.style.display = 'block';
                try { qrContainer.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
                qrDebug.textContent = 'QR cargado desde servidor.';
            } else {
                qrImg.src = '';
                qrImg.style.display = 'none';
                if (data.authenticated) {
                    qrDebug.textContent = 'WhatsApp ya esta conectado; no se necesita QR.';
                } else if (data.lastError) {
                    qrDebug.textContent = `Sin QR todavia. Ultimo error: ${String(data.lastError).slice(0, 180)}`;
                } else if (data.initInProgress) {
                    qrDebug.textContent = 'Inicializando WhatsApp. Espera unos segundos...';
                } else {
                    qrDebug.textContent = 'Aun no hay QR disponible. Usa Reiniciar WhatsApp y espera unos segundos.';
                }
            }
        }
    } catch (error) {
        console.error('Error cargando estado de WhatsApp:', error);
    }
}

// Cargar registros recientes
async function loadRecentRegistrations() {
    try {
        const response = await fetch(`${SERVER_URL}/status`);
        if (response.status === 401) {
            try { window.location.href = '/login'; } catch (e) { /* noop */ }
            return;
        }
        if (response.ok) {
            const data = await response.json();
            const registrations = data.registros || [];

            const container = document.getElementById('recent-registrations');
            if (!container) return;
            container.innerHTML = '';

            if (registrations.length === 0) {
                container.innerHTML = '<div class="registration-item">No hay registros recientes</div>';
                return;
            }

            registrations.forEach(reg => {
                const item = document.createElement('div');
                item.className = 'registration-item';
                item.innerHTML = `
                    <span><strong>${reg.numeroParte}</strong> - ${reg.piezas} piezas</span>
                    <span>${reg.timestamp}</span>
                `;
                container.appendChild(item);
            });
        }
    } catch (error) {
        const container = document.getElementById('recent-registrations');
        if (container) {
            container.innerHTML = '<div class="registration-item">No se pudieron cargar registros del servidor</div>';
        }
    }
}

// Importar registros existentes en el servidor (to_engrave) y reconciliar con localData
// ✅ Estado global para paginación (evita redeclaración cuando aún existe código legacy en el HTML)
const engraveListState = (window.__engraveListState = window.__engraveListState || {
    page: 0,
    total: 0,
    hasMore: false
});

async function importEngraveList(pageNum = 0) {
    try {
        console.log(`📥 Importando engrave-list página ${pageNum}...`);
        const respList = await fetch(`${SERVER_URL}/engrave-list?page=${pageNum}&pageSize=500`, { timeout: 30000 });
        if (!respList || !respList.ok) {
            console.warn('⚠️ No se pudo obtener engrave-list del servidor:', respList?.status);
            return;
        }

        const response = await respList.json();
        const list = response.data || [];
        const pagination = response.pagination || {};

        engraveListState.page = pagination.page || 0;
        engraveListState.total = pagination.totalRegistros || 0;
        engraveListState.hasMore = pagination.hasMore || false;

        console.log(`📋 Página ${pageNum + 1}/${pagination.totalPages}, Total: ${engraveListState.total} registros`);

        // list: [{ filename, content }, ...]
        if (Array.isArray(list) && list.length > 0) {
            let added = 0;
            let skipped = 0;

            for (const item of list) {
                try {
                    const reg = item.content || {};
                    // Normalizar los campos esperados del servidor
                    const registro = {
                        numeroParte: reg.numParte || reg.numeroParte || reg.partNumber || null,
                        piezas: reg.numPiezas || reg.piezas || null,
                        rutaEngrave: item.filename || reg.ruta || reg.rutaEngrave || null,
                        imagen: reg.imagen || reg.imagenPath || null,
                        messageId: reg.messageId || null,
                        clientId: reg.clientId || null,
                        timestamp: reg.fecha || reg.timestamp || new Date().toLocaleString('es-ES')
                    };

                    // Chequear si ya existe localmente (por messageId, ruta, part+imagen)
                    const exists = (function (r) {
                        try {
                            const rBase = (r.rutaEngrave || '').split('\\').pop().split('/').pop();
                            const partImgKey = (r.numeroParte || '') + '||' + (r.imagen || '');
                            for (const lk of Object.keys(localData)) {
                                const arr = localData[lk].pieces || [];
                                for (let i = 0; i < arr.length; i++) {
                                    const p = arr[i];
                                    if (!p) continue;
                                    if (r.messageId && (p.uid === r.messageId || p.messageId === r.messageId)) return true;
                                    if (r.clientId && p.clientId && p.clientId === r.clientId) return true;
                                    try {
                                        const pBase = (p.sourceFile || '').split('\\').pop().split('/').pop();
                                        if (rBase && pBase && rBase === pBase) return true;
                                    } catch (e) { }
                                    const pPartImg = (p.partNumber || '') + '||' + (p.imagen || '');
                                    if (pPartImg && partImgKey && pPartImg === partImgKey) return true;
                                }
                            }
                        } catch (e) {
                            return false;
                        }
                        return false;
                    })(registro);

                    if (!exists) {
                        // Insertar en lote global 'lotes'
                        const lotKey = 'lotes';
                        if (!localData[lotKey]) localData[lotKey] = { name: 'LOTES', pieces: [] };
                        const pieceObj = {
                            partNumber: registro.numeroParte || '',
                            quantity: Number(registro.piezas) || 0,
                            incidents: 0,
                            timestamp: registro.timestamp,
                            imagen: registro.imagen || null,
                            sourceFile: registro.rutaEngrave || null,
                            clientId: registro.clientId || null,
                            uid: registro.messageId || registro.clientId || ('u_' + Date.now() + '_' + Math.floor(Math.random() * 100000)),
                            messageId: registro.messageId || null,
                            proceso: ''
                        };
                        localData[lotKey].pieces.unshift(pieceObj);
                        added++;
                        console.debug(`✓ Agregado: ${registro.numeroParte} (${registro.piezas} piezas)`);
                    } else {
                        skipped++;
                    }
                } catch (e) {
                    console.warn('Error reconciliando item de engrave-list', e, item);
                }
            }

            if (added > 0) {
                console.log(`✅ Importados ${added} registros (${skipped} duplicados omitidos)`);
                try {
                    if (window.App && window.App.persist && window.App.persist.markDirty) {
                        window.App.persist.markDirty('importEngraveList');
                    }
                } catch (e) { /* noop */ }
                loadLotRegistration('lotes');
                loadDashboardData();
                updateSyncStatus();
                showNotification(`✅ Sincronizados ${added} registro(s) desde servidor`, 'success');

                // 📄 Si hay más páginas, cargarlas automáticamente
                if (engraveListState.hasMore) {
                    console.log(`📄 Cargando siguiente página (${pageNum + 1}/${Math.ceil(engraveListState.total / 500)})...`);
                    setTimeout(() => importEngraveList(pageNum + 1), 500);
                } else {
                    console.log(`✅ Se completó la carga de todas las ${engraveListState.total} registros`);
                }
            } else if (skipped > 0) {
                console.log(`ℹ️ ${skipped} registros ya existían localmente`);
                showNotification(`ℹ️ Todos los registros (${skipped}) ya estaban en el sistema`, 'info');

                if (engraveListState.hasMore) {
                    console.log(`📄 Cargando siguiente página (${pageNum + 1}/${Math.ceil(engraveListState.total / 500)})...`);
                    setTimeout(() => importEngraveList(pageNum + 1), 500);
                } else {
                    console.log(`✅ Se completó la carga de todas las ${engraveListState.total} registros`);
                }
            }
        } else {
            console.log('ℹ️ No hay nuevos registros en el servidor');

            // 📄 Si hay más páginas, cargarlas automáticamente
            if (engraveListState.hasMore) {
                console.log(`📄 Cargando siguiente página (${pageNum + 1}/${Math.ceil(engraveListState.total / 500)})...`);
                setTimeout(() => importEngraveList(pageNum + 1), 500);
            }
        }
    } catch (e) {
        console.warn('❌ Error en importEngraveList:', e);
        showNotification('Error al sincronizar registros desde servidor', 'error');
    }
}

// Sincronizar datos con el servidor
async function syncWithServer() {
    if (!serverConnected) return;

    const syncIndicator = document.getElementById('sync-indicator');
    const syncMessage = document.getElementById('sync-message');

    if (syncIndicator) syncIndicator.className = 'sync-indicator pending';
    if (syncMessage) syncMessage.textContent = 'Sincronizando...';

    try {
        // ✅ CAMBIO CRÍTICO: NO limpiar localData, simplemente sincronizar cambios pendientes
        console.log('🔄 Sincronizando cambios pendientes con servidor...');

        // Enviar cada pendiente al servidor
        const remaining = [];
        for (const item of pendingSync) {
            try {
                if (item.action === 'create') {
                    const resp = await fetch(`${SERVER_URL}/enqueue`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ numParte: item.partNumber || item.part, numPiezas: item.quantity || item.numPiezas, imagen: item.imagen || item.imagenData || null })
                    });
                    if (!resp.ok) {
                        throw new Error('Server error');
                    }
                    // OK - server will emit SSE
                } else if (item.action === 'delete') {
                    // No hay endpoint delete en servidor por ahora; mantener
                    remaining.push(item);
                } else {
                    remaining.push(item);
                }
            } catch (err) {
                console.warn('Error sincronizando item pendiente:', err, item);
                remaining.push(item);
            }
        }

        pendingSync = remaining;
        // No persistir pendingSync localmente (requisito)

        if (syncIndicator) syncIndicator.className = 'sync-indicator synced';
        if (syncMessage) syncMessage.textContent = `Sincronizado - ${new Date().toLocaleTimeString()}`;

        loadServerInfo();
        loadRecentRegistrations();

        try { await importEngraveList(); } catch (e) { console.warn('importEngraveList failed', e); }
    } catch (error) {
        if (syncIndicator) syncIndicator.className = 'sync-indicator';
        if (syncMessage) syncMessage.textContent = 'Error en sincronización';
    }
}

function updateSyncStatus() {
    const syncIndicator = document.getElementById('sync-indicator');
    const syncMessage = document.getElementById('sync-message');

    if (!syncIndicator || !syncMessage) return;

    if (pendingSync.length > 0) {
        syncIndicator.className = 'sync-indicator pending';
        syncMessage.textContent = `${pendingSync.length} registro(s) pendientes de sincronizar`;
    } else {
        syncIndicator.className = 'sync-indicator synced';
        syncMessage.textContent = 'Todos los datos están sincronizados';
    }
}

// ========================================
// Funciones de sincronización con Base de Datos
// ========================================

async function syncLocalDataToDatabase() {
    try {
        // ✅ CAMBIO CRÍTICO: Usar localData directamente
        const data = localData || {};
        console.log('🔄 Sincronizando datos con la BD...');

        const response = await fetch(`${SERVER_URL}/api/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ laserGrabadoData: data })
        });

        if (!response.ok) {
            console.warn('⚠️ Error sincronizando:', response.statusText);
            return false;
        }

        const result = await response.json();
        console.log('✅ Datos sincronizados con BD:', result.saved, 'items');
        return true;
    } catch (err) {
        console.warn('⚠️ Error en sincronización con BD:', err);
        return false;
    }
}

async function loadDataFromDatabase() {
    try {
        console.log('📥 Cargando datos desde la BD...');
        const response = await fetch(`${SERVER_URL}/api/export`);

        if (!response.ok) {
            console.warn('⚠️ No se pudo cargar desde BD:', response.statusText);
            return false;
        }

        const data = await response.json();
        console.log('✅ Datos cargados de BD:', Object.keys(data).length, 'lotes');

        // ✅ CAMBIO CRÍTICO: Actualizar localData directamente
        localData = data;

        // Recargar UI
        loadDashboardData();
        renderLotes();

        return true;
    } catch (err) {
        console.warn('⚠️ Error cargando de BD:', err);
        return false;
    }
}
