const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const db         = require('./db');
require('dotenv').config({ override: false });

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create uploads folder automatically
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Upload to memory — file bytes are saved in MySQL (application_documents.file_data)
const UPLOAD_MAX_FILE_MB = 25;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: UPLOAD_MAX_FILE_MB * 1024 * 1024,
        files: 5
    }
});

function handleUpload(fieldName, maxCount) {
    return (req, res, next) => {
        upload.array(fieldName, maxCount)(req, res, (err) => {
            if (!err) return next();
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    message: `Each file must be ${UPLOAD_MAX_FILE_MB} MB or smaller. Compress PDFs/images and try again.`
                });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ message: 'Maximum 5 documents allowed.' });
            }
            return res.status(400).json({ message: err.message || 'Upload failed' });
        });
    };
}

const MIME_BY_EXT = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

function parseDocFilenames(docPath) {
    if (!docPath || !String(docPath).trim()) return [];
    return String(docPath).split(',').map((s) => s.trim()).filter(Boolean);
}

function safeBasename(name) {
    const base = path.basename(String(name || ''));
    if (!base || base === '.' || base === '..' || base.includes('..')) return null;
    return base;
}

function resolveUploadPath(filename) {
    const safe = safeBasename(filename);
    if (!safe) return null;
    const full = path.join(UPLOADS_DIR, safe);
    if (path.dirname(path.resolve(full)) !== path.resolve(UPLOADS_DIR)) return null;
    return { safe, full };
}

