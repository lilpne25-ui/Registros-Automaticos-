// Gestion de grupos autorizados de WhatsApp (UI)

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

    function setEditable(editable) {
        const idInput = $('whatsapp-group-id');
        const nameInput = $('whatsapp-group-name');
        const addBtn = $('whatsapp-group-add');
        if (idInput) idInput.disabled = !editable;
        if (nameInput) nameInput.disabled = !editable;
        if (addBtn) addBtn.disabled = !editable;

        const toggleInputs = document.querySelectorAll('.whatsapp-group-active');
        toggleInputs.forEach(input => { input.disabled = !editable; });

        const nameInputs = document.querySelectorAll('.whatsapp-group-name-input');
        nameInputs.forEach(input => { input.disabled = !editable; });

        const actionBtns = document.querySelectorAll('.whatsapp-group-remove, .whatsapp-group-save');
        actionBtns.forEach(btn => { btn.disabled = !editable; });
    }

    function normalizeEntries(data) {
        if (!data) return [];
        if (Array.isArray(data)) {
            return data.map(item => ({
                id: String(item.id || '').trim(),
                name: String(item.name || item.id || '').trim(),
                active: item.active !== false
            })).filter(item => !!item.id);
        }
        if (typeof data === 'object') {
            return Object.entries(data).map(([id, name]) => ({
                id: String(id || '').trim(),
                name: String(name || id || '').trim(),
                active: true
            })).filter(item => !!item.id);
        }
        return [];
    }

    function renderGroups(data) {
        const listEl = $('whatsapp-groups-list');
        const statusEl = $('whatsapp-groups-status');
        const sourceEl = $('whatsapp-groups-source');

        if (!listEl) return;

        const entries = normalizeEntries(data && data.groups ? data.groups : data)
            .sort((a, b) => {
                const aKey = (a.name || a.id).toLowerCase();
                const bKey = (b.name || b.id).toLowerCase();
                return aKey.localeCompare(bKey, 'es');
            });

        listEl.innerHTML = '';

        if (entries.length === 0) {
            listEl.innerHTML = '<div class="whatsapp-groups-empty">No hay grupos autorizados. El bot aceptara mensajes de cualquiera.</div>';
        } else {
            entries.forEach((entry) => {
                const id = entry.id;
                const name = entry.name || entry.id;
                const isActive = entry.active !== false;
                const row = document.createElement('div');
                row.className = 'whatsapp-group-row';

                const meta = document.createElement('div');
                meta.className = 'whatsapp-group-meta';

                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.className = 'whatsapp-group-name-input';
                nameInput.value = name || id;

                const idEl = document.createElement('div');
                idEl.className = 'whatsapp-group-id';
                idEl.textContent = id;

                meta.appendChild(nameInput);
                meta.appendChild(idEl);

                const toggleWrap = document.createElement('label');
                toggleWrap.className = 'whatsapp-group-toggle';

                const toggle = document.createElement('input');
                toggle.type = 'checkbox';
                toggle.className = 'whatsapp-group-active';
                toggle.checked = !!isActive;

                const toggleText = document.createElement('span');
                toggleText.textContent = 'Activo';

                toggleWrap.appendChild(toggle);
                toggleWrap.appendChild(toggleText);

                const actions = document.createElement('div');
                actions.className = 'whatsapp-group-actions';

                const saveBtn = document.createElement('button');
                saveBtn.type = 'button';
                saveBtn.className = 'action-btn btn-secondary btn-compact whatsapp-group-save';
                saveBtn.textContent = 'Guardar';
                saveBtn.addEventListener('click', () => {
                    updateGroup(id, nameInput.value, toggle.checked);
                });

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'action-btn btn-warning btn-compact whatsapp-group-remove';
                removeBtn.textContent = 'Quitar';
                removeBtn.addEventListener('click', () => {
                    removeGroup(id);
                });

                actions.appendChild(saveBtn);
                actions.appendChild(removeBtn);
                row.appendChild(meta);
                row.appendChild(toggleWrap);
                row.appendChild(actions);
                listEl.appendChild(row);
            });
        }

        const totalCount = data && typeof data.totalCount === 'number' ? data.totalCount : entries.length;
        const activeCount = data && typeof data.activeCount === 'number'
            ? data.activeCount
            : entries.filter(e => e.active !== false).length;
        const editable = !(data && data.editable === false);
        if (statusEl) {
            const base = activeCount > 0 ? `Activo (${activeCount}/${totalCount})` : 'Inactivo (sin grupos)';
            statusEl.textContent = editable ? base : `${base} | Solo lectura`;
        }

        if (sourceEl) {
            const source = data && data.source ? String(data.source) : 'file';
            sourceEl.textContent = source === 'env' ? 'Fuente: ALLOWED_GROUPS_JSON' : 'Fuente: archivo local';
        }

        setEditable(editable);
    }

    async function loadWhatsAppGroups() {
        const listEl = $('whatsapp-groups-list');
        const statusEl = $('whatsapp-groups-status');
        if (!listEl) return;

        try {
            const data = await fetchJSON(`${getServerUrl()}/api/whatsapp/groups`);
            renderGroups(data);
        } catch (e) {
            console.warn('[WhatsAppGroups] load error:', e);
            if (statusEl) {
                if (e && (e.status === 401 || e.status === 403)) {
                    statusEl.textContent = 'Sin permisos';
                } else {
                    statusEl.textContent = 'Error al cargar';
                }
            }
            listEl.innerHTML = '<div class="whatsapp-groups-empty">No se pudo cargar la lista.</div>';
            notify('No se pudo cargar la lista de grupos.', 'warning');
        }
    }

    async function addGroup(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();

        const idInput = $('whatsapp-group-id');
        const nameInput = $('whatsapp-group-name');
        if (!idInput) return;

        const id = String(idInput.value || '').trim();
        const name = String((nameInput && nameInput.value) || '').trim();

        if (!id) {
            notify('Escribe el ID del grupo.', 'warning');
            return;
        }

        try {
            await fetchJSON(`${getServerUrl()}/api/whatsapp/groups`, {
                method: 'POST',
                body: JSON.stringify({ id, name, active: true })
            });
            if (nameInput) nameInput.value = '';
            idInput.value = '';
            notify('Grupo agregado.', 'success');
            await loadWhatsAppGroups();
        } catch (e) {
            const msg = (e && e.payload && e.payload.error) ? e.payload.error : 'No se pudo agregar el grupo.';
            notify(msg, 'error');
        }
    }

    async function removeGroup(id) {
        const safeId = String(id || '').trim();
        if (!safeId) return;

        const ok = confirm(`Quitar grupo autorizado?\n${safeId}`);
        if (!ok) return;

        try {
            await fetchJSON(`${getServerUrl()}/api/whatsapp/groups/${encodeURIComponent(safeId)}`, {
                method: 'DELETE'
            });
            notify('Grupo eliminado.', 'success');
            await loadWhatsAppGroups();
        } catch (e) {
            const msg = (e && e.payload && e.payload.error) ? e.payload.error : 'No se pudo quitar el grupo.';
            notify(msg, 'error');
        }
    }

    async function updateGroup(id, name, active) {
        const safeId = String(id || '').trim();
        if (!safeId) return;

        try {
            await fetchJSON(`${getServerUrl()}/api/whatsapp/groups/${encodeURIComponent(safeId)}`, {
                method: 'PUT',
                body: JSON.stringify({ name: String(name || '').trim(), active: !!active })
            });
            notify('Grupo actualizado.', 'success');
            await loadWhatsAppGroups();
        } catch (e) {
            const msg = (e && e.payload && e.payload.error) ? e.payload.error : 'No se pudo actualizar el grupo.';
            notify(msg, 'error');
        }
    }

    function bindEvents() {
        const form = $('whatsapp-groups-form');
        if (form) {
            form.addEventListener('submit', addGroup);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        bindEvents();
        const card = $('whatsapp-groups-card');
        if (card) {
            loadWhatsAppGroups();
        }
    });

    global.loadWhatsAppGroups = loadWhatsAppGroups;

})(typeof window !== 'undefined' ? window : this);
