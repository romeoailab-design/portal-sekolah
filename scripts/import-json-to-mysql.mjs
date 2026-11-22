import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

function normalizeImportedValue(val) {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(normalizeImportedValue);
  if (typeof val === 'object') {
    if (
      typeof val.seconds === 'number' &&
      typeof val.nanoseconds === 'number' &&
      Object.keys(val).every((k) => k === 'seconds' || k === 'nanoseconds' || k === '__firestoreTimestamp')
    ) {
      return {
        __firestoreTimestamp: true,
        seconds: val.seconds,
        nanoseconds: val.nanoseconds,
      };
    }
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        out[k] = normalizeImportedValue(v);
      }
    }
    return out;
  }
  return val;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Cara pakai: npm run import:json -- path/ke/file-backup.json');
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File tidak ditemukan: ${resolvedPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  const collectionsMap = raw?.data && typeof raw.data === 'object' ? raw.data : raw;

  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME || 'portal_sekolah',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 5,
  });

  await pool.query(`
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

  await pool.query(`
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

  const now = Date.now();
  let totalDocs = 0;
  let totalCollections = 0;

  for (const [colName, docs] of Object.entries(collectionsMap)) {
    if (colName === '_meta' || !Array.isArray(docs) || docs.length === 0) continue;
    totalCollections++;
    let count = 0;
    for (const item of docs) {
      if (!item || typeof item !== 'object') continue;
      const docId = String(item._id || item.id || item.uid || `${Date.now()}_${count}`);
      const payload = normalizeImportedValue({ ...item });
      delete payload._id;
      const tenantId =
        typeof payload.tenantId === 'string' && payload.tenantId.length <= 191
          ? payload.tenantId
          : null;

      await pool.query(
        `INSERT INTO app_documents (collection_path, doc_id, tenant_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           tenant_id = VALUES(tenant_id),
           data = VALUES(data),
           updated_at = VALUES(updated_at)`,
        [colName, docId, tenantId, JSON.stringify(payload), now, now]
      );
      count++;
      totalDocs++;
    }
    console.log(`  [OK] ${colName.padEnd(36)} -> ${count} dokumen`);
  }

  await pool.end();
  console.log(`\nSelesai! ${totalDocs} dokumen dari ${totalCollections} koleksi berhasil diimpor ke MySQL.`);
}

main().catch((err) => {
  console.error('Import gagal:', err);
  process.exit(1);
});
