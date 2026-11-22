import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        'firebase/app': path.resolve(__dirname, 'src/lib/local-firebase/app.ts'),
        'firebase/auth': path.resolve(__dirname, 'src/lib/local-firebase/auth.ts'),
        'firebase/firestore': path.resolve(__dirname, 'src/lib/local-firebase/firestore.ts'),
        'firebase/storage': path.resolve(__dirname, 'src/lib/local-firebase/storage.ts'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
