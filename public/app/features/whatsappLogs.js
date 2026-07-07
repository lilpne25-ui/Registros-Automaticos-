// Logs de WhatsApp (UI)

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

    function formatTime(ts) {
        try {
            const d = new Date(ts);
            if (!Number.isFinite(d.getTime())) return '';
            return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (e) {
            return '';
        }
    }

    function buildMeta(meta) {
        if (!meta || typeof meta !== 'object') return '';
        const parts = [];
        if (meta.from) parts.push(`from=${meta.from}`);
        if (meta.groupId) parts.push(`group=${meta.groupId}`);
        if (meta.name) parts.push(`name=${meta.name}`);
        if (meta.reason) parts.push(`reason=${meta.reason}`);
        if (meta.preview) parts.push(`msg=${String(meta.preview).slice(0, 60)}`);
        return parts.join(' | ');
    }

    let lastTextCache = '';

    function renderLogs(data) {
        const listEl = $('whatsapp-logs-list');
        const statusEl = $('whatsapp-log-status');
        if (!listEl) return;

        const logs = Array.isArray(data && data.logs) ? data.logs : [];
        lastTextCache = logs.map((entry) => {
            const time = formatTime(entry.ts);
            const type = entry.type || entry.level || 'info';
            const msg = entry.message || '';
            const meta = buildMeta(entry.meta);
            return `[${time}] ${type} - ${msg}${meta ? ` | ${meta}` : ''}`;
        }).join('\n');

        listEl.innerHTML = '';

        if (!logs.length) {
            listEl.innerHTML = '<div class="whatsapp-groups-empty">Sin logs por ahora.</div>';
        } else {
            logs.forEach((entry) => {
                const row = document.createElement('div');
                let className = 'whatsapp-log-entry log-info';
                if (entry.type === 'authorized') className = 'whatsapp-log-entry log-authorized';
                if (entry.type === 'rejected') className = 'whatsapp-log-entry log-rejected';
                if (entry.level === 'warn') className = 'whatsapp-log-entry log-warn';
                if (entry.level === 'error') className = 'whatsapp-log-entry log-error';
                row.className = className;

                const timeEl = document.createElement('div');
                timeEl.className = 'whatsapp-log-time';
                timeEl.textContent = formatTime(entry.ts) || '--:--:--';

                const content = document.createElement('div');
                const msgEl = document.createElement('div');
                msgEl.className = 'whatsapp-log-message';
                msgEl.textContent = entry.message || '';

                const metaText = buildMeta(entry.meta);
                if (metaText) {
                    const metaEl = document.createElement('div');
                    metaEl.className = 'whatsapp-log-meta';
                    metaEl.textContent = metaText;
                    content.appendChild(msgEl);
                    content.appendChild(metaEl);
                } else {
                    content.appendChild(msgEl);
                }

                row.appendChild(timeEl);
                row.appendChild(content);
                listEl.appendChild(row);
            });
        }

        if (statusEl) {
            const total = data && typeof data.total === 'number' ? data.total : logs.length;
            statusEl.textContent = `Total: ${total} | Mostrando: ${logs.length}`;
        }
    }

    async function loadWhatsAppLogs(options) {
        const listEl = $('whatsapp-logs-list');
        const statusEl = $('whatsapp-log-status');
        if (!listEl) return;
        const silent = options && options.silent;
        try {
            const data = await fetchJSON(`${getServerUrl()}/api/whatsapp/logs?limit=200`);
            renderLogs(data);
        } catch (e) {
            console.warn('[WhatsAppLogs] load error:', e);
            if (!silent) notify('No se pudieron cargar los logs.', 'warning');
            if (statusEl) {
                if (e && (e.status === 401 || e.status === 403)) {
                    statusEl.textContent = 'Sin permisos para ver logs.';
                } else {
                    statusEl.textContent = 'Logs no disponibles.';
                }
            }
        }
    }

    async function clearWhatsAppLogs() {
        try {
            await fetchJSON(`${getServerUrl()}/api/whatsapp/logs/clear`, { method: 'POST' });
            notify('Logs limpiados.', 'success');
            await loadWhatsAppLogs();
        } catch (e) {
            const msg = (e && e.payload && e.payload.error) ? e.payload.error : 'No se pudieron limpiar los logs.';
            notify(msg, 'error');
        }
    }

    async function copyWhatsAppLogs() {
        if (!lastTextCache) {
            notify('No hay logs para copiar.', 'warning');
            return;
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(lastTextCache);
                notify('Logs copiados.', 'success');
                return;
            }
        } catch (e) { /* noop */ }

        try {
            const temp = document.createElement('textarea');
            temp.value = lastTextCache;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            temp.remove();
            notify('Logs copiados.', 'success');
        } catch (e) {
            notify('No se pudo copiar.', 'error');
        }
    }

    function bindEvents() {
        const refreshBtn = $('whatsapp-log-refresh');
        const copyBtn = $('whatsapp-log-copy');
        const clearBtn = $('whatsapp-log-clear');

        if (refreshBtn) refreshBtn.addEventListener('click', () => loadWhatsAppLogs({ silent: false }));
        if (copyBtn) copyBtn.addEventListener('click', copyWhatsAppLogs);
        if (clearBtn) clearBtn.addEventListener('click', clearWhatsAppLogs);
    }

    document.addEventListener('DOMContentLoaded', () => {
        bindEvents();
        const card = $('whatsapp-logs-card');
        if (card) {
            loadWhatsAppLogs({ silent: true });
            setInterval(() => loadWhatsAppLogs({ silent: true }), 5000);
        }
    });

    global.loadWhatsAppLogs = loadWhatsAppLogs;

})(typeof window !== 'undefined' ? window : this);
