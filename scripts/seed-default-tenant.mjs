import 'dotenv/config';
import mysql from 'mysql2/promise';

const DEFAULT_TENANT_ID = 'smas-islam-diponegoro-wagir';
const DEFAULT_SUBDOMAIN = 'dipowagir';

async function main() {
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

  const now = Date.now();

  const upsertDoc = async (col, id, data, tenantId = DEFAULT_TENANT_ID) => {
    await pool.query(
      `INSERT INTO app_documents (collection_path, doc_id, tenant_id, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         tenant_id = VALUES(tenant_id),
         data = VALUES(data),
         updated_at = VALUES(updated_at)`,
      [col, id, tenantId, JSON.stringify(data), now, now]
    );
  };

  // 1. Default Tenant (SMAS Islam Diponegoro Wagir)
  const tenantDoc = {
    id: DEFAULT_TENANT_ID,
    code: 'DIPOWAGIR',
    name: 'SMAS Islam Diponegoro Wagir',
    status: 'ACTIVE',
    timezone: 'Asia/Jakarta',
    locale: 'id-ID',
    createdAt: now,
    updatedAt: now,
    branding: {
      logoUrl: '/logo.png',
      primaryColor: '#1d4ed8',
    },
    features: [
      'academic',
      'finance',
      'parent',
      'admission',
      'supervision',
      'document',
      'reporting',
      'ai',
      'website',
      'student',
      'teacher',
      'admin',
      'tu',
    ],
  };
  await upsertDoc('tenants', DEFAULT_TENANT_ID, tenantDoc, DEFAULT_TENANT_ID);

  // 2. Tenant Public Profile (accessible via /s/dipowagir and /s/dipowagir/login)
  const publicProfileDoc = {
    id: DEFAULT_TENANT_ID,
    tenantId: DEFAULT_TENANT_ID,
    schoolName: 'SMAS Islam Diponegoro Wagir',
    officialName: 'SMA Swasta Islam Diponegoro Wagir',
    shortName: 'SMAS Diponegoro',
    logoUrl: '/logo.png',
    faviconUrl: '/logo.png',
    primaryColor: '#1d4ed8',
    secondaryColor: '#0f172a',
    accentColor: '#10b981',
    heroTitle: 'SMAS Islam Diponegoro Wagir',
    heroSubtitle: 'Efektif, Efisien, dan Progresif — Membangun Generasi Berakhlak Mulia & Berprestasi',
    address: 'Kec. Wagir, Kabupaten Malang, Jawa Timur',
    phone: '',
    email: 'offcdipowagir@gmail.com',
    socialLinks: {},
    domainMappings: {
      subdomain: DEFAULT_SUBDOMAIN,
      status: 'ACTIVE',
      verifiedAt: now,
    },
    seoConfig: {
      title: 'SMAS Islam Diponegoro Wagir — Portal Sekolah',
      description: 'Portal EduOS resmi SMAS Islam Diponegoro Wagir',
      keywords: 'SMAS Islam Diponegoro Wagir, EduOS, Portal Sekolah, PPDB',
    },
    published: true,
    createdAt: now,
    updatedAt: now,
  };
  await upsertDoc('tenant_public_profiles', DEFAULT_TENANT_ID, publicProfileDoc, DEFAULT_TENANT_ID);

  // 3. School Profile
  const schoolProfileDoc = {
    id: DEFAULT_TENANT_ID,
    tenantId: DEFAULT_TENANT_ID,
    schoolName: 'SMAS Islam Diponegoro Wagir',
    officialCode: 'DIPOWAGIR',
    address: 'Kec. Wagir, Kabupaten Malang, Jawa Timur',
    contact: {
      email: 'offcdipowagir@gmail.com',
      phone: '',
    },
    createdAt: now,
    updatedAt: now,
  };
  await upsertDoc('school_profiles', DEFAULT_TENANT_ID, schoolProfileDoc, DEFAULT_TENANT_ID);

  // 4. Default SaaS Subscription Plans (so Platform HUB -> Subscription works out of the box)
  const allModules = [
    'academic',
    'finance',
    'parent',
    'admission',
    'supervision',
    'document',
    'reporting',
    'ai',
    'website',
    'student',
    'teacher',
    'admin',
    'tu',
  ];
  await upsertDoc(
    'subscription_plans',
    'enterprise',
    {
      id: 'enterprise',
      code: 'ENTERPRISE',
      name: 'Paket Enterprise EduOS',
      description: 'Akses penuh seluruh modul sekolah & AI.',
      priceMonthly: 0,
      priceYearly: 0,
      maxStudents: 5000,
      maxTeachers: 500,
      includedModules: allModules,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    null
  );

  // Active subscription for SMAS Islam Diponegoro Wagir (10 tahun untuk tenant inti/pilot)
  const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
  await upsertDoc(
    'tenant_subscriptions',
    `sub_${DEFAULT_TENANT_ID}`,
    {
      id: `sub_${DEFAULT_TENANT_ID}`,
      tenantId: DEFAULT_TENANT_ID,
      planId: 'enterprise',
      status: 'ACTIVE',
      startDate: now,
      endDate: now + tenYearsMs,
      gracePeriodEndDate: now + tenYearsMs + 30 * 24 * 60 * 60 * 1000,
      autoRenew: true,
      createdAt: now,
      updatedAt: now,
    },
    DEFAULT_TENANT_ID
  );

  // 5. Link ALL imported users -> tenant_memberships + upgrade super_admin to dual-role (EduOS + SaaS Platform Admin)
  const [userRows] = await pool.query(
    'SELECT doc_id, data FROM app_documents WHERE collection_path = ?',
    ['users']
  );

  let membershipCount = 0;
  const dualAdmins = [];

  for (const row of userRows) {
    const userDoc = JSON.parse(row.data);
    const uid = String(row.doc_id);
    const role = userDoc.role || 'student';
    const existingAdditional = Array.isArray(userDoc.additionalRoles) ? userDoc.additionalRoles : [];

    // Upgrade super_admin (offcdipowagir@gmail.com) and admin (androidbarir.2015@gmail.com) or BOOTSTRAP_ADMIN_EMAIL
    const emailLower = (userDoc.email || '').toLowerCase().trim();
    const bootstrapList = (process.env.BOOTSTRAP_ADMIN_EMAIL || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (role === 'super_admin' || bootstrapList.includes(emailLower)) {
      userDoc.additionalRoles = Array.from(
        new Set([...existingAdditional, 'platform_admin', 'super_admin', 'admin', 'teacher', 'curriculum', 'tu', 'bendahara'])
      );
      await upsertDoc('users', uid, userDoc, null);
      dualAdmins.push({ email: userDoc.email, name: userDoc.name, role: userDoc.role, additionalRoles: userDoc.additionalRoles });
    }

    const membershipRoles = Array.from(new Set([role, ...(userDoc.additionalRoles || [])]));
    const membershipId = `${DEFAULT_TENANT_ID}_${uid}`;
    const membershipDoc = {
      id: membershipId,
      userId: uid,
      tenantId: DEFAULT_TENANT_ID,
      roles: membershipRoles,
      permissions: role === 'super_admin' || role === 'admin' ? ['*'] : ['dashboard:access'],
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    await upsertDoc('tenant_memberships', membershipId, membershipDoc, DEFAULT_TENANT_ID);
    membershipCount++;
  }

  // 6. Stamp tenantId on legacy imported documents that don't have one yet
  const legacyCollections = ['teacher_tools', 'teacher_documents', 'billing_events', 'payments'];
  let stampedCount = 0;
  for (const col of legacyCollections) {
    const [rows] = await pool.query(
      'SELECT doc_id, data FROM app_documents WHERE collection_path = ?',
      [col]
    );
    for (const row of rows) {
      const obj = JSON.parse(row.data);
      if (!obj.tenantId) {
        obj.tenantId = DEFAULT_TENANT_ID;
        await upsertDoc(col, row.doc_id, obj, DEFAULT_TENANT_ID);
        stampedCount++;
      }
    }
  }

  await pool.end();

  console.log('======================================================');
  console.log(' SEED TENANT & DUAL-ADMIN SELESAI!');
  console.log('======================================================');
  console.log(`Tenant Aktif       : SMAS Islam Diponegoro Wagir (${DEFAULT_TENANT_ID})`);
  console.log(`URL Sekolah (SaaS) : http://localhost:3000/s/${DEFAULT_SUBDOMAIN}`);
  console.log(`Login EduOS        : http://localhost:3000/s/${DEFAULT_SUBDOMAIN}/login`);
  console.log(`Login Admin SaaS   : http://localhost:3000/platform/login`);
  console.log(`Total Memberships  : ${membershipCount} akun ditautkan (ACTIVE)`);
  console.log(`Dokumen Ditautkan  : ${stampedCount} dokumen lama diberi tenantId`);
  console.log('Akun Dual-Role (Admin SaaS + Admin EduOS):');
  for (const a of dualAdmins) {
    console.log(`  - ${a.email} (${a.name}) [role: ${a.role}, extra: platform_admin + semua role EduOS]`);
  }
}

main().catch((err) => {
  console.error('Seed tenant gagal:', err);
  process.exit(1);
});
