// What the database bootstrap needs to know about a connection URL: which role it signs in as, with what password,
// and which database it opens.
//
// Managed poolers put a tenant after the role name. Supabase's pooler, for example, signs `salon_owner` in as
// `salon_owner.<project-ref>` (the project ref is 20 lowercase letters and digits). The role itself is still
// `salon_owner`, and that is the name to create, grant to and refer to in SQL.

const SUPABASE_POOLER_USER = /^([a-z_][a-z0-9_]*)\.([a-z0-9]{20})$/;

export interface ConnectionInfo {
  /** The PostgreSQL role, without any pooler tenant suffix. */
  role: string;
  password: string;
  database: string;
  /** The pooler tenant (for example the Supabase project ref) when the user name carried one. */
  poolerTenant: string | null;
}

export function parseConnectionUrl(url: string): ConnectionInfo {
  const u = new URL(url);
  const user = decodeURIComponent(u.username);
  const pooled = SUPABASE_POOLER_USER.exec(user);
  return {
    role: pooled ? pooled[1]! : user,
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    poolerTenant: pooled ? pooled[2]! : null,
  };
}
