/**
 * Qalam Aid — shared auth helpers for login / signup pages
 */
const QalamAuth = (function () {
    const API_BASE = window.QALAM_API_BASE || window.location.origin;

    const ROLES = {
        student: {
            label: 'Student',
            icon: '🎓',
            dashboard: 'studentdashboard.html',
            storageEmailKey: 'studentEmail',
            headline: 'Continue your education',
            blurb: 'Track your scholarship application, verification status, and funding progress in one place.'
        },
        donor: {
            label: 'Donor',
            icon: '💚',
            dashboard: 'donordashboard.html',
            storageEmailKey: 'donorEmail',
            headline: 'Change a life today',
            blurb: 'Browse verified students, donate securely, and see transparent receipts for every contribution.'
        }
    };

    function normalizeRole(role) {
        return role === 'donor' ? 'donor' : 'student';
    }

    function getRoleFromUrl() {
        const params = new URLSearchParams(window.location.search);
        return normalizeRole(params.get('role') || '');
    }

    function saveSession(data, email) {
        const role = normalizeRole(data.role);
        localStorage.setItem('token', data.token);
        localStorage.setItem('userEmail', email);
        localStorage.setItem('userRole', role);
        localStorage.setItem('userName', data.name || '');
        const cfg = ROLES[role];
        if (cfg) localStorage.setItem(cfg.storageEmailKey, email);
        sessionStorage.setItem('qalam_last_role', role);
    }

    function redirectForRole(role) {
        const r = normalizeRole(role);
        if (r === 'admin') {
            window.location.href = 'admin.html';
            return;
        }
        const cfg = ROLES[r];
        window.location.href = cfg ? cfg.dashboard : 'home.html';
    }

    async function login(email, password, role) {
        const res = await fetch(`${API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, role: normalizeRole(role) })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || 'Login failed');
        return data;
    }

    async function signup(payload) {
        const res = await fetch(`${API_BASE}/api/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || 'Signup failed');
        return data;
    }

    function signupUrl(role) {
        return `signup.html?role=${normalizeRole(role)}`;
    }

    function loginUrl(role) {
        return `login.html?role=${normalizeRole(role)}`;
    }

    return {
        API_BASE,
        ROLES,
        normalizeRole,
        getRoleFromUrl,
        saveSession,
        redirectForRole,
        login,
        signup,
        signupUrl,
        loginUrl
    };
})();
