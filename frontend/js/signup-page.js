let role = 'student';
let otpSentForEmail = '';
let emailVerified = false;
let resendCooldownTimer = null;

function initRole() {
    const fromUrl = QalamAuth.getRoleFromUrl();
    const fromSession = sessionStorage.getItem('qalam_last_role');
    if (fromUrl === 'donor' || fromUrl === 'student') role = fromUrl;
    else if (fromSession === 'donor' || fromSession === 'student') role = fromSession;
    applyRoleUI();
}

function applyRoleUI() {
    const isStudent = role === 'student';
    const cfg = QalamAuth.ROLES[role];

    document.getElementById('cardStudent').classList.toggle('active', isStudent);
    document.getElementById('cardDonor').classList.toggle('active', !isStudent);
    document.getElementById('cardStudent').setAttribute('aria-pressed', isStudent);
    document.getElementById('cardDonor').setAttribute('aria-pressed', !isStudent);

    document.getElementById('studentPanel').classList.toggle('visible', isStudent);
    document.getElementById('donorPanel').classList.toggle('visible', !isStudent);

    document.getElementById('leftHeadline').innerHTML =
        isStudent ? 'Join as a <em>student</em>' : 'Join as a <em>donor</em>';
    document.getElementById('leftBlurb').textContent = cfg.blurb;
    document.getElementById('pageSub').textContent =
        isStudent ? 'Register as a student on Qalam Aid' : 'Register as a donor on Qalam Aid';
    document.getElementById('signupBtn').textContent = 'Create ' + cfg.label + ' Account';
    document.getElementById('loginLink').href = QalamAuth.loginUrl(role);
    document.getElementById('loginLink').textContent = 'Sign in as ' + cfg.label.toLowerCase();
}

function selectRole(r) {
    role = QalamAuth.normalizeRole(r);
    sessionStorage.setItem('qalam_last_role', role);
    applyRoleUI();
    hideAlert();
}

document.getElementById('cardStudent').addEventListener('click', () => selectRole('student'));
document.getElementById('cardDonor').addEventListener('click', () => selectRole('donor'));

document.querySelectorAll('.eye').forEach((btn) => {
    btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.textContent = show ? '\u{1F648}' : '\u{1F441}';
    });
});

document.getElementById('pwd').addEventListener('input', () => {
    const v = document.getElementById('pwd').value;
    const bar = document.getElementById('pwdBar');
    const hint = document.getElementById('pwdHint');
    let score = 0;
    if (v.length >= 8) score++;
    if (/[A-Z]/.test(v)) score++;
    if (/[0-9]/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    const colors = ['#e2e8f0', '#ef4444', '#f97316', '#eab308', '#22c55e'];
    const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
    bar.style.background = colors[score];
    bar.style.width = score * 25 + '%';
    hint.textContent = score > 0 ? 'Strength: ' + labels[score] : 'Use 8+ characters with letters and numbers';
    hint.style.color = colors[score];
});

function showAlert(msg, type) {
    const box = document.getElementById('alertBox');
    box.textContent = msg;
    box.className = 'alert ' + (type === 'error' ? 'err' : 'ok');
    box.style.display = 'block';
}

function hideAlert() {
    document.getElementById('alertBox').style.display = 'none';
}

function showErr(id, on) {
    document.getElementById(id).style.display = on ? 'block' : 'none';
}

function getEmail() {
    return document.getElementById('email').value.trim();
}

function showOtpPanel(show) {
    const panel = document.getElementById('otpPanel');
    panel.classList.toggle('visible', show);
    panel.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function resetEmailVerification() {
    emailVerified = false;
    otpSentForEmail = '';
    document.getElementById('otp').value = '';
    showOtpPanel(false);
    document.getElementById('otpStatus').textContent = '';
}

function syncEmailVerificationState() {
    const email = getEmail().toLowerCase();
    if (!email) {
        resetEmailVerification();
        return;
    }
    if (otpSentForEmail && otpSentForEmail !== email) {
        QalamEmailJs.clearEmailVerified(otpSentForEmail);
        resetEmailVerification();
    }
    emailVerified = QalamEmailJs.isEmailVerified(email);
    if (emailVerified) {
        showOtpPanel(true);
        document.getElementById('otpStatus').textContent = 'Email verified. You can create your account.';
        document.getElementById('otpStatus').className = 'otp-status verified';
    } else if (QalamEmailJs.hasPendingOtp(email)) {
        showOtpPanel(true);
    }
}

document.getElementById('email').addEventListener('input', () => {
    const email = getEmail().toLowerCase();
    if (otpSentForEmail && email !== otpSentForEmail) {
        QalamEmailJs.clearEmailVerified(otpSentForEmail);
        resetEmailVerification();
    }
});

document.getElementById('email').addEventListener('change', syncEmailVerificationState);

function validateEmailOnly() {
    const email = getEmail();
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    showErr('emailErr', !ok);
    if (!ok) showAlert('Enter a valid email before requesting a code.', 'error');
    return ok ? email : null;
}

async function checkEmailAvailable(email) {
    try {
        const res = await fetch(
            `${QalamAuth.API_BASE}/api/auth/check-email?email=${encodeURIComponent(email)}`
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || 'Could not check email');
        if (!data.available) {
            throw new Error('This email is already registered. Please sign in instead.');
        }
    } catch (err) {
        if (err.message.includes('already registered')) throw err;
        // If backend is down, still allow OTP send (signup will fail later with clear message)
    }
}

function startResendCooldown(seconds) {
    const btn = document.getElementById('sendOtpBtn');
    let left = seconds;
    btn.disabled = true;
    btn.textContent = 'Resend in ' + left + 's';
    if (resendCooldownTimer) clearInterval(resendCooldownTimer);
    resendCooldownTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
            clearInterval(resendCooldownTimer);
            resendCooldownTimer = null;
            btn.disabled = false;
            btn.textContent = otpSentForEmail ? 'Resend code' : 'Send code';
            return;
        }
        btn.textContent = 'Resend in ' + left + 's';
    }, 1000);
}

