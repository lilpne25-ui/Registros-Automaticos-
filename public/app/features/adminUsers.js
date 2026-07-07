// Admin Users Feature (RBAC)
// UI para crear usuarios y asignar permisos.
// Requiere backend: /api/admin/*

(function (global) {
    'use strict';

    function $(id) {
        return document.getElementById(id);
    }

    function safeText(v) {
        if (v === null || v === undefined) return '';
        return String(v);
    }

    function normalizePerms(perms) {
        if (!perms) return [];
        if (perms === '*') return ['*'];
        if (Array.isArray(perms)) return perms.map(p => String(p)).filter(Boolean);
        if (typeof perms === 'string') {
            const s = perms.trim();
            if (!s) return [];
            if (s === '*') return ['*'];
            return s.split(',').map(x => x.trim()).filter(Boolean);
        }
        return [];
    }

    function hasPerm(perms, key) {
        const arr = normalizePerms(perms);
        if (arr.includes('*')) return true;
        return arr.includes(String(key));
    }

    function setBanner(type, text) {
        const banner = $('admin-users-banner');
        const indicator = $('admin-users-banner-indicator');
        const label = $('admin-users-banner-text');
        if (!banner || !indicator || !label) return;

        banner.classList.remove('is-hidden');
        label.textContent = text || '—';

        // Reutilizamos estilos existentes: sync-indicator / sync-status
        indicator.className = 'sync-indicator';
        if (type === 'ok') indicator.className = 'sync-indicator synced';
        if (type === 'warn') indicator.className = 'sync-indicator syncing';
        if (type === 'err') indicator.className = 'sync-indicator';
    }

    function clearBanner() {
        const banner = $('admin-users-banner');
        if (banner) banner.classList.add('is-hidden');
    }

    async function fetchJSON(url, options) {
        const resp = await fetch(url, {
            ...(options || {}),
            headers: {
                'Content-Type': 'application/json',
                ...((options && options.headers) ? options.headers : {})
            }
        });

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

    async function loadMe() {
        const data = await fetchJSON('/api/auth/me');
        global.__authMe = data;
        return data;
    }

    let permissionsCatalog = null; // { key: label }

    function renderPermissionCheckboxes(containerEl, catalog, selectedPerms) {
        if (!containerEl) return;
        const selected = new Set(normalizePerms(selectedPerms));
        containerEl.innerHTML = '';

        const keys = Object.keys(catalog || {}).sort((a, b) => a.localeCompare(b, 'es'));
        if (keys.length === 0) {
            containerEl.innerHTML = '<div style="color:#64748b">No hay catálogo de permisos.</div>';
            return;
        }

        for (const key of keys) {
            const label = catalog[key] || key;
            const id = `perm_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

            const wrap = document.createElement('label');
            wrap.style.display = 'flex';
            wrap.style.alignItems = 'center';
            wrap.style.gap = '8px';
            wrap.style.padding = '6px 8px';
            wrap.style.border = '1px solid rgba(148,163,184,0.35)';
            wrap.style.borderRadius = '8px';
            wrap.style.background = 'rgba(15, 23, 42, 0.02)';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.id = id;
            cb.dataset.permKey = key;
            cb.checked = selected.has('*') || selected.has(key);

            const txt = document.createElement('div');
            txt.style.display = 'flex';
            txt.style.flexDirection = 'column';
            txt.style.lineHeight = '1.2';

            const t1 = document.createElement('div');
            t1.textContent = label;
            t1.style.fontWeight = '700';

            const t2 = document.createElement('div');
            t2.textContent = key;
            t2.style.fontSize = '12px';
            t2.style.color = '#64748b';

            txt.appendChild(t1);
            txt.appendChild(t2);

            wrap.appendChild(cb);
            wrap.appendChild(txt);
            containerEl.appendChild(wrap);
        }
    }

    function readCheckedPerms(containerEl) {
        if (!containerEl) return [];
        const cbs = containerEl.querySelectorAll('input[type="checkbox"][data-perm-key]');
        const out = [];
        cbs.forEach(cb => {
            if (cb.checked) out.push(String(cb.dataset.permKey));
        });
        return out;
    }

    // --- Modal para editar permisos de usuario existente ---
    let editPermsState = { username: null, permsInput: null, roleSel: null, activeCb: null };

    function openEditPermsModal(username, currentPerms, permsInputEl, roleSelEl, activeCbEl) {
        const modal = $('edit-perms-modal');
        const titleEl = $('edit-perms-username');
        const container = $('edit-perms-checkboxes');
        if (!modal || !container) return;

        editPermsState = { username, permsInput: permsInputEl, roleSel: roleSelEl, activeCb: activeCbEl };
        if (titleEl) titleEl.textContent = username;

        renderPermissionCheckboxes(container, permissionsCatalog || {}, currentPerms);
        modal.style.display = 'flex';
    }

    function closeEditPermsModal() {
        const modal = $('edit-perms-modal');
        if (modal) modal.style.display = 'none';
        editPermsState = { username: null, permsInput: null, roleSel: null, activeCb: null };
    }

    async function saveEditPerms() {
        const container = $('edit-perms-checkboxes');
        if (!container || !editPermsState.username) return;

        const selectedPerms = readCheckedPerms(container);
        const username = editPermsState.username;
        const role = editPermsState.roleSel ? editPermsState.roleSel.value : 'viewer';
        const active = editPermsState.activeCb ? !!editPermsState.activeCb.checked : true;

        try {
            clearBanner();
            setBanner('warn', `Guardando permisos de ${username}...`);
            await fetchJSON(`/api/admin/users/${encodeURIComponent(username)}`, {
                method: 'PUT',
                body: JSON.stringify({ role, permissions: selectedPerms, active })
            });
            setBanner('ok', `✅ Permisos actualizados (${username})`);
            if (typeof global.showNotification === 'function') global.showNotification(`✅ Permisos actualizados (${username})`, 'success');

            // Actualizar el input de texto en la tabla
            if (editPermsState.permsInput) {
                const csv = selectedPerms.includes('*') ? '*' : selectedPerms.join(',');
                editPermsState.permsInput.value = csv;
            }

            closeEditPermsModal();
        } catch (e) {
            const msg = (e && e.payload && e.payload.error) ? e.payload.error : (e && e.message ? e.message : 'Error');
            setBanner('err', `❌ No se pudo guardar permisos: ${msg}`);
            if (typeof global.showNotification === 'function') global.showNotification(`❌ Error: ${msg}`, 'error');
        }
    }

    function initEditPermsModalHandlers() {
        const closeBtn = $('close-edit-perms');
        const cancelBtn = $('cancel-edit-perms');
        const saveBtn = $('save-edit-perms');
        const selectAllBtn = $('edit-perms-select-all');
        const modal = $('edit-perms-modal');

        if (closeBtn) closeBtn.addEventListener('click', closeEditPermsModal);
        if (cancelBtn) cancelBtn.addEventListener('click', closeEditPermsModal);
        if (saveBtn) saveBtn.addEventListener('click', saveEditPerms);
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => {
                const container = $('edit-perms-checkboxes');
                if (!container) return;
                const cbs = container.querySelectorAll('input[type="checkbox"][data-perm-key]');
                const allChecked = Array.from(cbs).every(cb => cb.checked);
                cbs.forEach(cb => { cb.checked = !allChecked; });
            });
        }
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeEditPermsModal();
            });
        }
    }

    async function loadPermissionsCatalog() {
        const data = await fetchJSON('/api/admin/permissions');
        permissionsCatalog = (data && data.permissions) ? data.permissions : {};
        return permissionsCatalog;
    }

    async function loadUsers() {
        const data = await fetchJSON('/api/admin/users');
        return (data && Array.isArray(data.users)) ? data.users : [];
    }

    function renderUsersTable(containerEl, users) {
        if (!containerEl) return;

        const rows = Array.isArray(users) ? users : [];
        if (rows.length === 0) {
            containerEl.innerHTML = '<div style="color:#64748b">No hay usuarios.</div>';
            return;
        }

        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';

        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr>
                <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(148,163,184,0.35)">Usuario</th>
                <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(148,163,184,0.35)">Rol</th>
                <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(148,163,184,0.35)">Activo</th>
                <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(148,163,184,0.35)">Permisos (CSV o *)</th>
                <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(148,163,184,0.35)">Acciones</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        for (const u of rows) {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid rgba(148,163,184,0.25)';

            const username = safeText(u.username);
            const permsCsv = (normalizePerms(u.permissions).includes('*')) ? '*' : normalizePerms(u.permissions).join(',');

            const tdUser = document.createElement('td');
            tdUser.style.padding = '8px';
            tdUser.style.fontWeight = '700';
            tdUser.textContent = username;

            const tdRole = document.createElement('td');
            tdRole.style.padding = '8px';
            const roleSel = document.createElement('select');
            roleSel.innerHTML = `
                <option value="viewer">viewer</option>
                <option value="operator">operator</option>
                <option value="supervisor">supervisor</option>
                <option value="admin">admin</option>
            `;
            roleSel.value = safeText(u.role || 'viewer');
            tdRole.appendChild(roleSel);

            const tdActive = document.createElement('td');
            tdActive.style.padding = '8px';
            const activeCb = document.createElement('input');
            activeCb.type = 'checkbox';
            activeCb.checked = !!u.active;
            tdActive.appendChild(activeCb);

            const tdPerms = document.createElement('td');
            tdPerms.style.padding = '8px';
            const permsInput = document.createElement('input');
            permsInput.type = 'text';
            permsInput.style.width = '100%';
            permsInput.placeholder = 'ej: pieces.edit,metrics.edit';
            permsInput.value = permsCsv;
            tdPerms.appendChild(permsInput);

            const tdActions = document.createElement('td');
            tdActions.style.padding = '8px';
            tdActions.style.whiteSpace = 'nowrap';

            const btnSave = document.createElement('button');
            btnSave.className = 'action-btn btn-teal btn-compact';
            btnSave.type = 'button';
            btnSave.textContent = 'Guardar';

            const btnDelete = document.createElement('button');
            btnDelete.className = 'action-btn btn-danger btn-compact';
            btnDelete.type = 'button';
            btnDelete.textContent = 'Eliminar';

            const btnEditPerms = document.createElement('button');
            btnEditPerms.className = 'action-btn btn-indigo btn-compact';
            btnEditPerms.type = 'button';
            btnEditPerms.textContent = 'Permisos';
            btnEditPerms.title = 'Editar permisos con checkboxes';

            tdActions.appendChild(btnSave);
            tdActions.appendChild(document.createTextNode(' '));
            tdActions.appendChild(btnEditPerms);
            tdActions.appendChild(document.createTextNode(' '));
            tdActions.appendChild(btnDelete);

            btnSave.addEventListener('click', async () => {
                try {
                    clearBanner();
                    setBanner('warn', `Guardando cambios de ${username}...`);
                    const permsRaw = permsInput.value;
                    const perms = normalizePerms(permsRaw);
                    const role = roleSel.value;
                    const active = !!activeCb.checked;

                    await fetchJSON(`/api/admin/users/${encodeURIComponent(username)}`, {
                        method: 'PUT',
                        body: JSON.stringify({ role, permissions: perms, active })
                    });

                    setBanner('ok', `✅ Usuario ${username} actualizado`);
                    if (typeof global.showNotification === 'function') global.showNotification(`✅ Usuario ${username} actualizado`, 'success');
                } catch (e) {
                    const msg = (e && e.payload && e.payload.error) ? e.payload.error : (e && e.message ? e.message : 'Error');
                    setBanner('err', `❌ No se pudo actualizar ${username}: ${msg}`);
                    if (typeof global.showNotification === 'function') global.showNotification(`❌ No se pudo actualizar: ${msg}`, 'error');
                }
            });

            btnDelete.addEventListener('click', async () => {
                try {
                    const ok = confirm(`¿Eliminar usuario ${username}?`);
                    if (!ok) return;
                    clearBanner();
                    setBanner('warn', `Eliminando usuario ${username}...`);
                    await fetchJSON(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
                    setBanner('ok', `✅ Usuario eliminado (${username})`);
                    if (typeof global.showNotification === 'function') global.showNotification(`✅ Usuario eliminado (${username})`, 'success');

                    // Recargar tabla
                    await refreshUsers();
                } catch (e) {
                    const msg = (e && e.payload && e.payload.error) ? e.payload.error : (e && e.message ? e.message : 'Error');
                    setBanner('err', `❌ No se pudo eliminar: ${msg}`);
                    if (typeof global.showNotification === 'function') global.showNotification(`❌ No se pudo eliminar: ${msg}`, 'error');
                }
            });

            btnEditPerms.addEventListener('click', () => {
                openEditPermsModal(username, normalizePerms(u.permissions), permsInput, roleSel, activeCb);
            });

            tr.appendChild(tdUser);
            tr.appendChild(tdRole);
            tr.appendChild(tdActive);
            tr.appendChild(tdPerms);
            tr.appendChild(tdActions);
            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        containerEl.innerHTML = '';
        containerEl.appendChild(table);
    }

    async function refreshUsers() {
        const list = $('admin-users-list');
        try {
            const users = await loadUsers();
            renderUsersTable(list, users);
        } catch (e) {
            const msg = (e && e.payload && e.payload.error) ? e.payload.error : (e && e.message ? e.message : 'Error');
            if (list) list.innerHTML = `<div style="color:#dc2626">❌ No se pudo cargar usuarios: ${safeText(msg)}</div>`;
        }
    }

    async function initAdminUsers() {
        const tab = $('tab-admin-users');
        const content = $('admin-users');
        if (!tab || !content) return;

        // Ocultar por defecto. Se mostrará si el usuario tiene permiso.
        tab.classList.add('is-hidden');

        let me;
        try {
            me = await loadMe();
        } catch (e) {
            // Si no hay auth, el servidor redirige. No hacemos nada.
            return;
        }

        const perms = me && me.permissions ? me.permissions : [];
        const canAdmin = hasPerm(perms, 'admin.users');
        if (!canAdmin) {
            tab.classList.add('is-hidden');
            // Por si alguien abre manualmente el hash/tab, no mostramos info
            content.innerHTML = '<div class="card"><h2>Administración de Usuarios</h2><div style="color:#64748b">No tienes permisos para ver esta sección.</div></div>';
            return;
        }

        tab.classList.remove('is-hidden');

        // Cargar catálogo de permisos y renderizar checkboxes de creación
        const permsContainer = $('admin-new-permissions');
        try {
            clearBanner();
            setBanner('warn', 'Cargando permisos y usuarios...');

            const catalog = await loadPermissionsCatalog();
            renderPermissionCheckboxes(permsContainer, catalog, []);

            // Botón seleccionar todo
            const selectAllBtn = $('admin-perms-select-all');
            if (selectAllBtn && permsContainer) {
                selectAllBtn.addEventListener('click', () => {
                    const cbs = permsContainer.querySelectorAll('input[type="checkbox"][data-perm-key]');
                    const allChecked = Array.from(cbs).every(cb => cb.checked);
                    cbs.forEach(cb => { cb.checked = !allChecked; });
                });
            }

            // Form create
            const form = $('admin-create-user-form');
            if (form) {
                form.addEventListener('submit', async (ev) => {
                    ev.preventDefault();
                    try {
                        const username = safeText($('admin-new-username')?.value).trim();
                        const role = safeText($('admin-new-role')?.value || 'viewer');
                        const active = String($('admin-new-active')?.value || 'true') !== 'false';
                        const selectedPerms = readCheckedPerms(permsContainer);

                        if (!username) {
                            if (typeof global.showNotification === 'function') global.showNotification('⚠️ Usuario requerido', 'warning');
                            return;
                        }
                        setBanner('warn', `Creando usuario ${username}...`);
                        await fetchJSON('/api/admin/users', {
                            method: 'POST',
                            body: JSON.stringify({ username, role, permissions: selectedPerms, active })
                        });
                        setBanner('ok', `✅ Usuario creado: ${username}`);
                        if (typeof global.showNotification === 'function') global.showNotification(`✅ Usuario creado: ${username}`, 'success');

                        // Limpiar form
                        try { $('admin-new-username').value = ''; } catch (e) { /* noop */ }
                        try {
                            const cbs = permsContainer.querySelectorAll('input[type="checkbox"][data-perm-key]');
                            cbs.forEach(cb => cb.checked = false);
                        } catch (e) { /* noop */ }

                        await refreshUsers();
                    } catch (e) {
                        const msg = (e && e.payload && e.payload.error) ? e.payload.error : (e && e.message ? e.message : 'Error');
                        setBanner('err', `❌ No se pudo crear usuario: ${msg}`);
                        if (typeof global.showNotification === 'function') global.showNotification(`❌ No se pudo crear usuario: ${msg}`, 'error');
                    }
                });
            }

            const refreshBtn = $('admin-refresh-users');
            if (refreshBtn) refreshBtn.addEventListener('click', refreshUsers);

            await refreshUsers();
            clearBanner();

            // Inicializar handlers del modal de edición de permisos
            initEditPermsModalHandlers();
        } catch (e) {
            const msg = (e && e.payload && e.payload.error) ? e.payload.error : (e && e.message ? e.message : 'Error');
            setBanner('err', `❌ No se pudo cargar admin: ${msg}`);
        }

        // Cargar al entrar a la pestaña (por si cambió algo en otro lado)
        try {
            tab.addEventListener('click', () => {
                // Best-effort refresh
                refreshUsers();
            });
        } catch (e) { /* noop */ }
    }

    // Boot
    try {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initAdminUsers);
        } else {
            initAdminUsers();
        }
    } catch (e) {
        console.warn('[adminUsers] init failed', e);
    }

})(typeof window !== 'undefined' ? window : this);
