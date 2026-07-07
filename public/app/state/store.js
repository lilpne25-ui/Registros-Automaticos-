// State Store - Gestión centralizada del estado de la aplicación
// Extraído para modularización (2025-12-18)

(function(global) {
    'use strict';

    // Defaults defensivos: si el HTML todavía no configuró App.config,
    // asumir modo multiusuario (sin auto-sync por snapshot) para evitar reapariciones.
    try {
        if (!global.App) global.App = {};
        if (!global.App.config) global.App.config = {};
        if (typeof global.App.config.disableAutoSync !== 'boolean') {
            global.App.config.disableAutoSync = true;
        }
    } catch (e) { /* noop */ }

    // ============================================
    // ESTADO GLOBAL
    // ============================================
    
    // Datos principales - cargados desde BD
    let localData = {};

    // Indica si ya se cargó (o inicializó) el estado desde la BD/servidor.
    // Antes de hidratar, el código legacy puede mutar localData parcialmente;
    // evitamos auto-sync para no empujar snapshots incompletos.
    let hydrated = false;
    
    // Estado de conexión
    let serverConnected = false;
    let whatsappConnected = false;
    
    // Paginación de lotes
    let currentPageLotes = 0;
    const PAGE_SIZE_LOTES = 10;
    
    // Lote actualmente seleccionado en registro
    let currentRegistroLot = 'lotes';
    
    // Historial Undo/Redo
    let undoStack = [];
    let redoStack = [];
    const MAX_HISTORY = 20;
    
    // Pending adds (para reconciliar SSE)
    const pendingAdds = {};
    
    // Sync debounce
    let syncTimeoutId = null;
    const SYNC_DEBOUNCE_MS = 2000;
    
    // ============================================
    // GETTERS Y SETTERS
    // ============================================
    
    function getLocalData() {
        return localData;
    }
    
    function setLocalData(data) {
        localData = data || {};
        hydrated = true;
    }

    function isHydrated() {
        return hydrated;
    }
    
    function getLot(lotKey) {
        return localData[lotKey] || null;
    }
    
    function setLot(lotKey, lot) {
        localData[lotKey] = lot;
    }
    
    function deleteLot(lotKey) {
        delete localData[lotKey];
    }
    
    function getAllLotKeys() {
        return Object.keys(localData);
    }
    
    // ============================================
    // DIRTY FLAG Y AUTO-SYNC
    // ============================================
    
    function markDirty(reason) {
        // En modo multiusuario, NO empujar snapshots completos desde el navegador.
        // Los cambios deben persistirse con endpoints granulares (CRUD) para evitar
        // reintroducir registros borrados o pisar cambios de otros usuarios.
        if (global.App?.config?.disableAutoSync) {
            console.debug(`[Store] Auto-sync deshabilitado (App.config.disableAutoSync). Razón: ${reason}`);
            return;
        }

        if (syncTimeoutId) {
            clearTimeout(syncTimeoutId);
        }
        
        console.debug(`[Store] Marked dirty: ${reason}`);
        
        syncTimeoutId = setTimeout(async () => {
            try {
                if (!hydrated) {
                    console.debug('[Store] Auto-sync omitido (store no hidratado aún). Razón:', reason);
                    return;
                }
                await syncToDatabase();
            } catch (e) {
                console.warn('[Store] Auto-sync failed:', e);
            }
        }, SYNC_DEBOUNCE_MS);
    }
    
    async function syncToDatabase() {
        try {
            if (global.App?.config?.disableAutoSync) {
                console.debug('[Store] syncToDatabase omitido (disableAutoSync=true)');
                return false;
            }

            const SERVER_URL = window.App?.config?.serverUrl || 'http://localhost:3000';
            console.log('🔄 [Store] Sincronizando datos con la BD...');
            
            // ✅ FILTRAR: Solo enviar lotes con IDs válidos
            const validPrefixes = ['lotes', 'whatsapp_inbox', 'laser-lot-', 'pavonado-lot-'];
            const filteredData = {};
            for (const [key, value] of Object.entries(localData || {})) {
                const isValid = validPrefixes.some(prefix => key === prefix || key.startsWith(prefix));
                if (isValid) {
                    filteredData[key] = value;
                } else {
                    console.log('🚫 [Store] Ignorando lote con ID inválido en sync:', key);
                }
            }
            
            const response = await fetch(`${SERVER_URL}/api/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ laserGrabadoData: filteredData })
            });
            
            if (!response.ok) {
                console.warn('⚠️ [Store] Error sincronizando:', response.statusText);
                return false;
            }
            
            const result = await response.json();
            console.log('✅ [Store] Datos sincronizados con BD:', result.saved, 'items');
            return true;
        } catch (err) {
            console.warn('⚠️ [Store] Error en sincronización con BD:', err);
            return false;
        }
    }
    
    async function loadFromDatabase() {
        try {
            const SERVER_URL = window.App?.config?.serverUrl || 'http://localhost:3000';
            console.log('📥 [Store] Cargando datos desde la BD...');
            
            const response = await fetch(`${SERVER_URL}/api/export`);
            
            if (!response.ok) {
                console.warn('⚠️ [Store] No se pudo cargar desde BD:', response.statusText);
                return false;
            }
            
            const rawData = await response.json();

            // ✅ FILTRAR: solo IDs válidos (evita que reaparezcan lotes legacy/duplicados)
            const validPrefixes = ['lotes', 'whatsapp_inbox', 'laser-lot-', 'pavonado-lot-'];
            const data = {};
            let skipped = 0;
            for (const [key, value] of Object.entries(rawData || {})) {
                const isValid = validPrefixes.some(prefix => key === prefix || key.startsWith(prefix));
                if (isValid) data[key] = value;
                else skipped++;
            }
            
            if (data && Object.keys(data).length > 0) {
                localData = data;
                hydrated = true;
                console.log('✅ [Store] Datos cargados de BD:', Object.keys(localData).length, 'lotes', skipped ? `(ignorados: ${skipped})` : '');
            } else {
                // BD vacía, crear lote principal
                localData = {
                    'lotes': { id: 'lotes', name: 'LOTES', pieces: [], process: 'all' }
                };
                hydrated = true;
                console.log('✅ [Store] BD vacía, inicializado con lote principal "lotes"');
            }
            
            return true;
        } catch (err) {
            console.warn('⚠️ [Store] Error cargando de BD:', err);
            // Fallback
            localData = {
                'lotes': { id: 'lotes', name: 'LOTES', pieces: [], process: 'all' }
            };
            hydrated = true;
            return false;
        }
    }
    
    // ============================================
    // HISTORIAL (UNDO/REDO)
    // ============================================
    
    function saveToHistory(action, description) {
        undoStack.push({
            action,
            description,
            data: JSON.parse(JSON.stringify(localData)),
            timestamp: new Date().toISOString()
        });
        
        if (undoStack.length > MAX_HISTORY) {
            undoStack.shift();
        }
        
        // Limpiar redo cuando hay nueva acción
        redoStack = [];
        
        console.debug(`[Store] History saved: ${description}`, { stackSize: undoStack.length });
    }
    
    function undo() {
        if (undoStack.length === 0) {
            return { success: false, message: 'Nada que deshacer' };
        }
        
        const entry = undoStack.pop();
        
        redoStack.push({
            action: entry.action,
            description: entry.description,
            data: JSON.parse(JSON.stringify(localData)),
            timestamp: new Date().toISOString()
        });
        
        localData = entry.data;
        markDirty('undo');
        
        return { success: true, description: entry.description };
    }
    
    function redo() {
        if (redoStack.length === 0) {
            return { success: false, message: 'Nada que rehacer' };
        }
        
        const entry = redoStack.pop();
        
        undoStack.push({
            action: entry.action,
            description: entry.description,
            data: JSON.parse(JSON.stringify(localData)),
            timestamp: new Date().toISOString()
        });
        
        localData = entry.data;
        markDirty('redo');
        
        return { success: true, description: entry.description };
    }
    
    // ============================================
    // CONNECTION STATE
    // ============================================
    
    function setServerConnected(value) {
        serverConnected = !!value;
    }
    
    function isServerConnected() {
        return serverConnected;
    }
    
    function setWhatsAppConnected(value) {
        whatsappConnected = !!value;
    }
    
    function isWhatsAppConnected() {
        return whatsappConnected;
    }
    
    // ============================================
    // PAGINATION
    // ============================================
    
    function getCurrentPageLotes() {
        return currentPageLotes;
    }
    
    function setCurrentPageLotes(page) {
        currentPageLotes = page;
    }
    
    function getPageSizeLotes() {
        return PAGE_SIZE_LOTES;
    }
    
    // ============================================
    // CURRENT LOT
    // ============================================
    
    function getCurrentRegistroLot() {
        return currentRegistroLot;
    }
    
    function setCurrentRegistroLot(lotKey) {
        currentRegistroLot = lotKey;
    }
    
    // ============================================
    // PENDING ADDS (SSE reconciliation)
    // ============================================
    
    function getPendingAdds() {
        return pendingAdds;
    }
    
    function setPendingAdd(id, timeoutId) {
        pendingAdds[id] = timeoutId;
    }
    
    function clearPendingAdd(id) {
        if (pendingAdds[id]) {
            clearTimeout(pendingAdds[id]);
            delete pendingAdds[id];
        }
    }
    
    // ============================================
    // EXPORT API
    // ============================================
    
    const Store = {
        // Data
        getLocalData,
        setLocalData,
        getLot,
        setLot,
        deleteLot,
        getAllLotKeys,
        
        // Sync
        markDirty,
        syncToDatabase,
        loadFromDatabase,
        isHydrated,
        
        // History
        saveToHistory,
        undo,
        redo,
        
        // Connection
        setServerConnected,
        isServerConnected,
        setWhatsAppConnected,
        isWhatsAppConnected,
        
        // Pagination
        getCurrentPageLotes,
        setCurrentPageLotes,
        getPageSizeLotes,
        
        // Current lot
        getCurrentRegistroLot,
        setCurrentRegistroLot,
        
        // Pending adds
        getPendingAdds,
        setPendingAdd,
        clearPendingAdd
    };
    
    // Exponer globalmente
    global.Store = Store;
    
    // Exponer localData como getter/setter para compatibilidad con código legacy
    // Esto permite que código como `localData[lotKey]` siga funcionando
    Object.defineProperty(global, 'localData', {
        get: function() { return Store.getLocalData(); },
        set: function(val) { Store.setLocalData(val); },
        configurable: true
    });
    
    // También en window.App.state para consistencia con la arquitectura
    if (!global.App) global.App = {};
    if (!global.App.state) global.App.state = {};
    global.App.state.Store = Store;
    
    // Compatibilidad: exponer markDirty globalmente
    global.markLocalDataDirty = function(reason) {
        Store.markDirty(reason);
    };
    
    console.log('✅ [Store] Módulo de estado inicializado');
    
})(typeof window !== 'undefined' ? window : this);
