-- Run on existing databases: mysql -u user -p student_aid_platform < migrations/add_application_documents.sql

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
    CONSTRAINT fk_app_docs_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
