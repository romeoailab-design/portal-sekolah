import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { getSessionUser } from './auth';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max per upload
  },
});

export function getUploadsRootDir(): string {
  const configured = process.env.UPLOAD_DIR;
  const rootDir = configured ? path.resolve(configured) : path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }
  return rootDir;
}

function sanitizeRelativeStoragePath(rawPath: string): string {
  const normalized = rawPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) => segment.replace(/[^a-zA-Z0-9._\-]/g, '_'))
    .join('/');

  if (!normalized) {
    throw new Error('Path file tidak valid');
  }
  return normalized;
}

export function createStorageRouter(): Router {
  const router = Router();

  router.post('/upload', upload.single('file'), (req: Request, res: Response) => {
    try {
      const user = getSessionUser(req);
      if (!user) {
        return res.status(401).json({ success: false, error: 'Autentikasi diperlukan untuk mengunggah file.' });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: 'File tidak ditemukan dalam permintaan.' });
      }

      const requestedPath = String(req.body?.path || `${Date.now()}_${file.originalname || 'file'}`);
      const safeRelPath = sanitizeRelativeStoragePath(requestedPath);
      const rootDir = getUploadsRootDir();
      const targetFullPath = path.resolve(rootDir, safeRelPath);

      if (!targetFullPath.startsWith(rootDir)) {
        return res.status(400).json({ success: false, error: 'Path penyimpanan tidak diizinkan.' });
      }

      fs.mkdirSync(path.dirname(targetFullPath), { recursive: true });
      fs.writeFileSync(targetFullPath, file.buffer);

      const publicUrl = `/uploads/${safeRelPath}`;
      res.json({ success: true, path: safeRelPath, url: publicUrl });
    } catch (error: any) {
      console.error('[storage/upload] Error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Gagal mengunggah file' });
    }
  });

  router.post('/delete', (req: Request, res: Response) => {
    try {
      const user = getSessionUser(req);
      if (!user) {
        return res.status(401).json({ success: false, error: 'Autentikasi diperlukan untuk menghapus file.' });
      }

      const requestedPath = String(req.body?.path || '');
      const safeRelPath = sanitizeRelativeStoragePath(requestedPath);
      const rootDir = getUploadsRootDir();
      const targetFullPath = path.resolve(rootDir, safeRelPath);

      if (!targetFullPath.startsWith(rootDir)) {
        return res.status(400).json({ success: false, error: 'Path penyimpanan tidak diizinkan.' });
      }

      if (fs.existsSync(targetFullPath)) {
        fs.unlinkSync(targetFullPath);
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error('[storage/delete] Error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Gagal menghapus file' });
    }
  });

  return router;
}
