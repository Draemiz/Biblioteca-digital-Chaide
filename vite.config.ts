import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    base: process.env.VITE_BASE_PATH || '/',
    plugins: [react(), tailwindcss()],
    // NOTE: GEMINI_API_KEY is intentionally NOT injected into the client bundle.
    // Exposing a secret API key in front-end JS is a security risk. If Gemini
    // features are needed, proxy them through a server endpoint instead.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Split very large libraries into their own chunks so the initial JS
      // payload stays small and pdfjs/firebase load on demand.
      rollupOptions: {
        output: {
          manualChunks: {
            pdfjs: ['pdfjs-dist'],
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
      chunkSizeWarningLimit: 1500,
    },
    server: {
      allowedHosts: ['.trycloudflare.com'],
      // HMR is controlled via the DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU.
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {
              ignored: ['**/storage/**', '**/data/**'],
            },
    },
  };
});
