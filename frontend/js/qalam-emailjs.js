/**
 * Qalam Aid — signup email OTP via EmailJS (browser SDK, public key only).
 */
const QALAM_EMAILJS_CONFIG = {
    publicKey: 'gBNmcyfW9SiT_8Exb',
    serviceId: 'service_s1jw7bj',
    templateId: 'template_cwjsq7n',
    companyName: 'Qalam Aid',
    otpMinutes: 15
};

const QALAM_OTP_STORAGE_KEY = 'qalam_signup_otp';

const QalamEmailJs = (function () {
    let initialized = false;

    function ensureEmailJs() {
        if (typeof emailjs === 'undefined') {
            throw new Error('Email service failed to load. Refresh the page and try again.');
        }
        if (!initialized) {
            emailjs.init({ publicKey: QALAM_EMAILJS_CONFIG.publicKey });
            initialized = true;
        }
    }

    function generateOtp() {
        return String(Math.floor(100000 + Math.random() * 900000));
    }

    function formatExpiryTime() {
        const d = new Date(Date.now() + QALAM_EMAILJS_CONFIG.otpMinutes * 60 * 1000);
        return d.toLocaleString('en-PK', {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function saveOtp(email, otp) {
        const payload = {
            email: String(email).trim().toLowerCase(),
            otp,
            expiresAt: Date.now() + QALAM_EMAILJS_CONFIG.otpMinutes * 60 * 1000
        };
        sessionStorage.setItem(QALAM_OTP_STORAGE_KEY, JSON.stringify(payload));
        return payload;
    }

    function loadOtp() {
        const raw = sessionStorage.getItem(QALAM_OTP_STORAGE_KEY);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    function clearSignupOtp() {
        sessionStorage.removeItem(QALAM_OTP_STORAGE_KEY);
    }

    async function sendSignupOtp(email) {
        const normalized = String(email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
            throw new Error('Enter a valid email before requesting a code.');
        }

        ensureEmailJs();
        const otp = generateOtp();
        const templateParams = {
            passcode: otp,
            time: formatExpiryTime(),
            email: normalized,
            to_email: normalized,
            user_email: normalized,
            company_name: QALAM_EMAILJS_CONFIG.companyName
        };

        await emailjs.send(
            QALAM_EMAILJS_CONFIG.serviceId,
            QALAM_EMAILJS_CONFIG.templateId,
            templateParams
        );

        saveOtp(normalized, otp);
        return { email: normalized, expiresMinutes: QALAM_EMAILJS_CONFIG.otpMinutes };
    }

    function verifySignupOtp(email, code) {
        const normalized = String(email).trim().toLowerCase();
        const entered = String(code || '').trim();
        if (!/^\d{6}$/.test(entered)) {
            return { ok: false, message: 'Enter the 6-digit code from your email.' };
        }

        const stored = loadOtp();
        if (!stored) {
            return { ok: false, message: 'No verification code found. Click “Send verification code” first.' };
        }
        if (stored.email !== normalized) {
            return {
                ok: false,
                message: 'This code was sent to a different email. Send a new code after updating your email.'
            };
        }
        if (Date.now() > stored.expiresAt) {
            clearSignupOtp();
            return { ok: false, message: 'Code expired. Request a new verification code.' };
        }
        if (stored.otp !== entered) {
            return { ok: false, message: 'Incorrect code. Check your email and try again.' };
        }

        clearSignupOtp();
        sessionStorage.setItem('qalam_signup_verified_' + normalized, String(Date.now()));
        return { ok: true };
    }

    function isEmailVerified(email) {
        const normalized = String(email).trim().toLowerCase();
        return Boolean(sessionStorage.getItem('qalam_signup_verified_' + normalized));
    }

    function clearEmailVerified(email) {
        const normalized = String(email).trim().toLowerCase();
        sessionStorage.removeItem('qalam_signup_verified_' + normalized);
        clearSignupOtp();
    }

    function hasPendingOtp(email) {
        const stored = loadOtp();
        if (!stored) return false;
        if (stored.email !== String(email).trim().toLowerCase()) return false;
        return Date.now() <= stored.expiresAt;
    }

    return {
        config: QALAM_EMAILJS_CONFIG,
        sendSignupOtp,
        verifySignupOtp,
        isEmailVerified,
        clearEmailVerified,
        clearSignupOtp,
        hasPendingOtp
    };
})();