document.getElementById('sendOtpBtn').addEventListener('click', async () => {
    const email = validateEmailOnly();
    if (!email) return;

    const btn = document.getElementById('sendOtpBtn');
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending...';
    hideAlert();

    try {
        await checkEmailAvailable(email);
        await QalamEmailJs.sendSignupOtp(email);
        otpSentForEmail = email.toLowerCase();
        emailVerified = false;
        showOtpPanel(true);
        document.getElementById('otp').focus();
        document.getElementById('otpStatus').textContent =
            'Code sent to ' + email + '. Valid for ' + QalamEmailJs.config.otpMinutes + ' minutes.';
        document.getElementById('otpStatus').className = 'otp-status';
        showAlert('Verification code sent. Check your inbox (and spam folder).', 'ok');
        startResendCooldown(60);
    } catch (err) {
        showAlert(err.message || 'Could not send verification email.', 'error');
        btn.disabled = false;
        btn.textContent = prevLabel;
    }
});

function validate() {
    const name = document.getElementById('name').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const email = getEmail();
    const pwd = document.getElementById('pwd').value;
    const pwd2 = document.getElementById('pwd2').value;

    ['nameErr', 'phoneErr', 'emailErr', 'pwdErr', 'pwd2Err', 'uniErr', 'regErr', 'progErr', 'semErr', 'otpErr'].forEach((id) => {
        showErr(id, false);
    });

    let ok = true;
    if (name.length < 3) { showErr('nameErr', true); ok = false; }
    if (!/^03\d{9}$/.test(phone)) { showErr('phoneErr', true); ok = false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('emailErr', true); ok = false; }
    if (pwd.length < 8) { showErr('pwdErr', true); ok = false; }
    if (pwd !== pwd2) { showErr('pwd2Err', true); ok = false; }

    if (role === 'student') {
        if (!document.getElementById('uniName').value.trim()) { showErr('uniErr', true); ok = false; }
        if (!document.getElementById('regNum').value.trim()) { showErr('regErr', true); ok = false; }
        if (!document.getElementById('program').value) { showErr('progErr', true); ok = false; }
        if (!document.getElementById('semester').value.trim()) { showErr('semErr', true); ok = false; }
    }

    if (!ok) showAlert('Please fix the highlighted fields.', 'error');
    return ok ? { name, phone, email, pwd } : null;
}

function ensureEmailVerified(email) {
    if (QalamEmailJs.isEmailVerified(email)) {
        emailVerified = true;
        return true;
    }

    if (!otpSentForEmail || otpSentForEmail !== email.toLowerCase()) {
        showAlert('Click “Send code” to verify your email before signing up.', 'error');
        showOtpPanel(true);
        return false;
    }

    const code = document.getElementById('otp').value.trim();
    if (!/^\d{6}$/.test(code)) {
        showErr('otpErr', true);
        showAlert('Enter the 6-digit verification code from your email.', 'error');
        showOtpPanel(true);
        return false;
    }

    const result = QalamEmailJs.verifySignupOtp(email, code);
    if (!result.ok) {
        showErr('otpErr', true);
        showAlert(result.message, 'error');
        return false;
    }

    emailVerified = true;
    document.getElementById('otpStatus').textContent = 'Email verified.';
    document.getElementById('otpStatus').className = 'otp-status verified';
    return true;
}

document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const base = validate();
    if (!base) return;

    if (!ensureEmailVerified(base.email)) return;

    const btn = document.getElementById('signupBtn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Creating account...';
    hideAlert();

    const payload = {
        name: base.name,
        phone: base.phone,
        email: base.email,
        password: base.pwd,
        role
    };

    if (role === 'student') {
        payload.universityName = document.getElementById('uniName').value.trim();
        payload.registrationNumber = document.getElementById('regNum').value.trim();
        payload.program = document.getElementById('program').value;
        payload.semester = document.getElementById('semester').value.trim();
    } else {
        payload.city = document.getElementById('city').value.trim();
    }

    try {
        await QalamAuth.signup(payload);
        const loginResult = await QalamAuth.login(base.email, base.pwd, role);
        QalamAuth.saveSession(loginResult, base.email);
        QalamEmailJs.clearEmailVerified(base.email);
        showAlert('Account created! Redirecting to your dashboard...', 'ok');
        setTimeout(() => QalamAuth.redirectForRole(role), 800);
    } catch (err) {
        showAlert(err.message || 'Signup failed', 'error');
        btn.disabled = false;
        btn.textContent = label;
    }
});

document.getElementById('otp').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    showErr('otpErr', false);
});

initRole();
syncEmailVerificationState();