async function ensureDocumentsTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS application_documents (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            application_id INT UNSIGNED NOT NULL,
            original_name VARCHAR(512) NOT NULL,
            stored_name VARCHAR(255) NOT NULL,
            mime_type VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
            file_size INT UNSIGNED NOT NULL DEFAULT 0,
            file_data LONGBLOB NOT NULL,
            uploaded_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_app_docs_application (application_id),
            CONSTRAINT fk_app_docs_application FOREIGN KEY (application_id)
                REFERENCES applications (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

async function applicationExists(applicationId) {
    const [rows] = await db.query('SELECT id FROM applications WHERE id = ?', [applicationId]);
    return rows.length > 0;
}

async function getApplicationDocFilenames(applicationId) {
    const [rows] = await db.query('SELECT doc_path FROM applications WHERE id = ?', [applicationId]);
    if (rows.length === 0) return null;
    return parseDocFilenames(rows[0].doc_path);
}

async function saveApplicationDocuments(applicationId, files) {
    const storedNames = [];
    if (!files || !files.length) return storedNames;

    for (const file of files) {
        if (!file.buffer || !file.buffer.length) continue;
        const ext = path.extname(file.originalname || '').toLowerCase();
        const mime = file.mimetype || MIME_BY_EXT[ext] || 'application/octet-stream';
        const storedName = crypto.randomUUID() + ext;
        await db.query(
            `INSERT INTO application_documents
             (application_id, original_name, stored_name, mime_type, file_size, file_data)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                applicationId,
                file.originalname || 'document' + ext,
                storedName,
                mime,
                file.size,
                file.buffer
            ]
        );
        storedNames.push(storedName);
    }
    return storedNames;
}

async function importLegacyDocumentsFromDisk(applicationId) {
    const [countRows] = await db.query(
        'SELECT COUNT(*) AS c FROM application_documents WHERE application_id = ?',
        [applicationId]
    );
    if (Number(countRows[0].c) > 0) return;

    const filenames = await getApplicationDocFilenames(applicationId);
    if (!filenames || !filenames.length) return;

    for (const name of filenames) {
        const resolved = resolveUploadPath(name);
        if (!resolved || !fs.existsSync(resolved.full)) continue;
        const buffer = fs.readFileSync(resolved.full);
        const ext = path.extname(resolved.safe).toLowerCase();
        const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
        await db.query(
            `INSERT INTO application_documents
             (application_id, original_name, stored_name, mime_type, file_size, file_data)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [applicationId, resolved.safe, resolved.safe, mime, buffer.length, buffer]
        );
    }
}

async function listApplicationDocuments(applicationId) {
    if (!(await applicationExists(applicationId))) return null;

    await importLegacyDocumentsFromDisk(applicationId);

    const [docs] = await db.query(
        `SELECT id, original_name AS originalName, stored_name AS storedName,
                mime_type AS mimeType, file_size AS size, uploaded_at AS uploadedAt
         FROM application_documents
         WHERE application_id = ?
         ORDER BY id ASC`,
        [applicationId]
    );

    return docs.map((doc, index) => {
        const ext = path.extname(doc.originalName || doc.storedName || '').toLowerCase();
        return {
            id: doc.id,
            filename: doc.storedName,
            originalName: doc.originalName,
            label: doc.originalName || ('Document ' + (index + 1) + ext),
            extension: ext,
            size: doc.size,
            mimeType: doc.mimeType,
            uploadedAt: doc.uploadedAt,
            missing: false
        };
    });
}

async function getDocumentById(documentId) {
    const [rows] = await db.query(
        `SELECT id, application_id AS applicationId, original_name AS originalName,
                stored_name AS storedName, mime_type AS mimeType, file_size AS fileSize, file_data AS fileData
         FROM application_documents WHERE id = ?`,
        [documentId]
    );
    return rows.length ? rows[0] : null;
}

function getBaseUrl() {
    return process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function getVerificationByToken(token) {
    if (!token) return null;
    const [rows] = await db.query(
        `SELECT vt.id AS vtId, vt.application_id AS applicationId, vt.token, vt.used, vt.expires_at AS expiresAt,
                a.status AS applicationStatus,
                u.name AS fullName, u.email AS studentEmail,
                s.id AS studentId, s.reg_number AS registrationNumber,
                s.university_name AS universityName, s.department AS program,
                s.semester AS currentSemester, s.cgpa, s.status AS studentStatus,
                a.amount_needed AS semesterFee, s.priority_level AS priorityLevel
         FROM verification_tokens vt
         JOIN applications a ON a.id = vt.application_id
         JOIN students s ON s.id = a.student_id
         JOIN users u ON u.id = s.user_id
         WHERE vt.token = ?`,
        [token]
    );
    return rows.length ? rows[0] : null;
}

async function applyUniversityDecision(token, decision) {
    const row = await getVerificationByToken(token);
    if (!row) return { ok: false, code: 'invalid', message: 'Link invalid or expired.' };
    if (row.used) {
        return {
            ok: false,
            code: 'used',
            message: 'This application was already reviewed.',
            status: row.applicationStatus
        };
    }
    if (new Date(row.expiresAt) <= new Date()) {
        return { ok: false, code: 'expired', message: 'This verification link has expired.' };
    }

    const isAccept = decision === 'accept';
    const newStatus = isAccept ? 'verified' : 'rejected';

    await db.query(`UPDATE verification_tokens SET used = true WHERE token = ?`, [token]);
    await db.query(`UPDATE applications SET status = ? WHERE id = ?`, [newStatus, row.applicationId]);
    await db.query(`UPDATE students SET status = ? WHERE id = ?`, [newStatus, row.studentId]);

    return {
        ok: true,
        decision,
        status: newStatus,
        fullName: row.fullName,
        registrationNumber: row.registrationNumber
    };
}

function verificationDecideUrl(token, decision, confirm) {
    let url = `${getBaseUrl()}/api/verify/decide?token=${encodeURIComponent(token)}&decision=${decision}`;
    if (confirm) url += '&confirm=yes';
    return url;
}

function renderRejectConfirmPage(token, row) {
    const confirmUrl = verificationDecideUrl(token, 'reject', true);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirm Reject — Qalam Aid</title>
<style>
  body{font-family:Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;text-align:center;}
  .card{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;}
  h1{color:#dc2626;font-size:1.3rem;}
  .btn{display:inline-block;margin:8px;padding:14px 28px;font-weight:700;text-decoration:none;border-radius:8px;color:#fff;}
  .yes{background:#dc2626;}
  .no{background:#64748b;}
</style></head><body><div class="card">
  <h1>Reject this application?</h1>
  <p>Student: <strong>${escapeHtml(row?.fullName || '')}</strong><br>
  Reg: ${escapeHtml(row?.registrationNumber || '')}</p>
  <p>This will mark the student as <strong>not approved</strong> on Qalam Aid.</p>
  <p>
    <a class="btn yes" href="${confirmUrl}">Yes, reject application</a><br>
    <a class="btn no" href="${getBaseUrl()}/api/verify?token=${encodeURIComponent(token)}">Go back</a>
  </p>
</div></body></html>`;
}

function renderVerificationPage(row) {
    const base = getBaseUrl();
    const acceptUrl = verificationDecideUrl(row.token, 'accept');
    const rejectUrl = verificationDecideUrl(row.token, 'reject');
    const rows = [
        ['Full Name', row.fullName],
        ['Registration No.', row.registrationNumber],
        ['Program', row.program],
        ['Semester', row.currentSemester],
        ['CGPA', row.cgpa],
        ['University', row.universityName],
        ['Fee Amount Needed', 'PKR ' + row.semesterFee],
        ['Priority Level', row.priorityLevel]
    ];
    const tableRows = rows.map((r, i) => `
        <tr style="background:${i % 2 ? '#fff' : '#f0fdf4'};">
            <td style="padding:10px;border:1px solid #ddd;font-weight:bold;width:40%;">${escapeHtml(r[0])}</td>
            <td style="padding:10px;border:1px solid #ddd;">${escapeHtml(r[1])}</td>
        </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify Student — Qalam Aid</title>
<style>
  body{font-family:Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#0f172a;}
  .card{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.08);}
  h1{color:#065f46;font-size:1.4rem;margin:0 0 8px;}
  .sub{color:#64748b;font-size:14px;margin:0 0 20px;}
  table{width:100%;border-collapse:collapse;margin:16px 0;}
  .actions{display:flex;flex-wrap:wrap;gap:16px;margin-top:28px;justify-content:center;}
  .btn{display:inline-block;font-size:16px;font-weight:700;padding:16px 28px;text-decoration:none;border-radius:10px;color:#fff !important;min-width:200px;text-align:center;}
  .accept{background:#065f46;}
  .reject{background:#dc2626;}
  .note{font-size:12px;color:#64748b;margin-top:24px;text-align:center;}
</style></head><body>
<div class="card">
  <h1>Student enrollment verification</h1>
  <p class="sub">Qalam Aid — please confirm whether this student is enrolled at your institution.</p>
  <table>${tableRows}</table>
  <p style="text-align:center;font-weight:600;margin-top:20px;">Choose one:</p>
  <div class="actions">
    <a href="${acceptUrl}" class="btn accept">✅ Accept<br><span style="font-size:12px;font-weight:400;">Confirm enrollment</span></a>
    <a href="${rejectUrl}" class="btn reject">❌ Reject<br><span style="font-size:12px;font-weight:400;">Not enrolled</span></a>
  </div>
  <p class="note">This link expires in 48 hours. Your decision is final for this application.</p>
</div></body></html>`;
}

function renderVerificationResult(result) {
    if (result.ok) {
        const isAccept = result.decision === 'accept';
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Qalam Aid</title></head>
<body style="font-family:Arial;text-align:center;padding:48px 24px;background:#f8fafc;">
  <div style="max-width:480px;margin:0 auto;background:#fff;padding:32px;border-radius:12px;">
    <h2 style="color:${isAccept ? '#065f46' : '#dc2626'};">
      ${isAccept ? '✅ Student accepted' : '❌ Student rejected'}
    </h2>
    <p><strong>${escapeHtml(result.fullName)}</strong> (${escapeHtml(result.registrationNumber)})</p>
    <p>${isAccept
        ? 'Enrollment confirmed. This student may appear to donors on Qalam Aid after admin review.'
        : 'Enrollment not confirmed. This application will not be shown to donors.'}</p>
    <p style="color:#888;font-size:13px;margin-top:24px;">You may close this window.</p>
  </div></body></html>`;
    }
    if (result.code === 'used') {
        const st = result.status === 'verified' ? 'accepted' : (result.status === 'rejected' ? 'rejected' : result.status);
        return `<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:48px;">
          <h2>Already reviewed</h2><p>This application was already marked as <strong>${escapeHtml(st)}</strong>.</p></body></html>`;
    }
    return `<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:48px;">
      <h2 style="color:#dc2626;">❌ ${escapeHtml(result.message)}</h2>
      <p>Please contact Qalam Aid for assistance.</p></body></html>`;
}

// ── Email helper (Gmail SMTP) ─────────────────────────────────
let mailTransporter = null;

function getEmailCredentials() {
    const user = String(process.env.EMAIL_USER || '').trim();
    const pass = String(process.env.EMAIL_PASS || '').replace(/\s+/g, '');
    return { user, pass };
}

function createMailTransporter() {
    const nodemailer = require('nodemailer');
    const { user, pass } = getEmailCredentials();
    return nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user, pass },
        pool: false,
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        connectionTimeout: 60000,
        greetingTimeout: 30000,
        socketTimeout: 120000
    });
}

function getMailTransporter() {
    if (!mailTransporter) mailTransporter = createMailTransporter();
    return mailTransporter;
}

function resetMailTransporter() {
    if (mailTransporter && mailTransporter.close) {
        mailTransporter.close().catch(() => {});
    }
    mailTransporter = null;
}

async function verifyMailConnection() {
    const { user, pass } = getEmailCredentials();
    if (!user || !pass || pass === 'your_16_char_app_password') {
        return { ok: false, error: 'EMAIL_USER / EMAIL_PASS not set in .env' };
    }
    try {
        const t = createMailTransporter();
        await t.verify();
        mailTransporter = t;
        return { ok: true };
    } catch (err) {
        resetMailTransporter();
        return { ok: false, error: err.message };
    }
}

async function sendEmail(to, subject, html, options = {}) {
    const { attachments = [], throwOnError = false } = options;
    const { user, pass } = getEmailCredentials();

    if (!user || !pass || pass === 'your_16_char_app_password') {
        const msg = 'Email not configured (set EMAIL_USER and EMAIL_PASS in .env)';
        console.log(`📧 Email skipped → To: ${to} | Subject: ${subject}`);
        if (throwOnError) throw new Error(msg);
        return { sent: false, error: msg };
    }

    const totalAttachMb = attachments.reduce((sum, a) => sum + (a.content?.length || 0), 0) / (1024 * 1024);
    if (totalAttachMb > 22) {
        const msg = `Attachments too large (${totalAttachMb.toFixed(1)} MB). Gmail limit is ~25 MB total.`;
        console.log(`⚠️ ${msg}`);
        if (throwOnError) throw new Error(msg);
        return { sent: false, error: msg };
    }

    const mailOptions = {
        from: `"Qalam Aid" <${user}>`,
        to,
        subject,
        html,
        attachments
    };

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await getMailTransporter().sendMail(mailOptions);
            console.log(`✅ Email sent to ${to}` + (attachments.length ? ` (${attachments.length} attachment(s))` : ''));
            return { sent: true };
        } catch (err) {
            lastError = err;
            const retryable = /socket|timeout|ECONNRESET|ETIMEDOUT|closed/i.test(err.message);
            if (attempt < 2 && retryable) {
                console.log(`⚠️ Email attempt ${attempt} failed (${err.message}), retrying…`);
                resetMailTransporter();
                await new Promise((r) => setTimeout(r, 1500));
                continue;
            }
            break;
        }
    }

    console.log(`⚠️ Email failed: ${lastError.message}`);
    if (throwOnError) throw lastError;
    return { sent: false, error: lastError.message };
}

function buildUniversityVerificationHtml(data) {
    const {
        fullName, registrationNumber, program, currentSemester, cgpa,
        semesterFee, priorityLevel, verifyLink, acceptLink, rejectLink, attachmentCount
    } = data;
    const docNote = attachmentCount > 0
        ? `<p style="background:#f0fdf4;padding:12px;border-radius:8px;color:#065f46;">
            <strong>${attachmentCount}</strong> supporting document(s) are attached to this email for your review.
           </p>`
        : `<p style="color:#64748b;font-size:14px;"><em>No supporting documents were attached to this application.</em></p>`;

    return `
            <div style="font-family:Arial;max-width:600px;margin:auto;">
                <h2 style="color:#065f46;">Student Enrollment Verification</h2>
                <p>Dear Registrar,</p>
                <p>A student has applied for financial aid on <strong>Qalam Aid</strong>. Please verify their enrollment:</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                    <tr style="background:#f0fdf4;">
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Full Name</td>
                        <td style="padding:10px;border:1px solid #ddd;">${fullName}</td>
                    </tr>
                    <tr>
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Registration No.</td>
                        <td style="padding:10px;border:1px solid #ddd;">${registrationNumber}</td>
                    </tr>
                    <tr style="background:#f0fdf4;">
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Program</td>
                        <td style="padding:10px;border:1px solid #ddd;">${program}</td>
                    </tr>
                    <tr>
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Semester</td>
                        <td style="padding:10px;border:1px solid #ddd;">${currentSemester}</td>
                    </tr>
                    <tr style="background:#f0fdf4;">
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">CGPA</td>
                        <td style="padding:10px;border:1px solid #ddd;">${cgpa}</td>
                    </tr>
                    <tr>
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Fee Amount Needed</td>
                        <td style="padding:10px;border:1px solid #ddd;">PKR ${semesterFee}</td>
                    </tr>
                    <tr style="background:#f0fdf4;">
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Priority Level</td>
                        <td style="padding:10px;border:1px solid #ddd;">${priorityLevel}</td>
                    </tr>
                </table>
                ${docNote}
                <p>Please verify this student's enrollment on Qalam Aid:</p>
                <p style="margin:20px 0;">
                    <a href="${verifyLink}" style="display:inline-block;background:#065f46;color:white;padding:14px 24px;text-decoration:none;border-radius:8px;font-size:15px;margin:6px 8px 6px 0;">
                        Open verification page
                    </a>
                </p>
                <p style="margin:16px 0;font-size:14px;color:#334155;"><strong>Quick response:</strong></p>
                <a href="${acceptLink}" style="display:inline-block;background:#065f46;color:white;padding:12px 22px;text-decoration:none;border-radius:8px;font-size:14px;margin:4px 8px 4px 0;">✅ Accept</a>
                <a href="${rejectLink}" style="display:inline-block;background:#dc2626;color:white;padding:12px 22px;text-decoration:none;border-radius:8px;font-size:14px;margin:4px 8px 4px 0;">❌ Reject</a>
                <p style="color:#888;font-size:13px;margin-top:20px;">This link expires in 48 hours.</p>
                <p>Regards,<br><strong>Qalam Aid Team</strong></p>
            </div>
            `;
}

async function getDocumentAttachmentsForApplication(applicationId) {
    await importLegacyDocumentsFromDisk(applicationId);
    const [rows] = await db.query(
        `SELECT original_name, mime_type, file_data
         FROM application_documents WHERE application_id = ?`,
        [applicationId]
    );
    return rows.map((r) => ({
        filename: safeBasename(r.original_name) || 'document',
        content: Buffer.from(r.file_data),
        contentType: r.mime_type || 'application/octet-stream'
    }));
}

async function sendUniversityVerificationEmail(applicationId) {
    const [rows] = await db.query(
        `SELECT a.id, a.amount_needed AS semesterFee,
                u.name AS fullName, s.reg_number AS registrationNumber,
                s.university_email AS universityEmail, s.department AS program,
                s.semester AS currentSemester, s.cgpa, s.priority_level AS priorityLevel
         FROM applications a
         JOIN students s ON s.id = a.student_id
         JOIN users u ON u.id = s.user_id
         WHERE a.id = ?`,
        [applicationId]
    );
    if (rows.length === 0) throw new Error('Application not found');

    const app = rows[0];
    const universityEmail = String(app.universityEmail || '').trim();
    if (!universityEmail) throw new Error('No university email on this application.');

    const [tokens] = await db.query(
        `SELECT token FROM verification_tokens
         WHERE application_id = ? AND used = false AND expires_at > NOW()
         ORDER BY id DESC LIMIT 1`,
        [applicationId]
    );

    let token = tokens[0]?.token;
    if (!token) {
        token = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
        await db.query(
            `INSERT INTO verification_tokens (application_id, token, expires_at, used)
             VALUES (?, ?, ?, false)`,
            [applicationId, token, expiresAt]
        );
    }

    const verifyLink = `${getBaseUrl()}/api/verify?token=${token}`;
    const acceptLink = verificationDecideUrl(token, 'accept');
    const rejectLink = verificationDecideUrl(token, 'reject');
    const attachments = await getDocumentAttachmentsForApplication(applicationId);
    const html = buildUniversityVerificationHtml({
        fullName: app.fullName,
        registrationNumber: app.registrationNumber,
        program: app.program,
        currentSemester: app.currentSemester,
        cgpa: app.cgpa,
        semesterFee: app.semesterFee,
        priorityLevel: app.priorityLevel,
        verifyLink,
        acceptLink,
        rejectLink,
        attachmentCount: attachments.length
    });

    const result = await sendEmail(
        universityEmail,
        'Student Enrollment Verification – Qalam Aid',
        html,
        { attachments, throwOnError: true }
    );

    if (!result.sent) throw new Error(result.error || 'Failed to send email');

    return {
        to: universityEmail,
        attachmentCount: attachments.length,
        verifyLink
    };
}

// ── Test route ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ ok: true, message: 'Qalam Aid backend is running!' });
});

// ── Scholarship application route ───────────────────────────
app.post('/api/apply', handleUpload('documents', 5), async (req, res) => {

    const {
        fullName, email, cnic, phone, age,
        universityName, hecRecognized, registrationNumber,
        program, currentSemester, semestersCompleted,
        cgpa, backlogs, semesterFee, otherScholarship,
        familyIncome, guardianStatus, familyMembers,
        studyingSiblings, jobStatus, gender, areaType,
        scholarshipReason, universityEmail, priorityLevel
    } = req.body;

    try {
      // 1 — Check if user already exists, if yes reuse their account
let userId;
const [existingUser] = await db.query(
    'SELECT id FROM users WHERE email = ?', [email]
);

if (existingUser.length > 0) {
    // User already exists — reuse their ID
    userId = existingUser[0].id;
} else {
    // New user — create account
    const [userResult] = await db.query(
        `INSERT INTO users (name, email, password_hash, role, phone)
         VALUES (?, ?, ?, 'student', ?)`,
        [fullName, email, cnic, phone]
    );
    userId = userResult.insertId;
}

// 2 — Check if student profile exists, if yes reuse it
let studentId;
const [existingStudent] = await db.query(
    'SELECT id FROM students WHERE user_id = ?', [userId]
);

if (existingStudent.length > 0) {
    // Update existing student profile
    studentId = existingStudent[0].id;
    await db.query(
        `UPDATE students SET
         reg_number = ?, university_email = ?, university_name = ?,
         department = ?, semester = ?, status = 'pending',
         age = ?, cgpa = ?, gender = ?, area_type = ?,
         guardian_status = ?, family_income = ?, family_members = ?,
         studying_siblings = ?, job_status = ?, backlogs = ?,
         semesters_completed = ?, hec_recognized = ?,
         other_scholarship = ?, priority_level = ?
         WHERE id = ?`,
        [
            registrationNumber, universityEmail, universityName,
            program, currentSemester,
            age, cgpa, gender, areaType,
            guardianStatus, familyIncome, familyMembers,
            studyingSiblings, jobStatus, backlogs,
            semestersCompleted, hecRecognized,
            otherScholarship, priorityLevel,
            studentId
        ]
    );
} else {
    // New student profile
    const [studentResult] = await db.query(
        `INSERT INTO students
          (user_id, reg_number, university_email, university_name,
           department, semester, status,
           age, cgpa, gender, area_type, guardian_status,
           family_income, family_members, studying_siblings,
           job_status, backlogs, semesters_completed,
           hec_recognized, other_scholarship, priority_level)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            userId, registrationNumber, universityEmail, universityName,
            program, currentSemester, 'pending',
            age, cgpa, gender, areaType, guardianStatus,
            familyIncome, familyMembers, studyingSiblings,
            jobStatus, backlogs, semestersCompleted,
            hecRecognized, otherScholarship, priorityLevel
        ]
    );
    studentId = studentResult.insertId;
}

        // 3 — Save to applications table
        const [appResult] = await db.query(
            `INSERT INTO applications
              (student_id, amount_needed, reason, doc_path, status)
             VALUES (?, ?, ?, '', 'pending')`,
            [studentId, semesterFee, scholarshipReason]
        );
        const applicationId = appResult.insertId;

        // 4 — Store uploaded documents in database (BLOB)
        const storedNames = await saveApplicationDocuments(applicationId, req.files || []);
        if (storedNames.length) {
            await db.query(
                'UPDATE applications SET doc_path = ? WHERE id = ?',
                [storedNames.join(','), applicationId]
            );
        }

        // 5 — Generate verification token (48 hours expiry)
        const token     = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

        await db.query(
            `INSERT INTO verification_tokens
              (application_id, token, expires_at, used)
             VALUES (?, ?, ?, false)`,
            [applicationId, token, expiresAt]
        );

        // 6 — Email university with verification link + document attachments
        try {
            const mail = await sendUniversityVerificationEmail(applicationId);
            console.log(`✅ University email → ${mail.to} (${mail.attachmentCount} file(s))`);
        } catch (mailErr) {
            console.log(`⚠️ University email failed (application saved): ${mailErr.message}`);
        }

        res.json({ message: 'Application submitted successfully!' });

    } catch (err) {
        console.error('APPLY ERROR:', err.message);
        res.status(500).json({ message: 'Something went wrong: ' + err.message });
    }
});

// ── University verification (accept / reject) ─────────────────
app.get('/api/verify', async (req, res) => {
    const token = String(req.query.token || '').trim();
    try {
        const row = await getVerificationByToken(token);
        if (!row) {
            return res.status(404).send(renderVerificationResult({
                ok: false,
                code: 'invalid',
                message: 'Link invalid or expired'
            }));
        }
        if (row.used) {
            return res.send(renderVerificationResult({
                ok: false,
                code: 'used',
                message: 'Already reviewed',
                status: row.applicationStatus
            }));
        }
        if (new Date(row.expiresAt) <= new Date()) {
            return res.send(renderVerificationResult({
                ok: false,
                code: 'expired',
                message: 'Link expired'
            }));
        }
        res.send(renderVerificationPage(row));
    } catch (err) {
        console.error('VERIFY PAGE ERROR:', err.message);
        res.status(500).send('<h2>Something went wrong. Please try again.</h2>');
    }
});

async function handleVerifyDecision(req, res) {
    const token = String(req.query.token || req.body?.token || '').trim();
    const decision = String(req.query.decision || req.body?.decision || '').trim().toLowerCase();
    const confirm = String(req.query.confirm || '').toLowerCase() === 'yes';

    if (!['accept', 'reject'].includes(decision)) {
        return res.status(400).send(renderVerificationResult({
            ok: false,
            code: 'invalid',
            message: 'Invalid decision'
        }));
    }

    try {
        if (decision === 'reject' && !confirm) {
            const row = await getVerificationByToken(token);
            if (!row || row.used || new Date(row.expiresAt) <= new Date()) {
                return res.send(renderVerificationResult(
                    !row ? { ok: false, code: 'invalid', message: 'Link invalid or expired' }
                        : row.used ? { ok: false, code: 'used', message: 'Already reviewed', status: row.applicationStatus }
                        : { ok: false, code: 'expired', message: 'Link expired' }
                ));
            }
            return res.send(renderRejectConfirmPage(token, row));
        }

        const result = await applyUniversityDecision(token, decision);
        console.log(
            result.ok
                ? `✅ University ${decision}ed: ${result.fullName} (${result.registrationNumber})`
                : `⚠️ University verify: ${result.message}`
        );
        res.send(renderVerificationResult(result));
    } catch (err) {
        console.error('VERIFY DECISION ERROR:', err.message);
        res.status(500).send('<h2>Something went wrong. Please try again.</h2>');
    }
}

app.get('/api/verify/decide', handleVerifyDecision);
app.post('/api/verify/decision', handleVerifyDecision);

// Legacy one-click verify → redirect to review page
app.get('/api/verify/accept', async (req, res) => {
    const token = req.query.token;
    if (token) return res.redirect(`/api/verify?token=${encodeURIComponent(token)}`);
    res.status(400).send('Missing token');
});

// ── Get all verified students for browse page ───────────────
app.get('/api/students', async (req, res) => {
    try {
        const [students] = await db.query(`
            SELECT
                s.id,
                u.name,
                s.university_name,
                s.department,
                s.semester,
                s.cgpa,
                s.priority_level,
                s.gender,
                s.area_type,
                s.guardian_status,
                a.amount_needed,
                a.reason,
                a.id as application_id,
                COALESCE(SUM(d.amount), 0) as amount_raised
            FROM students s
            JOIN users u ON s.user_id = u.id
            JOIN applications a ON a.student_id = s.id
            LEFT JOIN donations d ON d.application_id = a.id AND d.status = 'completed'
            WHERE s.status = 'verified'
            AND a.status = 'verified'
            GROUP BY s.id, u.name, s.university_name, s.department,
                     s.semester, s.cgpa, s.priority_level, s.gender,
                     s.area_type, s.guardian_status, a.amount_needed,
                     a.reason, a.id
            ORDER BY
                CASE s.priority_level
                    WHEN '1st Priority (Orphan/Parent deceased)' THEN 1
                    WHEN '2nd Priority (Parent disabled/ill)' THEN 2
                    WHEN '3rd Priority (Family income below 25k)' THEN 3
                    WHEN '4th Priority (Unemployed guardian)' THEN 4
                    WHEN '5th Priority (3+ siblings studying)' THEN 5
                    WHEN '6th Priority (Rural background)' THEN 6
                    WHEN '7th Priority (Female student)' THEN 7
                    ELSE 8
                END
        `);
        res.json(students);
    } catch (err) {
        console.error('STUDENTS ERROR:', err.message);
        res.status(500).json({ message: 'Could not fetch students: ' + err.message });
    }
});

// ── Donation route ──────────────────────────────────────────
app.post('/api/donate', async (req, res) => {
    const { donorName, donorEmail, donorPhone, applicationId, amount, frequency } = req.body;

    try {
        // 1 — Check if donor already exists
        let donorId;
        const [existing] = await db.query(
            `SELECT id FROM donors WHERE user_id IN (SELECT id FROM users WHERE email = ?)`,
            [donorEmail]
        );

        if (existing.length > 0) {
            donorId = existing[0].id;
        } else {
            const [userResult] = await db.query(
                `INSERT INTO users (name, email, password_hash, role, phone)
                 VALUES (?, ?, '', 'donor', ?)`,
                [donorName, donorEmail, donorPhone]
            );
            const userId = userResult.insertId;
            const [donorResult] = await db.query(
                `INSERT INTO donors (user_id, phone) VALUES (?, ?)`,
                [userId, donorPhone]
            );
            donorId = donorResult.insertId;
        }

        // 2 — Generate reference number
        const reference = 'EP-' + Date.now() + '-' + Math.floor(Math.random() * 10000);

        // 3 — Save donation record
        await db.query(
            `INSERT INTO donations (donor_id, application_id, amount, easypaisa_ref, status)
             VALUES (?, ?, ?, ?, 'initiated')`,
            [donorId, applicationId, amount, reference]
        );

        // 4 — Send confirmation email (safe — won't crash)
        await sendEmail(
            donorEmail,
            'Donation Confirmation — Qalam Aid',
            `
            <div style="font-family:Arial;max-width:600px;margin:auto;">
                <h2 style="color:#065f46;">Thank You for Your Donation! 🙏</h2>
                <p>Dear ${donorName},</p>
                <p>Your donation has been recorded. Here are your details:</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                    <tr style="background:#f0fdf4;">
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Amount</td>
                        <td style="padding:10px;border:1px solid #ddd;">PKR ${Number(amount).toLocaleString()}</td>
                    </tr>
                    <tr>
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Reference No.</td>
                        <td style="padding:10px;border:1px solid #ddd;font-weight:700;color:#065f46;">${reference}</td>
                    </tr>
                    <tr style="background:#f0fdf4;">
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Easypaisa Number</td>
                        <td style="padding:10px;border:1px solid #ddd;">${donorPhone}</td>
                    </tr>
                    <tr>
                        <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">Status</td>
                        <td style="padding:10px;border:1px solid #ddd;">Initiated — awaiting Easypaisa payment</td>
                    </tr>
                </table>
                <div style="background:#fef3c7;border-radius:8px;padding:16px;margin:16px 0;">
                    <p style="font-weight:700;color:#92400e;margin-bottom:8px;">⚠️ Next Step:</p>
                    <p style="color:#92400e;">Send PKR ${Number(amount).toLocaleString()} to <strong>0300-1234567</strong></p>
                    <p style="color:#92400e;margin-top:4px;">Add in remarks: <strong>${reference}</strong></p>
                </div>
                <p>Jazak Allah Khair for supporting education in Pakistan!</p>
                <p>Regards,<br><strong>Qalam Aid Team</strong></p>
            </div>
            `
        );

        console.log(`✅ Donation saved — ref: ${reference} — donor: ${donorEmail}`);
        res.json({ message: 'Donation recorded!', reference });

    } catch (err) {
        console.error('DONATION ERROR:', err.message);
        res.status(500).json({ message: 'Something went wrong: ' + err.message });
    }
});

// ── Sandbox payment success callback ───────────────────────
app.post('/api/sandbox/payment-success', async (req, res) => {
    const { reference, amount, txnId } = req.body;
    try {
        await db.query(
            `UPDATE donations SET status = 'completed',
             easypaisa_ref = CONCAT(easypaisa_ref, ' | TXN:', ?)
             WHERE easypaisa_ref = ?`,
            [txnId, reference]
        );

        // Check if student is fully funded
        const [donation] = await db.query(
            `SELECT application_id FROM donations WHERE easypaisa_ref LIKE ?`,
            [`%${reference}%`]
        );
        if (donation.length > 0) {
            const appId = donation[0].application_id;
            const [appData] = await db.query(
                `SELECT a.amount_needed, COALESCE(SUM(d.amount),0) as raised
                 FROM applications a
                 LEFT JOIN donations d ON d.application_id = a.id AND d.status = 'completed'
                 WHERE a.id = ? GROUP BY a.id`,
                [appId]
            );
            if (appData.length > 0 && appData[0].raised >= appData[0].amount_needed) {
                await db.query(`UPDATE applications SET status = 'funded' WHERE id = ?`, [appId]);
                await db.query(
                    `UPDATE students SET status = 'funded'
                     WHERE id = (SELECT student_id FROM applications WHERE id = ?)`,
                    [appId]
                );
            }
        }

        res.json({ message: 'Payment confirmed! Student will be notified.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── Student dashboard ───────────────────────────────────────
app.get('/api/student-dashboard', async (req, res) => {
    const { email } = req.query;
    try {
        const [rows] = await db.query(`
            SELECT u.name, u.email, s.university_name as university,
                   s.department as program, s.semester, s.cgpa,
                   s.reg_number as regNumber, s.status as studentStatus,
                   s.priority_level as priorityLevel,
                   a.status as applicationStatus, a.amount_needed as amountNeeded,
                   a.submitted_at as submittedAt,
                   COALESCE(SUM(d.amount),0) as amountRaised
            FROM users u
            JOIN students s ON s.user_id = u.id
            JOIN applications a ON a.student_id = s.id
            LEFT JOIN donations d ON d.application_id = a.id AND d.status = 'completed'
            WHERE u.email = ?
            GROUP BY u.id, s.id, a.id
            LIMIT 1
        `, [email]);
        if (rows.length === 0) return res.status(404).json({ message: 'Student not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── Donor dashboard ─────────────────────────────────────────
app.get('/api/donor-dashboard', async (req, res) => {
    const { email } = req.query;
    try {
        const [donor] = await db.query(
            `SELECT u.name, u.email, d.id as donorId
             FROM users u JOIN donors d ON d.user_id = u.id
             WHERE u.email = ? LIMIT 1`, [email]
        );
        if (donor.length === 0) return res.status(404).json({ message: 'Donor not found' });

        const donorId = donor[0].donorId;

        const [donations] = await db.query(`
            SELECT dn.id, u.name as studentName, s.university_name as university,
                   dn.amount, dn.easypaisa_ref as reference,
                   dn.status, dn.donated_at as date,
                   (SELECT COUNT(*) FROM receipts r WHERE r.donation_id = dn.id) > 0 as receipt
            FROM donations dn
            JOIN applications a ON a.id = dn.application_id
            JOIN students s ON s.id = a.student_id
            JOIN users u ON u.id = s.user_id
            WHERE dn.donor_id = ?
            ORDER BY dn.donated_at DESC
        `, [donorId]);

        const [students] = await db.query(`
            SELECT DISTINCT u.name, s.university_name as university,
                   a.amount_needed as amountNeeded, s.status,
                   COALESCE(SUM(d2.amount),0) as amountRaised,
                   SUM(CASE WHEN dn.donor_id = ? THEN dn.amount ELSE 0 END) as myDonation
            FROM donations dn
            JOIN applications a ON a.id = dn.application_id
            JOIN students s ON s.id = a.student_id
            JOIN users u ON u.id = s.user_id
            LEFT JOIN donations d2 ON d2.application_id = a.id AND d2.status = 'completed'
            WHERE dn.donor_id = ?
            GROUP BY s.id
        `, [donorId, donorId]);

        const totalDonated   = donations.reduce((sum, d) => sum + Number(d.amount), 0);
        const studentsHelped = new Set(donations.map(d => d.studentName)).size;

        res.json({
            name: donor[0].name, email: donor[0].email,
            totalDonated, totalDonations: donations.length,
            studentsHelped, donations, studentsSupported: students
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── Admin middleware ─────────────────────────────────────────
function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
        const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        if (payload.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
        req.adminUser = payload;
        next();
    } catch {
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
}

// ── Admin login ──────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    try {
        const [rows] = await db.query(
            `SELECT id, name, email, password_hash, role FROM users WHERE LOWER(TRIM(email)) = LOWER(?) LIMIT 1`,
            [String(email).trim()]
        );
        if (rows.length === 0 || rows[0].role !== 'admin') {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        const match = await bcrypt.compare(password, rows[0].password_hash);
        if (!match) return res.status(401).json({ message: 'Invalid credentials' });
        const token = jwt.sign(
            { sub: rows[0].id, email: rows[0].email, role: 'admin' },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );
        res.json({ token, name: rows[0].name, email: rows[0].email });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── Admin helpers ────────────────────────────────────────────
async function markFundedIfGoalMet(applicationId) {
    const [appData] = await db.query(
        `SELECT a.amount_needed, COALESCE(SUM(d.amount), 0) AS raised
         FROM applications a
         LEFT JOIN donations d ON d.application_id = a.id AND d.status = 'completed'
         WHERE a.id = ? GROUP BY a.id`,
        [applicationId]
    );
    if (appData.length === 0) return;
    const needed = parseFloat(appData[0].amount_needed) || 0;
    const raised = parseFloat(appData[0].raised) || 0;
    if (needed > 0 && raised >= needed) {
        await db.query(`UPDATE applications SET status = 'funded' WHERE id = ?`, [applicationId]);
        await db.query(
            `UPDATE students SET status = 'funded'
             WHERE id = (SELECT student_id FROM applications WHERE id = ?)`,
            [applicationId]
        );
    }
}

const APP_STATUSES = ['pending', 'verified', 'rejected', 'funded'];
const STUDENT_STATUSES = ['pending', 'verified', 'rejected', 'funded'];
const DONATION_STATUSES = ['initiated', 'completed', 'cancelled', 'failed'];

// ── Admin routes (protected) ─────────────────────────────────
app.get('/api/admin/me', requireAdmin, async (req, res) => {
    try {
        const adminId = req.adminUser.sub;
        const [rows] = await db.query(
            `SELECT id, name, email, role FROM users WHERE id = ? AND role = 'admin' LIMIT 1`,
            [adminId]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Admin not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const [[apps]] = await db.query(`
            SELECT
                COUNT(*) AS totalApplications,
                SUM(status = 'pending') AS pendingApplications,
                SUM(status = 'verified') AS verifiedApplications,
                SUM(status = 'rejected') AS rejectedApplications
            FROM applications
        `);
        const [[students]] = await db.query(`
            SELECT
                SUM(status = 'verified') AS verifiedStudents,
                SUM(status = 'pending') AS pendingStudents
            FROM students
        `);
        const [[donations]] = await db.query(`
            SELECT
                SUM(status = 'completed') AS completedDonations,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) AS totalRaisedPkr
            FROM donations
        `);
        res.json({
            applications: {
                totalApplications: Number(apps.totalApplications) || 0,
                pendingApplications: Number(apps.pendingApplications) || 0,
                verifiedApplications: Number(apps.verifiedApplications) || 0,
                rejectedApplications: Number(apps.rejectedApplications) || 0
            },
            students: {
                verifiedStudents: Number(students.verifiedStudents) || 0,
                pendingStudents: Number(students.pendingStudents) || 0
            },
            donations: {
                completedDonations: Number(donations.completedDonations) || 0,
                totalRaisedPkr: Number(donations.totalRaisedPkr) || 0
            }
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/admin/applications', requireAdmin, async (req, res) => {
    const status = String(req.query.status || '').trim();
    try {
        let sql = `
            SELECT a.id, a.status, a.amount_needed AS amountNeeded, a.submitted_at AS submittedAt,
                   u.name AS studentName, u.email AS studentEmail,
                   s.university_name AS universityName, s.university_email AS universityEmail,
                   s.department,
                   (SELECT COUNT(*) FROM application_documents ad WHERE ad.application_id = a.id) AS documentCount
            FROM applications a
            JOIN students s ON s.id = a.student_id
            JOIN users u ON u.id = s.user_id
        `;
        const params = [];
        if (status && status !== 'all') {
            sql += ' WHERE a.status = ?';
            params.push(status);
        }
        sql += ' ORDER BY a.submitted_at DESC';
        const [rows] = await db.query(sql, params);
        res.json(rows.map((r) => ({
            ...r,
            documentCount: Number(r.documentCount) || 0
        })));
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/admin/applications/:id/email-university', requireAdmin, async (req, res) => {
    const applicationId = parseInt(req.params.id, 10);
    if (!applicationId) return res.status(400).json({ message: 'Invalid application id' });
    try {
        const result = await sendUniversityVerificationEmail(applicationId);
        res.json({
            message: `Email sent to ${result.to} with ${result.attachmentCount} attachment(s).`,
            ...result
        });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

app.get('/api/admin/applications/:id/documents', requireAdmin, async (req, res) => {
    const applicationId = parseInt(req.params.id, 10);
    if (!applicationId) return res.status(400).json({ message: 'Invalid application id' });
    try {
        const documents = await listApplicationDocuments(applicationId);
        if (documents === null) return res.status(404).json({ message: 'Application not found' });
        res.json({ applicationId, documents });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/admin/documents/:documentId/file', requireAdmin, async (req, res) => {
    const documentId = parseInt(req.params.documentId, 10);
    if (!documentId) return res.status(400).json({ message: 'Invalid document id' });
    try {
        const doc = await getDocumentById(documentId);
        if (!doc || !doc.fileData) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const asDownload = req.query.download === '1';
        const downloadName = safeBasename(doc.originalName) || doc.storedName;
        res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
        res.setHeader(
            'Content-Disposition',
            `${asDownload ? 'attachment' : 'inline'}; filename="${downloadName}"`
        );
        res.send(Buffer.from(doc.fileData));
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.patch('/api/admin/applications/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!APP_STATUSES.includes(status)) {
        return res.status(400).json({ message: 'Invalid application status.' });
    }
    try {
        const [existing] = await db.query('SELECT id, student_id FROM applications WHERE id = ?', [id]);
        if (existing.length === 0) return res.status(404).json({ message: 'Application not found' });

        await db.query('UPDATE applications SET status = ? WHERE id = ?', [status, id]);
        if (status === 'verified' || status === 'rejected' || status === 'pending') {
            await db.query('UPDATE students SET status = ? WHERE id = ?', [status, existing[0].student_id]);
        }
        if (status === 'funded') {
            await db.query('UPDATE students SET status = ? WHERE id = ?', ['funded', existing[0].student_id]);
        }
        res.json({ message: 'Application updated.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/admin/students', requireAdmin, async (req, res) => {
    const status = String(req.query.status || '').trim();
    try {
        let sql = `
            SELECT s.id, s.status, s.reg_number AS regNumber,
                   s.university_name AS universityName,
                   u.name, u.email
            FROM students s
            JOIN users u ON u.id = s.user_id
        `;
        const params = [];
        if (status && status !== 'all') {
            sql += ' WHERE s.status = ?';
            params.push(status);
        }
        sql += ' ORDER BY s.id DESC';
        const [rows] = await db.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.patch('/api/admin/students/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!STUDENT_STATUSES.includes(status)) {
        return res.status(400).json({ message: 'Invalid student status.' });
    }
    try {
        const [existing] = await db.query('SELECT id FROM students WHERE id = ?', [id]);
        if (existing.length === 0) return res.status(404).json({ message: 'Student not found' });

        await db.query('UPDATE students SET status = ? WHERE id = ?', [status, id]);
        if (status === 'verified' || status === 'rejected' || status === 'pending') {
            await db.query(
                `UPDATE applications SET status = ?
                 WHERE student_id = ? AND status NOT IN ('funded')`,
                [status, id]
            );
        }
        res.json({ message: 'Student updated.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/admin/donations', requireAdmin, async (req, res) => {
    const status = String(req.query.status || '').trim();
    try {
        let sql = `
            SELECT dn.id, dn.amount, dn.easypaisa_ref AS easypaisaRef,
                   dn.status, dn.donated_at AS donatedAt,
                   u_donor.name AS donorName, u_donor.email AS donorEmail,
                   u_student.name AS studentName, s.university_name AS universityName
            FROM donations dn
            JOIN donors don ON don.id = dn.donor_id
            JOIN users u_donor ON u_donor.id = don.user_id
            JOIN applications a ON a.id = dn.application_id
            JOIN students s ON s.id = a.student_id
            JOIN users u_student ON u_student.id = s.user_id
        `;
        const params = [];
        if (status && status !== 'all') {
            const dbStatus = status === 'cancelled' ? 'failed' : status;
            sql += ' WHERE dn.status = ?';
            params.push(dbStatus);
        }
        sql += ' ORDER BY dn.donated_at DESC';
        const [rows] = await db.query(sql, params);
        const mapped = rows.map((r) => ({
            ...r,
            status: r.status === 'failed' ? 'cancelled' : r.status
        }));
        res.json(mapped);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.patch('/api/admin/donations/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let { status } = req.body || {};
    if (status === 'cancelled') status = 'failed';
    if (!DONATION_STATUSES.includes(status)) {
        return res.status(400).json({ message: 'Invalid donation status.' });
    }
    try {
        const [existing] = await db.query(
            'SELECT id, application_id FROM donations WHERE id = ?',
            [id]
        );
        if (existing.length === 0) return res.status(404).json({ message: 'Donation not found' });

        await db.query('UPDATE donations SET status = ? WHERE id = ?', [status, id]);
        if (status === 'completed') {
            await markFundedIfGoalMet(existing[0].application_id);
        }
        res.json({ message: 'Donation updated.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/admin/confirm-payment', requireAdmin, async (req, res) => {
    const { donationId } = req.body;
    try {
        await db.query(`UPDATE donations SET status = 'completed' WHERE id = ?`, [donationId]);
        const [dn] = await db.query(`SELECT application_id FROM donations WHERE id = ?`, [donationId]);
        if (dn.length > 0) await markFundedIfGoalMet(dn[0].application_id);
        res.json({ message: 'Payment confirmed!' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/admin/reject-payment', requireAdmin, async (req, res) => {
    const { donationId } = req.body;
    try {
        await db.query(`UPDATE donations SET status = 'failed' WHERE id = ?`, [donationId]);
        res.json({ message: 'Payment rejected.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── Auth routes ──────────────────────────────────────────────
app.get('/api/auth/check-email', async (req, res) => {
    const email = String(req.query.email || '').trim();
    if (!email) return res.status(400).json({ message: 'Email is required.' });
    try {
        const [rows] = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1', [email]);
        res.json({ available: rows.length === 0 });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/auth/signup', async (req, res) => {
    const { name, email, phone, password, role, universityName, registrationNumber, program, semester } = req.body;

    if (!name || !email || !password || !phone) {
        return res.status(400).json({ message: 'Name, email, phone, and password are required.' });
    }
    if (!['student', 'donor'].includes(role)) {
        return res.status(400).json({ message: 'Role must be student or donor.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }

    try {
        const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(400).json({ message: 'Email already registered. Please login.' });

        const hash = await bcrypt.hash(password, 12);
        const [userResult] = await db.query(
            `INSERT INTO users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)`,
            [name, email, hash, role, phone]
        );
        const userId = userResult.insertId;

        if (role === 'student') {
            await db.query(
                `INSERT INTO students (user_id, reg_number, university_email, university_name, department, semester, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                [userId, registrationNumber || '', email, universityName || '', program || '', semester || '']
            );
        }
        if (role === 'donor') {
            await db.query(`INSERT INTO donors (user_id, phone) VALUES (?, ?)`, [userId, phone]);
        }

        res.json({ message: 'Account created successfully!' });
    } catch (err) {
        console.error('SIGNUP ERROR:', err.message);
        res.status(500).json({ message: 'Something went wrong: ' + err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
        return res.status(400).json({ message: 'Email, password, and role are required.' });
    }
    if (!['student', 'donor', 'admin'].includes(role)) {
        return res.status(400).json({ message: 'Invalid role.' });
    }

    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(401).json({ message: 'No account found with this email.' });

        const user = users[0];
        if (user.role !== role && user.role !== 'admin') {
            const label = user.role === 'donor' ? 'donor' : 'student';
            return res.status(401).json({
                message: `This email is registered as a ${label}. Please use "${label}" login instead.`
            });
        }

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ message: 'Incorrect password. Please try again.' });

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({ message: 'Login successful!', token, name: user.name, email: user.email, role: user.role });
    } catch (err) {
        console.error('LOGIN ERROR:', err.message);
        res.status(500).json({ message: 'Something went wrong: ' + err.message });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(404).json({ message: 'No account found with this email.' });

        const otp       = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await db.query(
            `INSERT INTO password_reset_tokens (email, otp, expires_at)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE otp = ?, expires_at = ?`,
            [email, otp, expiresAt, otp, expiresAt]
        );

        await sendEmail(
            email,
            'Password Reset Code — Qalam Aid',
            `
            <div style="font-family:Arial;max-width:500px;margin:auto;">
                <h2 style="color:#065f46;">Reset Your Password</h2>
                <p>Hi ${users[0].name},</p>
                <p>Use the code below to reset your Qalam Aid password:</p>
                <div style="background:#f0fdf4;border:2px solid #065f46;border-radius:12px;padding:24px;text-align:center;margin:20px 0;">
                    <p style="font-size:13px;color:#64748b;margin-bottom:8px;">YOUR RESET CODE</p>
                    <h1 style="font-size:40px;font-weight:700;color:#065f46;letter-spacing:8px;font-family:monospace;">${otp}</h1>
                    <p style="font-size:12px;color:#64748b;margin-top:8px;">Expires in 15 minutes</p>
                </div>
                <p style="color:#64748b;font-size:13px;">If you didn't request this, ignore this email.</p>
                <p>Regards,<br><strong>Qalam Aid Team</strong></p>
            </div>
            `
        );

        // If email not configured, show OTP in console for testing
        if (!process.env.EMAIL_USER || process.env.EMAIL_PASS === 'your_16_char_app_password') {
            console.log(`🔐 OTP for ${email}: ${otp}`);
        }

        res.json({ message: 'Reset code sent to ' + email });
    } catch (err) {
        console.error('FORGOT PWD ERROR:', err.message);
        res.status(500).json({ message: 'Something went wrong: ' + err.message });
    }
});

app.post('/api/auth/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    try {
        const [rows] = await db.query(
            `SELECT * FROM password_reset_tokens WHERE email = ? AND otp = ? AND expires_at > NOW()`,
            [email, otp]
        );
        if (rows.length === 0) return res.status(400).json({ message: 'Invalid or expired code. Please try again.' });

        const resetToken = jwt.sign(
            { email, purpose: 'password-reset' },
            process.env.JWT_SECRET,
            { expiresIn: '10m' }
        );
        res.json({ message: 'Code verified!', resetToken });
    } catch (err) {
        res.status(500).json({ message: 'Something went wrong: ' + err.message });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { email, resetToken, newPassword } = req.body;
    try {
        let decoded;
        try { decoded = jwt.verify(resetToken, process.env.JWT_SECRET); }
        catch { return res.status(400).json({ message: 'Reset session expired. Please start again.' }); }

        if (decoded.email !== email || decoded.purpose !== 'password-reset') {
            return res.status(400).json({ message: 'Invalid reset token.' });
        }

        const newHash = await bcrypt.hash(newPassword, 12);
        await db.query('UPDATE users SET password_hash = ? WHERE email = ?', [newHash, email]);
        await db.query('DELETE FROM password_reset_tokens WHERE email = ?', [email]).catch(() => {});

        res.json({ message: 'Password reset successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Something went wrong: ' + err.message });
    }
});

app.get('/api/auth/profile', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [users] = await db.query(
            'SELECT id, name, email, role, phone, created_at FROM users WHERE id = ?',
            [decoded.userId]
        );
        if (users.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json(users[0]);
    } catch {
        res.status(401).json({ message: 'Invalid token' });
    }
});

app.post('/api/auth/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Not logged in' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [decoded.userId]);
        if (users.length === 0) return res.status(404).json({ message: 'User not found' });

        const match = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!match) return res.status(400).json({ message: 'Current password is incorrect' });

        const newHash = await bcrypt.hash(newPassword, 12);
        await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, decoded.userId]);
        res.json({ message: 'Password changed successfully!' });
    } catch {
        res.status(401).json({ message: 'Invalid or expired session' });
    }
});

// ── Start server ─────────────────────────────────────────────
async function startServer() {
    try {
        await ensureDocumentsTable();
        console.log('✅ application_documents table ready');
    } catch (err) {
        console.error('❌ Could not ensure application_documents table:', err.message || err);
        console.error('   DB host:', process.env.DB_HOST || process.env.MYSQLHOST || '(not set)');
        process.exit(1);
    }

    app.listen(process.env.PORT, async () => {
        console.log(`✅ Server running on port ${process.env.PORT}`);
        const { user } = getEmailCredentials();
        if (!user) {
            console.log('📧 Email configured: No — emails will be skipped');
            return;
        }
        const check = await verifyMailConnection();
        if (check.ok) {
            console.log(`📧 Email configured: Yes (SMTP verified for ${user})`);
        } else {
            console.log(`📧 Email configured: Yes, but SMTP verify failed: ${check.error}`);
            console.log('   → Regenerate Gmail app password, check 2FA, and ensure EMAIL_PASS has no extra spaces');
        }
    });
}

startServer();