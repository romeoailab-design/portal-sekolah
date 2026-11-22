import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { RowDataPacket } from 'mysql2';
import { getDbPool } from './db';

export interface SessionUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  emailVerified: boolean;
}

const SESSION_COOKIE_NAME = 'portal_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    console.warn('[auth] WARNING: JWT_SECRET is not set in production environment!');
  }
  return secret || 'dev-portal-sekolah-jwt-secret-change-me';
}

export function getSessionUser(req: Request): SessionUser | null {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token || typeof token !== 'string') return null;

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as SessionUser;
    if (!decoded || !decoded.uid || !decoded.email) return null;
    return {
      uid: decoded.uid,
      email: decoded.email,
      displayName: decoded.displayName || '',
      photoURL: decoded.photoURL || '',
      emailVerified: true,
    };
  } catch {
    return null;
  }
}

function setSessionCookie(res: Response, user: SessionUser) {
  const token = jwt.sign(user, getJwtSecret(), { expiresIn: SESSION_TTL_SECONDS });
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

async function verifyGoogleCredentials(params: {
  credential?: string;
  accessToken?: string;
}): Promise<{ sub: string; email: string; name: string; picture: string }> {
  const allowedClientIds = Array.from(
    new Set(
      [
        ...(process.env.GOOGLE_CLIENT_ID || '').split(','),
        ...(process.env.VITE_GOOGLE_CLIENT_ID || '').split(','),
      ]
        .map((id) => id.trim())
        .filter((id) => id && id !== 'dummy_client_id_for_preview')
    )
  );

  if (params.credential) {
    const oauthClient = new OAuth2Client(allowedClientIds[0] || undefined);
    const ticket = await oauthClient.verifyIdToken({
      idToken: params.credential,
      audience: allowedClientIds.length > 0 ? allowedClientIds : undefined,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.sub) {
      throw new Error('Token Google tidak valid');
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase().trim(),
      name: payload.name || payload.email.split('@')[0],
      picture: payload.picture || '',
    };
  }

  if (params.accessToken) {
    // Verify token audience if GOOGLE_CLIENT_ID / VITE_GOOGLE_CLIENT_ID is configured
    if (allowedClientIds.length > 0) {
      const infoRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(params.accessToken)}`
      );
      if (!infoRes.ok) {
        throw new Error('Access token Google tidak valid atau sudah kedaluwarsa');
      }
      const tokenInfo = (await infoRes.json()) as { aud?: string; azp?: string };
      const matchesAllowed = allowedClientIds.some(
        (cid) => tokenInfo.aud === cid || tokenInfo.azp === cid
      );
      if ((tokenInfo.aud || tokenInfo.azp) && !matchesAllowed) {
        throw new Error('Token Google bukan milik aplikasi ini');
      }
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${params.accessToken}` },
    });
    if (!userRes.ok) {
      throw new Error('Gagal mengambil profil akun Google');
    }
    const profile = (await userRes.json()) as {
      sub?: string;
      email?: string;
      name?: string;
      picture?: string;
    };
    if (!profile.email || !profile.sub) {
      throw new Error('Profil Google tidak menyertakan email yang valid');
    }
    return {
      sub: profile.sub,
      email: profile.email.toLowerCase().trim(),
      name: profile.name || profile.email.split('@')[0],
      picture: profile.picture || '',
    };
  }

  throw new Error('Kredensial Google tidak ditemukan');
}

/**
 * Resolves the stable application UID for a Google email.
 * Crucial for migrated Firebase data: if a document in `users` already exists
 * with this email, we reuse its existing `doc_id` so all tenant_memberships,
 * roles, supervisions, and foreign-key references remain 100% intact.
 */
