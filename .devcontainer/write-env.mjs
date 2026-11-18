// Writes the app's .env for a codespace (see start.sh). Everything is derived, so a new codespace gets the same values:
// - the database URL from DB_APP_PASSWORD and the project settings in devcontainer.json;
// - the app's own secrets from DB_APP_PASSWORD with HMAC. They are only as secret as that password, which already
//   grants access to the data, and staying the same keeps sign-ins and anything encrypted (Settings > Connections)
//   working across codespaces.
import { createHmac } from 'node:crypto';

const e = process.env;
const password = e.DB_APP_PASSWORD;
if (!password) throw new Error('DB_APP_PASSWORD is not set');
const derive = (label) => createHmac('sha256', password).update(`salonos-codespace/${label}`).digest();

// Codespaces serves forwarded ports at https://<codespace>-<port>.<domain>; elsewhere fall back to localhost.
const publicUrl = (port) =>
  e.CODESPACE_NAME && e.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `https://${e.CODESPACE_NAME}-${port}.${e.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : `http://localhost:${port}`;

const settings = {
  NODE_ENV: 'development',
  DATABASE_URL: `postgres://salon_app.${e.SUPABASE_PROJECT_REF}:${encodeURIComponent(password)}@${e.SUPABASE_POOLER_HOST}:6543/postgres?sslmode=verify-full`,
  DB_APP_ROLE: 'salon_app',
  DB_SSL: 'true',
  DB_POOL_MAX: '5',
  JWT_ACCESS_SECRET: derive('jwt').toString('base64url'),
  PUBLIC_LINK_SECRET: derive('public-link').toString('base64url'),
  DATA_ENCRYPTION_KEY: derive('data-encryption').toString('base64'),
  NOTIFICATIONS_MODE: 'console',
  APP_BASE_URL: publicUrl(5173),
  API_BASE_URL: publicUrl(4000),
  CORS_ORIGINS: [publicUrl(5173), 'http://localhost:5173'].join(','),
};
process.stdout.write(Object.entries(settings).map(([k, v]) => `${k}=${v}\n`).join(''));
