import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Matches modules inside the given npm packages (scoped names allowed); used for the vendor chunk groups below. */
const inPackages = (...names: string[]) => new RegExp(`[\\\\/]node_modules[\\\\/](${names.map((n) => n.replace('/', '[\\\\/]')).join('|')})[\\\\/]`);

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
    rolldownOptions: {
      output: {
        // Stable vendor chunks cache well across releases; the app's own code is split per screen by the router.
        // A group also takes the packages its modules depend on, so React's group goes first (highest priority) and
        // keeps React out of the other chunks.
        codeSplitting: {
          groups: [
            { name: 'react', test: inPackages('react', 'react-dom', 'react-router', 'scheduler'), priority: 2 },
            { name: 'charts', test: inPackages('recharts'), priority: 1 },
            { name: 'query', test: inPackages('@tanstack/react-query', '@tanstack/query-core'), priority: 1 },
            { name: 'radix', test: inPackages('radix-ui', '@radix-ui'), priority: 1 },
            { name: 'forms', test: inPackages('react-hook-form', '@hookform/resolvers', 'zod'), priority: 1 },
            { name: 'dates', test: inPackages('date-fns', '@date-fns/tz'), priority: 1 },
          ],
        },
      },
    },
  },
});
