import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

// Load firebase-applet-config.json if present
let appletConfig = null;
try {
  const appletPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(appletPath)) {
    appletConfig = JSON.parse(fs.readFileSync(appletPath, 'utf8'));
  }
} catch {
  // ignore
}

// Candidate legacy Firebase sources in priority order
const CANDIDATE_SOURCES = [
  ...(process.env.LEGACY_FIREBASE_PROJECT_ID
    ? [
        {
          label: 'ENV LEGACY_FIREBASE_PROJECT_ID',
          projectId: process.env.LEGACY_FIREBASE_PROJECT_ID,
          databaseId: process.env.LEGACY_FIREBASE_DATABASE_ID || '(default)',
          apiKey: process.env.LEGACY_FIREBASE_API_KEY || '',
        },
      ]
    : []),
  ...(appletConfig?.projectId
    ? [
        {
          label: 'firebase-applet-config.json (named DB)',
          projectId: appletConfig.projectId,
          databaseId: appletConfig.firestoreDatabaseId || '(default)',
          apiKey: appletConfig.apiKey || '',
        },
      ]
    : []),
  {
    label: 'legacy firebase.ts (gen-lang-client-0871236748)',
    projectId: 'gen-lang-client-0871236748',
    databaseId: '(default)',
    apiKey: 'AIzaSyBuOcNk8ODeL7ZsdE2im0zNcQoo1GhWFm4',
  },
  {
    label: 'legacy check_db.js (ai-studio-ace49a47)',
    projectId: 'ai-studio-ace49a47-40ec-4c50-9cf0-e0bbd7ea490e',
    databaseId: '(default)',
    apiKey: '',
  },
];

// Complete union of ALL collections defined in exportUtils.ts + referenced across src/
const ALL_COLLECTIONS = Array.from(
  new Set([
    'users',
    'user_roles',
    'roles',
    'permissions',
    'role_permissions',
    'tenants',
    'tenant_memberships',
    'platform_invitations',
    'platform_settings',
    'school_profiles',
    'academic_years',
    'academic_semesters',
    'academic_periods',
    'academic_subjects',
    'academic_classes',
    'classes',
    'schedules',
    'curriculum_data',
    'prota_promes',
    'ketersediaan',
    'exam_rooms',
    'exam_schedules',
    'exam_reports',
    'academic_assessments',
    'academic_grades',
    'academic_report_cards',
    'student_academic_profiles',
    'student_guardians',
    'student_health',
    'student_enrollments',
    'student_achievements',
    'student_violations',
    'student_cases',
    'student_documents',
    'student_extracurriculars',
    'student_portfolios',
    'promotion_audits',
    'attendance_logs',
    'teacher_profiles',
    'teacher_employments',
    'teacher_certifications',
    'teacher_teaching_loads',
    'teacher_tools',
    'teacher_documents',
    'teacher_documents_v2',
    'teacher_attendances',
    'teacher_performances',
    'teacher_researches',
    'teacher_schedules',
    'teacher_trainings',
    'piket_logs',
    'admission_waves',
    'admission_applicants',
    'admission_registrations',
    'admission_document_requirements',
    'admission_payments',
    'admission_selection_configs',
    'admission_audits',
    'supervisions',
    'supervision_evidences',
    'supervision_follow_ups',
    'supervision_sessions',
    'parents',
    'parent_student_relations',
    'parent_invitations',
    'parent_approvals',
    'parent_communications',
    'parent_timelines',
    'billing_events',
    'payments',
    'finance_billings',
    'finance_payments',
    'finance_invoices',
    'finance_ledgers',
    'finance_journals',
    'finance_cash_flows',
    'finance_scholarships',
    'finance_payrolls',
    'letter_templates',
    'letters',
    'doc_templates',
    'doc_items',
    'doc_signatures',
    'tenant_public_profiles',
    'tenant_cms_contents',
    'website_pages',
    'website_articles',
    'website_settings',
    'settings',
    'audit_logs',
    'notifications',
    'notification_jobs',
    'notification_preferences',
    'feature_flags',
    'tenant_feature_overrides',
    'tenant_subscriptions',
    'subscription_plans',
    'subscription_requests',
    'tenant_modules',
    'platform_modules',
    'platform_releases',
  ])
);

