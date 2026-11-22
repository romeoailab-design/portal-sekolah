import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { RowDataPacket, PoolConnection } from 'mysql2/promise';
import { getDbPool } from './db';
import { getSessionUser, SessionUser } from './auth';

// Collections that unauthenticated visitors may read (public website, PPDB landing, domain lookup)
const PUBLIC_READ_COLLECTIONS = new Set([
  'tenant_public_profiles',
  'tenant_cms_contents',
  'website_pages',
  'website_articles',
  'website_settings',
  'tenants',
  'school_profiles',
  'platform_settings',
  'settings',
  'admission_waves',
  'admission_document_requirements',
  'admission_selection_configs',
  'subscription_plans',
  'platform_releases',
  'platform_modules',
  'feature_flags',
  'tenant_modules',
  'tenant_feature_overrides',
  'academic_years',
  'academic_semesters',
  'academic_periods',
]);

// Collections where public visitors may submit forms without signing in
const PUBLIC_CREATE_COLLECTIONS = new Set([
  'subscription_requests',
]);

function isValidCollectionPath(col: unknown): col is string {
  return (
    typeof col === 'string' &&
    col.length > 0 &&
    col.length <= 191 &&
    /^[a-zA-Z0-9_\-\/]+$/.test(col) &&
    !col.includes('..')
  );
}

function isValidDocId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 191 && !id.includes('..');
}

function generateDocId(): string {
  return crypto.randomBytes(12).toString('base64url');
}

function makeServerTimestamp() {
  const now = Date.now();
  return {
    __firestoreTimestamp: true,
    seconds: Math.floor(now / 1000),
    nanoseconds: (now % 1000) * 1_000_000,
  };
}

function resolveSentinelsForCreate(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(resolveSentinelsForCreate);
  if (typeof obj === 'object') {
    if (obj.__firestoreSentinel === 'serverTimestamp') {
      return makeServerTimestamp();
    }
    if (obj.__firestoreSentinel === 'deleteField') {
      return undefined;
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      const resolved = resolveSentinelsForCreate(v);
      if (resolved !== undefined) {
        out[k] = resolved;
      }
    }
    return out;
  }
  return obj;
}

function setNestedField(target: Record<string, any>, keyPath: string, value: any) {
  const parts = keyPath.split('.');
  let current = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  const last = parts[parts.length - 1];
  if (value && typeof value === 'object' && value.__firestoreSentinel === 'deleteField') {
    delete current[last];
  } else {
    const resolved = resolveSentinelsForCreate(value);
    if (resolved !== undefined) {
      current[last] = resolved;
    }
  }
}

function applyMergeOrUpdate(existing: Record<string, any>, patch: Record<string, any>, isDotNotationUpdate: boolean): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(existing || {}));
  for (const [key, val] of Object.entries(patch || {})) {
    if (val && typeof val === 'object' && val.__firestoreSentinel === 'deleteField') {
      if (isDotNotationUpdate && key.includes('.')) {
        setNestedField(clone, key, val);
      } else {
        delete clone[key];
      }
    } else if (isDotNotationUpdate && key.includes('.')) {
      setNestedField(clone, key, val);
    } else {
      const resolved = resolveSentinelsForCreate(val);
      if (resolved !== undefined) {
        clone[key] = resolved;
      }
    }
  }
  return clone;
}

function getFieldValue(docObj: Record<string, any>, docId: string, fieldPath: string): any {
  if (fieldPath === '__name__') return docId;
  const parts = fieldPath.split('.');
  let cur: any = docObj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function normalizeComparable(val: any): any {
  if (val && typeof val === 'object') {
    if (val.__firestoreTimestamp && typeof val.seconds === 'number') {
      return val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1_000_000);
    }
    if (typeof val.seconds === 'number' && typeof val.nanoseconds === 'number') {
      return val.seconds * 1000 + Math.floor(val.nanoseconds / 1_000_000);
    }
  }
  return val;
}