async function resolveOrCreateAuthUser(googleUser: {
  sub: string;
  email: string;
  name: string;
  picture: string;
}): Promise<SessionUser> {
  const pool = getDbPool();
  const now = Date.now();
  const normalizedEmail = googleUser.email.toLowerCase().trim();

  // 1. Check existing auth_users by email
  const [existingAuth] = await pool.query<RowDataPacket[]>(
    'SELECT uid FROM auth_users WHERE email = ? LIMIT 1',
    [normalizedEmail]
  );

  let resolvedUid: string | null = existingAuth.length > 0 ? String(existingAuth[0].uid) : null;

  // 2. If not yet in auth_users, check migrated `users` collection for matching email
  if (!resolvedUid) {
    const [migratedUsers] = await pool.query<RowDataPacket[]>(
      'SELECT doc_id, data FROM app_documents WHERE collection_path = ?',
      ['users']
    );
    for (const row of migratedUsers) {
      try {
        const parsed = JSON.parse(row.data);
        if (typeof parsed?.email === 'string' && parsed.email.toLowerCase().trim() === normalizedEmail) {
          resolvedUid = String(row.doc_id);
          break;
        }
      } catch {
        // Ignore malformed JSON row
      }
    }
  }

  // 3. Fallback to Google sub for brand-new users
  if (!resolvedUid) {
    resolvedUid = googleUser.sub;
  }

  // 4. Upsert into auth_users
  await pool.query(
    `INSERT INTO auth_users (uid, google_sub, email, display_name, photo_url, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       google_sub = VALUES(google_sub),
       display_name = VALUES(display_name),
       photo_url = VALUES(photo_url),
       last_login_at = VALUES(last_login_at)`,
    [resolvedUid, googleUser.sub, normalizedEmail, googleUser.name, googleUser.picture, now, now]
  );

  // 5. Optional Bootstrap Admin auto-creation if BOOTSTRAP_ADMIN_EMAIL matches and user doc doesn't exist yet
  const bootstrapEmails = (process.env.BOOTSTRAP_ADMIN_EMAIL || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (bootstrapEmails.includes(normalizedEmail)) {
    const [existingProfile] = await pool.query<RowDataPacket[]>(
      'SELECT doc_id, data FROM app_documents WHERE collection_path = ? AND doc_id = ? LIMIT 1',
      ['users', resolvedUid]
    );
    if (existingProfile.length === 0) {
      const adminProfile = {
        uid: resolvedUid,
        authUid: resolvedUid,
        email: normalizedEmail,
        name: googleUser.name,
        photoUrl: googleUser.picture,
        role: 'super_admin',
        additionalRoles: ['platform_admin', 'admin', 'teacher', 'curriculum', 'tu', 'bendahara'],
        createdAt: now,
      };
      await pool.query(
        `INSERT INTO app_documents (collection_path, doc_id, tenant_id, data, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?)`,
        ['users', resolvedUid, JSON.stringify(adminProfile), now, now]
      );
    } else {
      // Ensure existing user matching BOOTSTRAP_ADMIN_EMAIL also has platform_admin + super_admin access
      try {
        const current = JSON.parse(existingProfile[0].data);
        const existingAdditional = Array.isArray(current.additionalRoles) ? current.additionalRoles : [];
        const mergedAdditional = Array.from(new Set([...existingAdditional, 'platform_admin', 'super_admin']));
        current.additionalRoles = mergedAdditional;
        await pool.query(
          'UPDATE app_documents SET data = ?, updated_at = ? WHERE collection_path = ? AND doc_id = ?',
          [JSON.stringify(current), now, 'users', resolvedUid]
        );
      } catch {
        // ignore
      }
    }

    // Ensure bootstrap admin has ACTIVE membership on the first active tenant (if any exists)
    const [tenants] = await pool.query<RowDataPacket[]>(
      'SELECT doc_id FROM app_documents WHERE collection_path = ? LIMIT 1',
      ['tenants']
    );
    if (tenants.length > 0) {
      const firstTenantId = String(tenants[0].doc_id);
      const membershipId = `${firstTenantId}_${resolvedUid}`;
      const membershipData = {
        id: membershipId,
        userId: resolvedUid,
        tenantId: firstTenantId,
        roles: ['super_admin', 'platform_admin'],
        permissions: ['*'],
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      };
      await pool.query(
        `INSERT IGNORE INTO app_documents (collection_path, doc_id, tenant_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['tenant_memberships', membershipId, firstTenantId, JSON.stringify(membershipData), now, now]
      );
    }
  }

  return {
    uid: resolvedUid,
    email: normalizedEmail,
    displayName: googleUser.name,
    photoURL: googleUser.picture,
    emailVerified: true,
  };
}

export function createAuthRouter(): Router {
  const router = Router();

  router.get('/me', (req: Request, res: Response) => {
    const user = getSessionUser(req);
    res.json({ success: true, user });
  });

  router.post('/google', async (req: Request, res: Response) => {
    try {
      const { credential, accessToken } = req.body || {};
      const googleUser = await verifyGoogleCredentials({ credential, accessToken });
      const sessionUser = await resolveOrCreateAuthUser(googleUser);
      setSessionCookie(res, sessionUser);
      res.json({ success: true, user: sessionUser });
    } catch (error: any) {
      console.error('[auth/google] Error:', error);
      res.status(401).json({
        success: false,
        error: error?.message || 'Gagal autentikasi dengan Google',
      });
    }
  });

  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ success: true });
  });

  return router;
}