function decodeFirestoreValue(fv) {
  if (!fv || typeof fv !== 'object') return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return Boolean(fv.booleanValue);
  if ('integerValue' in fv) return Number(fv.integerValue);
  if ('doubleValue' in fv) return Number(fv.doubleValue);
  if ('stringValue' in fv) return String(fv.stringValue);
  if ('timestampValue' in fv) {
    const ms = Date.parse(fv.timestampValue);
    if (!Number.isNaN(ms)) {
      return {
        __firestoreTimestamp: true,
        seconds: Math.floor(ms / 1000),
        nanoseconds: (ms % 1000) * 1_000_000,
      };
    }
    return fv.timestampValue;
  }
  if ('arrayValue' in fv) {
    const values = fv.arrayValue?.values || [];
    return values.map(decodeFirestoreValue);
  }
  if ('mapValue' in fv) {
    const fields = fv.mapValue?.fields || {};
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  if ('referenceValue' in fv) return fv.referenceValue;
  if ('geoPointValue' in fv) return fv.geoPointValue;
  return null;
}

function decodeFirestoreDoc(docObj) {
  const nameParts = String(docObj.name || '').split('/');
  const id = nameParts[nameParts.length - 1];
  const fields = docObj.fields || {};
  const data = {};
  for (const [k, v] of Object.entries(fields)) {
    data[k] = decodeFirestoreValue(v);
  }
  return { id, data };
}

async function fetchCollectionRest(source, collectionName) {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    source.projectId
  )}/databases/${encodeURIComponent(source.databaseId)}/documents/${encodeURIComponent(collectionName)}`;

  const docs = [];
  let pageToken = '';

  while (true) {
    const qs = new URLSearchParams({ pageSize: '300' });
    if (source.apiKey) qs.set('key', source.apiKey);
    if (pageToken) qs.set('pageToken', pageToken);

    const res = await fetch(`${baseUrl}?${qs.toString()}`);
    if (res.status === 404) {
      return { status: 404, docs: [] };
    }
    if (!res.ok) {
      const errText = await res.text();
      return { status: res.status, error: errText, docs: [] };
    }

    const json = await res.json();
    if (Array.isArray(json.documents)) {
      for (const rawDoc of json.documents) {
        docs.push(decodeFirestoreDoc(rawDoc));
      }
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }

  return { status: 200, docs };
}

async function detectActiveSource() {
  console.log('Mendeteksi sumber database Firebase yang aktif...');
  for (const src of CANDIDATE_SOURCES) {
    const probeUsers = await fetchCollectionRest(src, 'users');
    const probeTenants = await fetchCollectionRest(src, 'tenants');
    console.log(
      `  - ${src.label} [${src.projectId} / ${src.databaseId}] -> users: HTTP ${probeUsers.status} (${probeUsers.docs.length}), tenants: HTTP ${probeTenants.status} (${probeTenants.docs.length})`
    );
    if (probeUsers.status === 200 || probeTenants.status === 200) {
      if (probeUsers.docs.length > 0 || probeTenants.docs.length > 0) {
        return src;
      }
    }
  }
  // Fallback to first HTTP 200 source even if empty
  for (const src of CANDIDATE_SOURCES) {
    const probe = await fetchCollectionRest(src, 'users');
    if (probe.status === 200) return src;
  }
  return null;
}

async function main() {
  console.log('======================================================');
  console.log(' MIGRASI DATA: Firebase Firestore -> MySQL (Lokal/cPanel)');
  console.log('======================================================');

  // 1. Connect to MySQL & ensure tables exist
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

  console.log(`[MySQL] Terhubung & tabel siap di database "${process.env.DB_NAME || 'portal_sekolah'}".\n`);

  const activeSource = await detectActiveSource();
  if (!activeSource) {
    console.log('\n[INFO] Tidak ada database Firebase sumber yang dapat diakses (atau proyek lama sudah tidak aktif).');
    console.log('       Jika Anda memiliki file JSON hasil export dari menu Backup/Restore aplikasi lama,');
    console.log('       Anda bisa mengimpornya lewat menu Import Database di dashboard SuperAdmin setelah login.');
    await pool.end();
    process.exit(0);
  }

  console.log(`\nMenggunakan sumber: ${activeSource.label} (${activeSource.projectId}/${activeSource.databaseId})`);
  console.log(`Memeriksa ${ALL_COLLECTIONS.length} koleksi...\n`);

  const backupPayload = {
    _meta: {
      sourceProjectId: activeSource.projectId,
      sourceDatabaseId: activeSource.databaseId,
      migratedAt: new Date().toISOString(),
      totalCollectionsNonEmpty: 0,
      totalDocuments: 0,
    },
    data: {},
  };

  let totalDocs = 0;
  let nonEmptyCollections = 0;
  const skippedErrors = [];
  const now = Date.now();

  for (const colName of ALL_COLLECTIONS) {
    const result = await fetchCollectionRest(activeSource, colName);
    if (result.status !== 200) {
      if (result.status !== 404) {
        skippedErrors.push({ collection: colName, status: result.status });
        console.log(`  [SKIP] ${colName.padEnd(34)} -> HTTP ${result.status}`);
      }
      continue;
    }

    if (result.docs.length === 0) continue;

    nonEmptyCollections++;
    backupPayload.data[colName] = [];

    for (const d of result.docs) {
      const tenantId =
        d.data && typeof d.data.tenantId === 'string' && d.data.tenantId.length <= 191
          ? d.data.tenantId
          : null;

      await pool.query(
        `INSERT INTO app_documents (collection_path, doc_id, tenant_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           tenant_id = VALUES(tenant_id),
           data = VALUES(data),
           updated_at = VALUES(updated_at)`,
        [colName, d.id, tenantId, JSON.stringify(d.data), now, now]
      );

      backupPayload.data[colName].push({ _id: d.id, ...d.data });
      totalDocs++;
    }

    console.log(`  [OK] ${colName.padEnd(36)} -> ${result.docs.length} dokumen`);
  }

  backupPayload._meta.totalCollectionsNonEmpty = nonEmptyCollections;
  backupPayload._meta.totalDocuments = totalDocs;
  const backupsDir = path.join(process.cwd(), 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupsDir, `firebase-migration-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backupPayload, null, 2), 'utf8');

  await pool.end();

  console.log('\n======================================================');
  console.log(` SELESAI! ${totalDocs} dokumen dari ${nonEmptyCollections} koleksi berhasil dipindahkan ke MySQL.`);
  console.log(` File backup JSON tersimpan di: ${backupFile}`);
  if (skippedErrors.length > 0) {
    console.log(` Catatan: ${skippedErrors.length} koleksi dilewati karena aturan izin (misal supervisions).`);
  }
  console.log('======================================================');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migrasi gagal:', err);
  process.exit(1);
});