function matchesWhere(docObj: Record<string, any>, docId: string, field: string, op: string, target: any): boolean {
  const rawVal = getFieldValue(docObj, docId, field);
  const val = normalizeComparable(rawVal);
  const cmpTarget = normalizeComparable(target);

  switch (op) {
    case '==':
      return val === cmpTarget;
    case '!=':
      return val !== cmpTarget;
    case '<':
      return val !== undefined && val !== null && val < cmpTarget;
    case '<=':
      return val !== undefined && val !== null && val <= cmpTarget;
    case '>':
      return val !== undefined && val !== null && val > cmpTarget;
    case '>=':
      return val !== undefined && val !== null && val >= cmpTarget;
    case 'in':
      return Array.isArray(target) && target.map(normalizeComparable).includes(val);
    case 'not-in':
      return Array.isArray(target) && !target.map(normalizeComparable).includes(val);
    case 'array-contains':
      return Array.isArray(rawVal) && rawVal.map(normalizeComparable).includes(cmpTarget);
    case 'array-contains-any':
      return (
        Array.isArray(rawVal) &&
        Array.isArray(target) &&
        rawVal.map(normalizeComparable).some((item) => target.map(normalizeComparable).includes(item))
      );
    default:
      return true;
  }
}

function extractTenantId(data: Record<string, any>): string | null {
  if (data && typeof data.tenantId === 'string' && data.tenantId.length > 0 && data.tenantId.length <= 191) {
    return data.tenantId;
  }
  return null;
}

function checkAccess(
  action: 'read' | 'create' | 'write' | 'delete',
  collectionPath: string,
  user: SessionUser | null
): { allowed: boolean; error?: string } {
  if (user) {
    // Supervision deletion restriction mirrored from firestore.rules
    if (collectionPath === 'supervisions' && action === 'delete') {
      return { allowed: false, error: 'Menghapus dokumen supervisi secara langsung tidak diizinkan.' };
    }
    return { allowed: true };
  }

  if (action === 'read' && PUBLIC_READ_COLLECTIONS.has(collectionPath)) {
    return { allowed: true };
  }
  if (action === 'create' && PUBLIC_CREATE_COLLECTIONS.has(collectionPath)) {
    return { allowed: true };
  }

  return { allowed: false, error: 'Autentikasi diperlukan untuk mengakses data ini.' };
}

