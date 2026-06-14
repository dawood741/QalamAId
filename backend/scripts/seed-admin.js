/**
 * Creates or updates an admin user (bcrypt password, role = admin).
 * Usage: set ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET, and DB_* in .env, then:
 *   npm run seed-admin
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const db = require('../db');

async function main() {
    const email = process.env.ADMIN_EMAIL && String(process.env.ADMIN_EMAIL).trim();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
        console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env');
        process.exit(1);
    }
    if (!process.env.JWT_SECRET) {
        console.error('Set JWT_SECRET in backend/.env (used for admin session tokens)');
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 12);
    const [existing] = await db.query(
        'SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(?) LIMIT 1',
        [email]
    );

    if (existing.length > 0) {
        await db.query(
            `UPDATE users SET password_hash = ?, role = 'admin', name = COALESCE(NULLIF(TRIM(name), ''), 'Admin') WHERE id = ?`,
            [hash, existing[0].id]
        );
        console.log('Updated existing user to admin:', email);
    } else {
        await db.query(
            `INSERT INTO users (name, email, password_hash, role, phone) VALUES (?, ?, ?, 'admin', '')`,
            ['Admin', email, hash]
        );
        console.log('Created admin user:', email);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
