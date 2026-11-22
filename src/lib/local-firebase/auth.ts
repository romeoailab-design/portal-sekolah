export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
}

export interface UserCredential {
  user: User;
}

export type Unsubscribe = () => void;

export interface Auth {
  currentUser: User | null;
  signOut: () => Promise<void>;
}

export class GoogleAuthProvider {
  providerId = 'google.com';
}

type AuthListener = (user: User | null) => void;

const listeners = new Set<AuthListener>();
let initialized = false;
let initPromise: Promise<User | null> | null = null;

const authInstance: Auth = {
  currentUser: null,
  signOut: () => signOut(),
};

function notifyListeners(user: User | null) {
  authInstance.currentUser = user;
  listeners.forEach((cb) => {
    try {
      cb(user);
    } catch (err) {
      console.error('[local-auth] Listener error:', err);
    }
  });
}

async function fetchCurrentSession(): Promise<User | null> {
  try {
    const res = await fetch('/api/auth/me', {
      method: 'GET',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.user || null;
  } catch (err) {
    console.error('[local-auth] Failed to fetch session:', err);
    return null;
  }
}

function ensureInitialized(): Promise<User | null> {
  if (!initPromise) {
    initPromise = fetchCurrentSession().then((user) => {
      initialized = true;
      notifyListeners(user);
      return user;
    });
  }
  return initPromise;
}

async function ensureGoogleGsiLoaded(): Promise<any> {
  const win = window as any;
  if (win.google?.accounts?.oauth2) {
    return win.google;
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]') as HTMLScriptElement | null;
    if (existing) {
      if (win.google?.accounts?.oauth2) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Gagal memuat Google Identity Services')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Gagal memuat Google Identity Services'));
    document.head.appendChild(script);
  });

  const loadedWin = window as any;
  if (!loadedWin.google?.accounts?.oauth2) {
    throw new Error('Google OAuth tidak tersedia di browser ini.');
  }
  return loadedWin.google;
}

export function getAuth(_app?: any): Auth {
  ensureInitialized();
  return authInstance;
}

export function onAuthStateChanged(_auth: Auth, callback: AuthListener): Unsubscribe {
  listeners.add(callback);
  if (initialized) {
    Promise.resolve().then(() => callback(authInstance.currentUser));
  } else {
    ensureInitialized();
  }
  return () => {
    listeners.delete(callback);
  };
}

export async function signInWithPopup(_auth: Auth, _provider: GoogleAuthProvider): Promise<UserCredential> {
  const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '';
  if (!clientId || clientId === 'dummy_client_id_for_preview') {
    throw new Error('VITE_GOOGLE_CLIENT_ID belum diatur di file .env. Silakan masukkan Google OAuth Client ID Anda.');
  }

  const google = await ensureGoogleGsiLoaded();

  const accessToken = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'openid email profile',
      callback: (response: any) => {
        if (settled) return;
        settled = true;
        if (response?.error) {
          reject(new Error(response.error_description || response.error || 'Login Google dibatalkan'));
          return;
        }
        if (!response?.access_token) {
          reject(new Error('Google tidak mengembalikan token akses'));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: (err: any) => {
        if (settled) return;
        settled = true;
        reject(new Error(err?.message || 'Popup login Google ditutup atau diblokir browser'));
      },
    });

    tokenClient.requestAccessToken({ prompt: 'select_account' });
  });

  const res = await fetch('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ accessToken }),
  });

  const json = await res.json();
  if (!res.ok || !json?.success || !json?.user) {
    throw new Error(json?.error || 'Gagal verifikasi login Google di server');
  }

  initialized = true;
  notifyListeners(json.user);
  return { user: json.user };
}

export async function signOut(_auth?: Auth): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
  } finally {
    initialized = true;
    notifyListeners(null);
  }
}
