// Controles de WhatsApp QR (reinicio manual y estado)

(function (global) {
    'use strict';

    function $(id) {
        return document.getElementById(id);
    }

    function getServerUrl() {
        return (global.App && global.App.config && global.App.config.serverUrl) || global.SERVER_URL || 'http://localhost:3000';
    }

    function notify(message, type) {
        if (typeof global.showNotification === 'function') {
            global.showNotification(message, type || 'info');
            return;
        }
        try { alert(message); } catch (e) { /* noop */ }
    }

    async function fetchJSON(url, options) {
        const resp = await fetch(url, {
            ...(options || {}),
            headers: {
                'Content-Type': 'application/json',
                ...((options && options.headers) ? options.headers : {})
            }
        });

        if (resp.status === 401) {
            try { window.location.href = '/login'; } catch (e) { /* noop */ }
        }

        let payload = null;
        try {
            payload = await resp.json();
        } catch (e) {
            payload = null;
        }

        if (!resp.ok) {
            const err = new Error(`HTTP ${resp.status}`);
            err.status = resp.status;
            err.payload = payload;
            throw err;
        }

        return payload;
    }

    function setBusy(isBusy, message) {
        const btn = $('whatsapp-restart-btn');
        const status = $('whatsapp-restart-status');
        if (btn) {
            btn.disabled = !!isBusy;
            btn.innerHTML = isBusy
                ? '<span class="btn-icon">⏳</span> Reiniciando...'
                : '<span class="btn-icon">🔄</span> Reiniciar WhatsApp';
        }
        if (status && message !== undefined) {
            status.textContent = message || '';
        }
    }

    async function refreshWhatsAppControls() {
        const status = $('whatsapp-restart-status');
        if (!status) return;

        try {
            const data = await fetchJSON(`${getServerUrl()}/status`);
            const wa = data && data.whatsapp ? data.whatsapp : {};
            if (wa.lastError) {
                status.textContent = `Ultimo error: ${String(wa.lastError).slice(0, 120)}`;
            } else if (wa.initInProgress) {
                status.textContent = 'Inicializando cliente WhatsApp...';
            } else if (data.authenticated) {
                status.textContent = 'Cliente conectado.';
            } else if (wa.lastRestartAt) {
                status.textContent = 'Reinicio enviado. Esperando conexion o QR.';
            } else {
                status.textContent = '';
            }
        } catch (e) {
            status.textContent = 'No se pudo leer estado de WhatsApp.';
        }
    }

    async function restartWhatsAppClient() {
        const ok = confirm('Reiniciar WhatsApp?\n\nEsto cerrara solo el navegador usado por el bot y volvera a iniciar la conexion.');
        if (!ok) return;

        setBusy(true, 'Cerrando sesion bloqueada y reiniciando...');
        try {
            const data = await fetchJSON(`${getServerUrl()}/api/whatsapp/restart`, {
                method: 'POST',
                body: JSON.stringify({ killLockedBrowser: true })
            });

            const killed = Number(data && data.killedProcesses ? data.killedProcesses : 0);
            const msg = killed > 0
                ? `Reinicio enviado. Procesos cerrados: ${killed}.`
                : 'Reinicio enviado. Espera conexion o QR.';

            setBusy(false, msg);
            notify(msg, 'success');

            setTimeout(() => {
                try { if (typeof global.loadWhatsAppStatus === 'function') global.loadWhatsAppStatus(); } catch (e) { /* noop */ }
                try { if (typeof global.loadWhatsAppLogs === 'function') global.loadWhatsAppLogs({ silent: true }); } catch (e) { /* noop */ }
                refreshWhatsAppControls();
            }, 1800);
        } catch (e) {
            const payload = e && e.payload ? e.payload : null;
            let msg = payload && payload.error ? payload.error : 'No se pudo reiniciar WhatsApp.';
            if (e && e.status === 403) msg = 'Sin permiso whatsapp.restart para reiniciar WhatsApp.';
            if (e && e.status === 401) msg = 'Inicia sesion para reiniciar WhatsApp.';
            setBusy(false, msg);
            notify(msg, 'error');
        }
    }

    function bindEvents() {
        const btn = $('whatsapp-restart-btn');
        if (btn) btn.addEventListener('click', restartWhatsAppClient);
    }

    document.addEventListener('DOMContentLoaded', () => {
        bindEvents();
        refreshWhatsAppControls();
    });

    global.refreshWhatsAppControls = refreshWhatsAppControls;
    global.restartWhatsAppClientFromUi = restartWhatsAppClient;

})(typeof window !== 'undefined' ? window : this);