async function checkSupervisionOwnerOrAdmin(
  poolOrConn: { query: Function },
  user: SessionUser,
  docData: Record<string, any> | null,
  action: 'read' | 'create' | 'update'
): Promise<boolean> {
  if (!docData) return true;
  if (action === 'create') {
    if (!docData.createdBy || docData.createdBy === user.uid) return true;
  }
  if (docData.teacherId === user.uid || docData.principalId === user.uid) {
    return true;
  }
  // Allow platform_admin / super_admin / admin
  const [userRows] = (await poolOrConn.query(
    'SELECT data FROM app_documents WHERE collection_path = ? AND doc_id = ? LIMIT 1',
    ['users', user.uid]
  )) as [RowDataPacket[], any];
  if (userRows.length > 0) {
    try {
      const profile = JSON.parse(userRows[0].data);
      const roles = [profile.role, ...(profile.additionalRoles || [])];
      if (roles.some((r) => ['platform_admin', 'super_admin', 'admin'].includes(r))) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export function createFirestoreRouter(): Router {
  const router = Router();

  // GET SINGLE DOC
  router.post('/get-doc', async (req: Request, res: Response) => {
    try {
      const { collectionPath, docId } = req.body || {};
      if (!isValidCollectionPath(collectionPath) || !isValidDocId(docId)) {
        return res.status(400).json({ success: false, error: 'Invalid collectionPath or docId' });
      }

      const user = getSessionUser(req);
      const access = checkAccess('read', collectionPath, user);
      if (!access.allowed) {
        return res.status(401).json({ success: false, error: access.error });
      }

      const pool = getDbPool();
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT doc_id, data FROM app_documents WHERE collection_path = ? AND doc_id = ? LIMIT 1',
        [collectionPath, docId]
      );

      if (rows.length === 0) {
        return res.json({ success: true, exists: false, id: docId, data: null });
      }

      const parsed = JSON.parse(rows[0].data);
      if (collectionPath === 'supervisions' && user) {
        const ok = await checkSupervisionOwnerOrAdmin(pool, user, parsed, 'read');
        if (!ok) {
          return res.status(403).json({ success: false, error: 'Akses supervisi ditolak.' });
        }
      }

      res.json({ success: true, exists: true, id: rows[0].doc_id, data: parsed });
    } catch (error) {
      console.error('[db/get-doc] Error:', error);
      res.status(500).json({ success: false, error: 'Gagal membaca dokumen dari MySQL' });
    }
  });

  // QUERY DOCS
  router.post('/query', async (req: Request, res: Response) => {
    try {
      const { collectionPath, constraints = [] } = req.body || {};
      if (!isValidCollectionPath(collectionPath)) {
        return res.status(400).json({ success: false, error: 'Invalid collectionPath' });
      }

      const user = getSessionUser(req);
      const access = checkAccess('read', collectionPath, user);
      if (!access.allowed) {
        return res.status(401).json({ success: false, error: access.error });
      }

      const whereList = Array.isArray(constraints)
        ? constraints.filter((c: any) => c?.type === 'where')
        : [];
      const orderList = Array.isArray(constraints)
        ? constraints.filter((c: any) => c?.type === 'orderBy')
        : [];
      const limitClause = Array.isArray(constraints)
        ? constraints.find((c: any) => c?.type === 'limit')
        : null;

      // Fast-path SQL filter on indexed tenant_id when available
      const tenantEq = whereList.find(
        (w: any) => w.field === 'tenantId' && w.op === '==' && typeof w.value === 'string'
      );

      const pool = getDbPool();
      let rows: RowDataPacket[];
      if (tenantEq) {
        const [r] = await pool.query<RowDataPacket[]>(
          'SELECT doc_id, data FROM app_documents WHERE collection_path = ? AND tenant_id = ?',
          [collectionPath, tenantEq.value]
        );
        rows = r;
      } else {
        const [r] = await pool.query<RowDataPacket[]>(
          'SELECT doc_id, data FROM app_documents WHERE collection_path = ?',
          [collectionPath]
        );
        rows = r;
      }

      let docs = rows
        .map((row) => {
          try {
            return { id: String(row.doc_id), data: JSON.parse(row.data) };
          } catch {
            return null;
          }
        })
        .filter((d): d is { id: string; data: Record<string, any> } => d !== null);

      // Apply supervision ownership filter if non-admin
      if (collectionPath === 'supervisions' && user) {
        const filtered: typeof docs = [];
        for (const d of docs) {
          if (await checkSupervisionOwnerOrAdmin(pool, user, d.data, 'read')) {
            filtered.push(d);
          }
        }
        docs = filtered;
      }

      // Apply all where filters
      for (const w of whereList) {
        docs = docs.filter((d) => matchesWhere(d.data, d.id, w.field, w.op, w.value));
      }

      // Apply orderBy sorting
      if (orderList.length > 0) {
        docs.sort((a, b) => {
          for (const ord of orderList) {
            const av = normalizeComparable(getFieldValue(a.data, a.id, ord.field));
            const bv = normalizeComparable(getFieldValue(b.data, b.id, ord.field));
            if (av === bv) continue;
            if (av === undefined || av === null) return ord.direction === 'desc' ? 1 : -1;
            if (bv === undefined || bv === null) return ord.direction === 'desc' ? -1 : 1;
            const cmp = av < bv ? -1 : 1;
            return ord.direction === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
      }

      // Apply limit
      if (limitClause && typeof limitClause.value === 'number' && limitClause.value >= 0) {
        docs = docs.slice(0, limitClause.value);
      }

      res.json({ success: true, docs });
    } catch (error) {
      console.error('[db/query] Error:', error);
      res.status(500).json({ success: false, error: 'Gagal menjalankan query MySQL' });
    }
  });

  // SET DOC
  router.post('/set-doc', async (req: Request, res: Response) => {
    try {
      const { collectionPath, docId, data, merge = false } = req.body || {};
      if (!isValidCollectionPath(collectionPath) || !isValidDocId(docId)) {
        return res.status(400).json({ success: false, error: 'Invalid collectionPath or docId' });
      }

      const user = getSessionUser(req);
      const access = checkAccess('write', collectionPath, user);
      if (!access.allowed) {
        return res.status(401).json({ success: false, error: access.error });
      }

      const pool = getDbPool();
      const now = Date.now();
      let finalData: Record<string, any>;

      if (merge) {
        const [existing] = await pool.query<RowDataPacket[]>(
          'SELECT data FROM app_documents WHERE collection_path = ? AND doc_id = ? LIMIT 1',
          [collectionPath, docId]
        );
        const existingObj = existing.length > 0 ? JSON.parse(existing[0].data) : {};
        finalData = applyMergeOrUpdate(existingObj, data || {}, false);
      } else {
        finalData = resolveSentinelsForCreate(data || {});
      }

      const tenantId = extractTenantId(finalData);
      await pool.query(
        `INSERT INTO app_documents (collection_path, doc_id, tenant_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           tenant_id = VALUES(tenant_id),
           data = VALUES(data),
           updated_at = VALUES(updated_at)`,
        [collectionPath, docId, tenantId, JSON.stringify(finalData), now, now]
      );

      res.json({ success: true, id: docId });
    } catch (error) {
      console.error('[db/set-doc] Error:', error);
      res.status(500).json({ success: false, error: 'Gagal menyimpan dokumen ke MySQL' });
    }
  });

  // ADD DOC
  router.post('/add-doc', async (req: Request, res: Response) => {
    try {
      const { collectionPath, data } = req.body || {};
      if (!isValidCollectionPath(collectionPath)) {
        return res.status(400).json({ success: false, error: 'Invalid collectionPath' });
      }

      const user = getSessionUser(req);
      const access = checkAccess('create', collectionPath, user);
      if (!access.allowed) {
        return res.status(401).json({ success: false, error: access.error });
      }

      const pool = getDbPool();
      const docId = generateDocId();
      const now = Date.now();
      const finalData = resolveSentinelsForCreate(data || {});
      const tenantId = extractTenantId(finalData);

      await pool.query(
        `INSERT INTO app_documents (collection_path, doc_id, tenant_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [collectionPath, docId, tenantId, JSON.stringify(finalData), now, now]
      );

      res.json({ success: true, id: docId });
    } catch (error) {
      console.error('[db/add-doc] Error:', error);
      res.status(500).json({ success: false, error: 'Gagal menambahkan dokumen ke MySQL' });
    }
  });

  // UPDATE DOC
  router.post('/update-doc', async (req: Request, res: Response) => {
    try {
      const { collectionPath, docId, data } = req.body || {};
      if (!isValidCollectionPath(collectionPath) || !isValidDocId(docId)) {
        return res.status(400).json({ success: false, error: 'Invalid collectionPath or docId' });
      }

      const user = getSessionUser(req);
      const access = checkAccess('write', collectionPath, user);
      if (!access.allowed) {
        return res.status(401).json({ success: false, error: access.error });
      }

      const pool = getDbPool();
      const [existing] = await pool.query<RowDataPacket[]>(
        'SELECT data FROM app_documents WHERE collection_path = ? AND doc_id = ? LIMIT 1',
        [collectionPath, docId]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, error: `Dokumen ${collectionPath}/${docId} tidak ditemukan` });
      }

      const existingObj = JSON.parse(existing[0].data);
      if (collectionPath === 'supervisions' && user) {
        const ok = await checkSupervisionOwnerOrAdmin(pool, user, existingObj, 'update');
        if (!ok) {
          return res.status(403).json({ success: false, error: 'Tidak diizinkan mengubah supervisi ini.' });
        }
      }

      const finalData = applyMergeOrUpdate(existingObj, data || {}, true);
      const tenantId = extractTenantId(finalData);
      const now = Date.now();

      await pool.query(
        'UPDATE app_documents SET tenant_id = ?, data = ?, updated_at = ? WHERE collection_path = ? AND doc_id = ?',
        [tenantId, JSON.stringify(finalData), now, collectionPath, docId]
      );

      res.json({ success: true, id: docId });
    } catch (error) {
      console.error('[db/update-doc] Error:', error);
      res.status(500).json({ success: false, error: 'Gagal memperbarui dokumen di MySQL' });
    }
  });

  // DELETE DOC
  router.post('/delete-doc', async (req: Request, res: Response) => {
    try {
      const { collectionPath, docId } = req.body || {};
      if (!isValidCollectionPath(collectionPath) || !isValidDocId(docId)) {
        return res.status(400).json({ success: false, error: 'Invalid collectionPath or docId' });
      }

      const user = getSessionUser(req);
      const access = checkAccess('delete', collectionPath, user);
      if (!access.allowed) {
        return res.status(user ? 403 : 401).json({ success: false, error: access.error });
      }

      const pool = getDbPool();
      await pool.query(
        'DELETE FROM app_documents WHERE collection_path = ? AND doc_id = ?',
        [collectionPath, docId]
      );

      res.json({ success: true });
    } catch (error) {
      console.error('[db/delete-doc] Error:', error);
      res.status(500).json({ success: false, error: 'Gagal menghapus dokumen di MySQL' });
    }
  });

  // WRITE BATCH (ATOMIC MYSQL TRANSACTION)
  router.post('/batch', async (req: Request, res: Response) => {
    const { operations = [] } = req.body || {};
    if (!Array.isArray(operations)) {
      return res.status(400).json({ success: false, error: 'Invalid operations array' });
    }

    const user = getSessionUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Autentikasi diperlukan untuk batch write.' });
    }

    const pool = getDbPool();
    let conn: PoolConnection | null = null;

    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const now = Date.now();

      for (const op of operations) {
        const { type, collectionPath, docId, data, merge = false } = op || {};
        if (!isValidCollectionPath(collectionPath) || !isValidDocId(docId)) {
          throw new Error('Invalid batch operation target');
        }
        const actionType = type === 'delete' ? 'delete' : 'write';
        const access = checkAccess(actionType, collectionPath, user);
        if (!access.allowed) {
          throw new Error(access.error || 'Akses ditolak');
        }

        if (type === 'set') {
          let finalData: Record<string, any>;
          if (merge) {
            const [existing] = await conn.query<RowDataPacket[]>(
              'SELECT data FROM app_documents WHERE collection_path = ? AND doc_id = ? LIMIT 1',
              [collectionPath, docId]
            );
            const existingObj = existing.length > 0 ? JSON.parse(existing[0].data) : {};
            finalData = applyMergeOrUpdate(existingObj, data || {}, false);
          } else {
            finalData = resolveSentinelsForCreate(data || {});
          }
          const tenantId = extractTenantId(finalData);
          await conn.query(
            `INSERT INTO app_documents (collection_path, doc_id, tenant_id, data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               tenant_id = VALUES(tenant_id),
               data = VALUES(data),
               updated_at = VALUES(updated_at)`,
            [collectionPath, docId, tenantId, JSON.stringify(finalData), now, now]
          );
        } else if (type === 'update') {
          const [existing] = await conn.query<RowDataPacket[]>(
            'SELECT data FROM app_documents WHERE collection_path = ? AND doc_id = ? LIMIT 1',
            [collectionPath, docId]
          );
          const existingObj = existing.length > 0 ? JSON.parse(existing[0].data) : {};
          const finalData = applyMergeOrUpdate(existingObj, data || {}, true);
          const tenantId = extractTenantId(finalData);
          await conn.query(
            `INSERT INTO app_documents (collection_path, doc_id, tenant_id, data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               tenant_id = VALUES(tenant_id),
               data = VALUES(data),
               updated_at = VALUES(updated_at)`,
            [collectionPath, docId, tenantId, JSON.stringify(finalData), now, now]
          );
        } else if (type === 'delete') {
          await conn.query(
            'DELETE FROM app_documents WHERE collection_path = ? AND doc_id = ?',
            [collectionPath, docId]
          );
        }
      }

      await conn.commit();
      res.json({ success: true, count: operations.length });
    } catch (error: any) {
      if (conn) {
        try {
          await conn.rollback();
        } catch {
          // ignore rollback error
        }
      }
      console.error('[db/batch] Error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Gagal menjalankan batch write' });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
}
