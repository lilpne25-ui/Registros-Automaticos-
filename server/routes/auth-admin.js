function registerAuthAdminRoutes(app, ctx) {
    const {
        fs,
        path,
        rootDir,
        AUTH_ENABLED,
        AUTH_REQUIRE_PASSWORD,
        AUTH_ADMIN_USER,
        PERMISSIONS,
        db,
        allSql,
        ensureAuthUsersTable,
        getUserRecordByUsername,
        normalizePermissionsArray,
        validateLogin,
        issueAuthToken,
        setAuthCookie,
        getAuthUserFromRequest,
        clearAuthCookie,
        requirePermission,
        runSql,
        pbkdf2HashPassword,
        loginBodySchema
    } = ctx;

    app.get('/', (req, res) => {
        try {
            if (AUTH_ENABLED) {
                const user = getAuthUserFromRequest(req);
                if (!user) return res.redirect('/login');
            }
        } catch (e) { /* noop */ }

        const mainPage = path.join(rootDir, 'public', 'sistema_de_grabado_laserv1.html');
        if (fs.existsSync(mainPage)) {
            res.sendFile(mainPage);
        } else {
            res.sendFile(path.join(rootDir, 'public', 'index.html'));
        }
    });

    app.get('/login', (req, res) => {
        const loginPage = path.join(rootDir, 'public', 'login.html');
        if (fs.existsSync(loginPage)) return res.sendFile(loginPage);
        return res.status(404).send('login.html not found');
    });

    app.post('/api/auth/login', (req, res) => {
        try {
            if (!AUTH_ENABLED) {
                return res.status(400).json({ error: 'Auth disabled' });
            }
            const parsed = loginBodySchema.safeParse(req.body || {});
            if (!parsed.success) {
                return res.status(400).json({ error: 'Credenciales invalidas' });
            }
            const username = parsed.data.username;
            const password = parsed.data.password;
            Promise.resolve(validateLogin(username, password)).then((result) => {
                if (!result || !result.ok) {
                    if (result && result.disabled) return res.status(403).json({ error: 'Usuario deshabilitado' });
                    return res.status(401).json({ error: AUTH_REQUIRE_PASSWORD ? 'Credenciales inválidas' : 'Usuario inválido' });
                }

                const token = issueAuthToken({
                    username: result.username,
                    role: result.role,
                    permissions: result.permissions
                });
                setAuthCookie(res, token);
                return res.json({ ok: true, username: result.username, role: result.role, permissions: result.permissions });
            }).catch((e) => {
                console.warn('login error', e);
                return res.status(500).json({ error: 'Login failed' });
            });
        } catch (e) {
            return res.status(500).json({ error: 'Login failed' });
        }
    });

    app.get('/api/auth/me', (req, res) => {
        try {
            if (!AUTH_ENABLED) {
                return res.json({ authenticated: true, username: null, role: null, permissions: ['*'], authDisabled: true });
            }
            const user = getAuthUserFromRequest(req);
            if (!user) return res.status(401).json({ authenticated: false });
            return res.json({ authenticated: true, username: user.username, role: user.role || 'viewer', permissions: normalizePermissionsArray(user.permissions) });
        } catch (e) {
            return res.status(500).json({ error: 'me failed' });
        }
    });

    app.get('/api/admin/permissions', requirePermission('admin.users'), (req, res) => {
        return res.json({ ok: true, permissions: PERMISSIONS });
    });

    app.get('/api/admin/users', requirePermission('admin.users'), async (req, res) => {
        try {
            const database = db.getDb();
            await ensureAuthUsersTable(database);
            const rows = await allSql(database, 'SELECT username, role, permissions_json, active, created_at, updated_at FROM auth_users ORDER BY username ASC', []);
            const users = (rows || []).map(r => {
                let perms = [];
                try { perms = JSON.parse(r.permissions_json || '[]'); } catch (e) { perms = []; }
                return {
                    username: r.username,
                    role: r.role || 'viewer',
                    permissions: normalizePermissionsArray(perms),
                    active: !!(r.active === 1 || r.active === '1' || r.active === true),
                    created_at: r.created_at,
                    updated_at: r.updated_at
                };
            });
            return res.json({ ok: true, users });
        } catch (e) {
            console.error('GET /api/admin/users error:', e);
            return res.status(500).json({ error: 'Failed to list users' });
        }
    });

    app.post('/api/admin/users', requirePermission('admin.users'), async (req, res) => {
        try {
            const body = req.body || {};
            const username = String(body.username || '').trim();
            const password = String(body.password || '');
            const role = String(body.role || 'viewer').trim() || 'viewer';
            const permissions = normalizePermissionsArray(body.permissions);
            const active = body.active === false ? 0 : 1;

            if (!username) return res.status(400).json({ error: 'username required' });
            if (username.length > 40) return res.status(400).json({ error: 'username too long' });
            if (AUTH_REQUIRE_PASSWORD && (!password || password.length < 4)) {
                return res.status(400).json({ error: 'password too short' });
            }

            const database = db.getDb();
            await ensureAuthUsersTable(database);
            const existing = await getUserRecordByUsername(database, username);
            if (existing) return res.status(409).json({ error: 'user already exists' });

            const seedPassword = AUTH_REQUIRE_PASSWORD ? password : (password || username || 'user');
            const hash = pbkdf2HashPassword(seedPassword);
            await runSql(
                database,
                'INSERT INTO auth_users (username, password_hash, role, permissions_json, active, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
                [username, hash, role, JSON.stringify(permissions), active]
            );
            return res.json({ ok: true });
        } catch (e) {
            console.error('POST /api/admin/users error:', e);
            return res.status(500).json({ error: 'Failed to create user' });
        }
    });

    app.put('/api/admin/users/:username', requirePermission('admin.users'), async (req, res) => {
        try {
            const username = String(req.params.username || '').trim();
            const body = req.body || {};
            const role = String(body.role || '').trim();
            const permissions = normalizePermissionsArray(body.permissions);
            const active = (body.active === false || body.active === 0 || body.active === '0') ? 0 : 1;

            if (!username) return res.status(400).json({ error: 'username required' });
            const database = db.getDb();
            await ensureAuthUsersTable(database);
            const existing = await getUserRecordByUsername(database, username);
            if (!existing) return res.status(404).json({ error: 'user not found' });

            await runSql(
                database,
                'UPDATE auth_users SET role = COALESCE(NULLIF(?, \'\'), role), permissions_json = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?',
                [role, JSON.stringify(permissions), active, username]
            );
            return res.json({ ok: true });
        } catch (e) {
            console.error('PUT /api/admin/users/:username error:', e);
            return res.status(500).json({ error: 'Failed to update user' });
        }
    });

    app.post('/api/admin/users/:username/reset-password', requirePermission('admin.users'), async (req, res) => {
        try {
            const username = String(req.params.username || '').trim();
            const body = req.body || {};
            const password = String(body.password || '');
            if (!username) return res.status(400).json({ error: 'username required' });
            if (AUTH_REQUIRE_PASSWORD && (!password || password.length < 4)) {
                return res.status(400).json({ error: 'password too short' });
            }

            const database = db.getDb();
            await ensureAuthUsersTable(database);
            const existing = await getUserRecordByUsername(database, username);
            if (!existing) return res.status(404).json({ error: 'user not found' });

            const seedPassword = AUTH_REQUIRE_PASSWORD ? password : (password || username || 'user');
            const hash = pbkdf2HashPassword(seedPassword);
            await runSql(
                database,
                'UPDATE auth_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?',
                [hash, username]
            );
            return res.json({ ok: true });
        } catch (e) {
            console.error('reset-password error:', e);
            return res.status(500).json({ error: 'Failed to reset password' });
        }
    });

    app.delete('/api/admin/users/:username', requirePermission('admin.users'), async (req, res) => {
        try {
            const username = String(req.params.username || '').trim();
            if (!username) return res.status(400).json({ error: 'username required' });
            if (username === AUTH_ADMIN_USER) return res.status(400).json({ error: 'cannot delete admin' });

            const database = db.getDb();
            await ensureAuthUsersTable(database);
            await runSql(database, 'DELETE FROM auth_users WHERE username = ?', [username]);
            return res.json({ ok: true });
        } catch (e) {
            console.error('DELETE /api/admin/users/:username error:', e);
            return res.status(500).json({ error: 'Failed to delete user' });
        }
    });

    app.post('/api/auth/logout', (req, res) => {
        try {
            if (!AUTH_ENABLED) return res.json({ ok: true, authDisabled: true });
            const user = getAuthUserFromRequest(req);
            if (user && user.token) {
                ctx.authTokens.delete(user.token);
            }
            clearAuthCookie(res);
            return res.json({ ok: true });
        } catch (e) {
            clearAuthCookie(res);
            return res.status(500).json({ error: 'logout failed' });
        }
    });
}

module.exports = { registerAuthAdminRoutes };
