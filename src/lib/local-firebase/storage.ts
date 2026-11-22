export interface FirebaseStorage {
  type: 'local-disk-storage';
}

export interface StorageReference {
  fullPath: string;
  name: string;
  bucket: string;
  _uploadedUrl?: string;
}

const defaultStorage: FirebaseStorage = { type: 'local-disk-storage' };

export function getStorage(_app?: any): FirebaseStorage {
  return defaultStorage;
}

export function ref(_storage: FirebaseStorage, path = ''): StorageReference {
  const clean = path.replace(/^\/+/, '');
  const parts = clean.split('/');
  return {
    fullPath: clean,
    name: parts[parts.length - 1] || '',
    bucket: 'local-uploads',
  };
}

export async function uploadBytes(
  storageRef: StorageReference,
  data: Blob | File | Uint8Array | ArrayBuffer
): Promise<{ ref: StorageReference }> {
  const formData = new FormData();
  const blob =
    data instanceof Blob
      ? data
      : new Blob([data instanceof ArrayBuffer ? data : new Uint8Array(data)]);

  formData.append('path', storageRef.fullPath);
  formData.append('file', blob, storageRef.name || 'upload.bin');

  const res = await fetch('/api/storage/upload', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) {
    throw new Error(json?.error || 'Gagal mengunggah file ke server');
  }

  storageRef._uploadedUrl = json.url;
  return { ref: storageRef };
}

export async function getDownloadURL(storageRef: StorageReference): Promise<string> {
  if (storageRef._uploadedUrl) {
    return storageRef._uploadedUrl;
  }
  const safePath = storageRef.fullPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[^a-zA-Z0-9._\-]/g, '_'))
    .join('/');
  return `/uploads/${safePath}`;
}

export async function deleteObject(storageRef: StorageReference): Promise<void> {
  const res = await fetch('/api/storage/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ path: storageRef.fullPath }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) {
    throw new Error(json?.error || 'Gagal menghapus file di server');
  }
}
