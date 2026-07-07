// API Service - Llamadas centralizadas al servidor
// Extraído para modularización (2025-12-18)

(function(global) {
    'use strict';
    
    // URL del servidor
    const getServerUrl = () => global.App?.config?.serverUrl || 'http://localhost:3000';
    
    // ============================================
    // HELPERS
    // ============================================
    
    async function fetchJSON(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (response.status === 401) {
            try { window.location.href = '/login'; } catch (e) { /* noop */ }
            throw new Error('Unauthorized');
        }
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return response.json();
    }
    
    // ============================================
    // STATUS / CONNECTION
    // ============================================
    
    async function getStatus() {
        try {
            const data = await fetchJSON(`${getServerUrl()}/status`);
            return {
                success: true,
                serverConnected: true,
                authenticated: data.authenticated || false,
                registros: data.registros || []
            };
        } catch (err) {
            console.warn('[API] getStatus failed:', err);
            return {
                success: false,
                serverConnected: false,
                authenticated: false,
                registros: []
            };
        }
    }
    
    async function getQR() {
        try {
            const data = await fetchJSON(`${getServerUrl()}/qr`);
            return {
                success: true,
                qr: data.qr || null
            };
        } catch (err) {
            console.warn('[API] getQR failed:', err);
            return { success: false, qr: null };
        }
    }
    
    async function getServerInfo() {
        try {
            const data = await fetchJSON(`${getServerUrl()}/info-excel`);
            return {
                success: true,
                archivo: data.archivo,
                registros: data.registros,
                existe: data.existe
            };
        } catch (err) {
            console.warn('[API] getServerInfo failed:', err);
            return { success: false };
        }
    }
    
    // ============================================
    // DATA SYNC
    // ============================================
    
    async function exportData() {
        try {
            const data = await fetchJSON(`${getServerUrl()}/api/export`);
            return { success: true, data };
        } catch (err) {
            console.warn('[API] exportData failed:', err);
            return { success: false, data: {} };
        }
    }
    
    async function syncData(laserGrabadoData) {
        try {
            const result = await fetchJSON(`${getServerUrl()}/api/sync`, {
                method: 'POST',
                body: JSON.stringify({ laserGrabadoData })
            });
            return { success: true, saved: result.saved || 0 };
        } catch (err) {
            console.warn('[API] syncData failed:', err);
            return { success: false, saved: 0 };
        }
    }
    
    // ============================================
    // ENGRAVE LIST
    // ============================================
    
    async function getEngraveList(page = 0, pageSize = 500) {
        try {
            const data = await fetchJSON(`${getServerUrl()}/engrave-list?page=${page}&pageSize=${pageSize}`);
            return {
                success: true,
                data: data.data || [],
                pagination: data.pagination || {}
            };
        } catch (err) {
            console.warn('[API] getEngraveList failed:', err);
            return { success: false, data: [], pagination: {} };
        }
    }
    
    // ============================================
    // IMAGE
    // ============================================
    
    async function getImage(partNumber) {
        try {
            const data = await fetchJSON(`${getServerUrl()}/api/image/${encodeURIComponent(partNumber)}`);
            return {
                success: true,
                imageData: data.imageData || null,
                source: data.source || null
            };
        } catch (err) {
            console.warn('[API] getImage failed:', err);
            return { success: false, imageData: null };
        }
    }
    
    // ============================================
    // MANUAL REGISTRATION
    // ============================================
    
    async function registerManual(partNumber, quantity, imageFile = null) {
        const formData = new FormData();
        formData.append('numeroParte', partNumber);
        formData.append('piezas', quantity);
        if (imageFile) {
            formData.append('imagen', imageFile);
        }
        
        try {
            const response = await fetch(`${getServerUrl()}/api/manual-register`, {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const result = await response.json();
            return { success: true, registro: result };
        } catch (err) {
            console.warn('[API] registerManual failed:', err);
            return { success: false };
        }
    }
    
    // ============================================
    // EXPORT API
    // ============================================
    
    const API = {
        // Helpers
        getServerUrl,
        fetchJSON,
        
        // Status
        getStatus,
        getQR,
        getServerInfo,
        
        // Data
        exportData,
        syncData,
        
        // Engrave
        getEngraveList,
        
        // Image
        getImage,
        
        // Registration
        registerManual
    };
    
    // Exponer globalmente
    global.API = API;
    
    // También en window.App.services
    if (!global.App) global.App = {};
    if (!global.App.services) global.App.services = {};
    global.App.services.API = API;
    
    console.log('✅ [API] Módulo de servicios inicializado');
    
})(typeof window !== 'undefined' ? window : this);
