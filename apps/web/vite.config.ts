import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['@salon/source'],
  },
  server: {
    port: 5173,
    // The API is same-origin in every environment (proxy in dev, reverse proxy in production), so the refresh
    // cookie can stay SameSite=Strict and no CORS is needed.
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:4000', changeOrigin: false } },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // Stable vendor chunks cache well across releases; the app's own code is split per screen by the router.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router'],
          charts: ['recharts'],
          query: ['@tanstack/react-query'],
          radix: ['radix-ui'],
          forms: ['react-hook-form', '@hookform/resolvers', 'zod'],
          dates: ['date-fns', '@date-fns/tz'],
        },
      },
    },
  },
});
