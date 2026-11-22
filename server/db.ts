import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

export function getDbPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_NAME || 'portal_sekolah',
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
      queueLimit: 0,
    });
  }
  return pool;
}

export async function initDatabase(): Promise<void> {
  const db = getDbPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS auth_users (
      uid VARCHAR(191) NOT NULL PRIMARY KEY,
      google_sub VARCHAR(191) NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      display_name VARCHAR(255) NULL,
      photo_url TEXT NULL,
      created_at BIGINT NOT NULL,
      last_login_at BIGINT NOT NULL,
      INDEX idx_auth_google_sub (google_sub)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS app_documents (
      collection_path VARCHAR(191) NOT NULL,
      doc_id VARCHAR(191) NOT NULL,
      tenant_id VARCHAR(191) NULL,
      data LONGTEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (collection_path, doc_id),
      INDEX idx_collection_tenant (collection_path, tenant_id),
      INDEX idx_collection_updated (collection_path, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
