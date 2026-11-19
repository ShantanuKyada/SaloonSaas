import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type Express } from 'express';

// Serves the built web app (apps/web/dist) from the API's own address, for hosts that run one service (Render, Cloud
// Run). Same rules as deploy/nginx/web.conf: hashed assets are cached for a year, index.html is always revalidated,
// unknown /assets/ files are 404s, and every other GET that is not the API returns the app shell so client-side routes
// (/customers/..., /book/...) work on reload. Being same-origin keeps the SameSite=Strict refresh cookie working.

// Paths that never get the app shell: the API and its probes, and build assets (a missing one is a plain 404).
const NOT_THE_APP = /^\/(api|health|ready|metrics|assets)(\/|$)/;

export function serveWebApp(app: Express, dir: string): void {
  const root = resolve(dir);
  const shell = join(root, 'index.html');
  if (!existsSync(shell)) throw new Error(`WEB_DIST_DIR has no index.html: ${root} (build the web app first)`);

  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });
  app.use('/assets', express.static(join(root, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  app.use(express.static(root, { index: false, maxAge: 0 }));
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || NOT_THE_APP.test(req.path)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(shell);
  });
}
