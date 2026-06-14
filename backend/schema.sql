-- Qalam Aid — MySQL schema (utf8mb4, InnoDB)
-- Run after: CREATE DATABASE student_aid_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- USE student_aid_platform;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS receipts;
DROP TABLE IF EXISTS donations;
DROP TABLE IF EXISTS donors;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS application_documents;
DROP TABLE IF EXISTS verification_tokens;
DROP TABLE IF EXISTS applications;
DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL DEFAULT '',
    role VARCHAR(32) NOT NULL DEFAULT 'student',
    phone VARCHAR(64) NOT NULL DEFAULT '',
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_email (email),
    KEY idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE students (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    reg_number VARCHAR(128) NOT NULL DEFAULT '',
    university_email VARCHAR(255) NOT NULL DEFAULT '',
    university_name VARCHAR(255) NOT NULL DEFAULT '',
    department VARCHAR(255) NOT NULL DEFAULT '',
    semester VARCHAR(64) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    age VARCHAR(16) NOT NULL DEFAULT '',
    cgpa VARCHAR(32) NOT NULL DEFAULT '',
    gender VARCHAR(32) NOT NULL DEFAULT '',
    area_type VARCHAR(64) NOT NULL DEFAULT '',
    guardian_status VARCHAR(128) NOT NULL DEFAULT '',
    family_income VARCHAR(64) NOT NULL DEFAULT '',
    family_members VARCHAR(32) NOT NULL DEFAULT '',
    studying_siblings VARCHAR(32) NOT NULL DEFAULT '',
    job_status VARCHAR(64) NOT NULL DEFAULT '',
    backlogs VARCHAR(32) NOT NULL DEFAULT '',
    semesters_completed VARCHAR(32) NOT NULL DEFAULT '',
    hec_recognized VARCHAR(16) NOT NULL DEFAULT '',
    other_scholarship VARCHAR(255) NOT NULL DEFAULT '',
    priority_level VARCHAR(255) NOT NULL DEFAULT '',
    CONSTRAINT fk_students_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE applications (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    student_id INT UNSIGNED NOT NULL,
    amount_needed VARCHAR(64) NOT NULL DEFAULT '',
    reason TEXT,
    doc_path TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    submitted_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_applications_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
    KEY idx_applications_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_documents (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    application_id INT UNSIGNED NOT NULL,
    original_name VARCHAR(512) NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
    file_size INT UNSIGNED NOT NULL DEFAULT 0,
    file_data LONGBLOB NOT NULL,
    uploaded_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_app_docs_application (application_id),
    CONSTRAINT fk_app_docs_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE verification_tokens (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    application_id INT UNSIGNED NOT NULL,
    token VARCHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    used TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE KEY uq_verification_token (token),
    KEY idx_verification_app (application_id),
    CONSTRAINT fk_verification_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE donors (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    phone VARCHAR(64) NOT NULL DEFAULT '',
    CONSTRAINT fk_donors_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    KEY idx_donors_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE donations (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    donor_id INT UNSIGNED NOT NULL,
    application_id INT UNSIGNED NOT NULL,
    amount DECIMAL(14, 2) NOT NULL DEFAULT 0,
    easypaisa_ref VARCHAR(255) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'initiated',
    donated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_donations_donor FOREIGN KEY (donor_id) REFERENCES donors (id) ON DELETE CASCADE,
    CONSTRAINT fk_donations_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
    KEY idx_donations_status (status),
    KEY idx_donations_easypaisa (easypaisa_ref(64))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE password_reset_tokens (
    email VARCHAR(255) NOT NULL PRIMARY KEY,
    otp VARCHAR(16) NOT NULL,
    expires_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Used by donor dashboard (receipt flags); optional rows
CREATE TABLE receipts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    donation_id INT UNSIGNED NOT NULL,
    file_path VARCHAR(512) DEFAULT NULL,
    uploaded_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_receipts_donation FOREIGN KEY (donation_id) REFERENCES donations (id) ON DELETE CASCADE,
    KEY idx_receipts_donation (donation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
