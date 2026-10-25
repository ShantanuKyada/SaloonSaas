import { reportQuery, type ReportQuery } from '@salon/shared';
import { audit } from '../../core/audit.js';
import { branchFilter, hasPermission, requireOrgId } from '../../core/auth-context.js';
import { toCsv } from '../../core/csv.js';
import { AppError } from '../../core/errors.js';
import { createRouter, FileResponse } from '../../core/router.js';
import { loadOrg, loadSettings } from '../../core/validation.js';
import { canSeeContact } from '../customers/service.js';
import { REPORTS, reportsFor, type ReportColumn } from './definitions.js';

const r = createRouter('/reports', 'Reports');
const ALL = ['reports.operations', 'reports.financial', 'reports.staff', 'attendance.view', 'ledger.view'] as const;
const CSV_ROW_CAP = 50_000;

r.get('/', { summary: 'Reports you can run, grouped for the Reports menu', permissions: [...ALL] }, async ({ auth }) => {
  const groups = new Map<string, Array<{ key: string; title: string; description: string }>>();
  for (const def of reportsFor(auth)) {
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group)!.push({ key: def.key, title: def.title, description: def.description });
  }
  return [...groups.entries()].map(([group, reports]) => ({ group, reports }));
});

function csvValue(type: ReportColumn['type'], value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (type === 'money' && typeof value === 'number') return (value / 100).toFixed(2);
  if (type === 'datetime' && typeof value === 'string') return value.replace('T', ' ').slice(0, 19);
  return value;
}

r.get('/:key', { summary: 'Run a report (JSON with server-side paging, or CSV that opens in Excel)', permissions: [...ALL], query: reportQuery }, async ({ tx, auth, params, query }) => {
  const def = REPORTS.find((x) => x.key === params.key);
  if (!def) throw new AppError(404, 'NOT_FOUND', 'That report does not exist.');
  if (!def.permissions.some((p) => hasPermission(auth, p))) throw new AppError(403, 'FORBIDDEN', "You don't have permission to view this report.");
  if (query.to < query.from) throw new AppError(400, 'VALIDATION_ERROR', '"From" must be on or before "To".');
  const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
  if (days > 800) throw new AppError(400, 'BAD_REQUEST', 'Choose a date range of at most two years.');

  return tx(async (t) => {
    const orgId = requireOrgId(auth);
    const [org, settings] = await Promise.all([loadOrg(t, orgId), loadSettings(t, orgId)]);
    const asCsv = query.format === 'csv';
    const q: ReportQuery = query;
    const result = await def.run({
      tx: t,
      auth,
      orgId,
      org,
      branches: branchFilter(auth, q.branchId),
      q,
      contactVisible: canSeeContact(auth, settings),
      limit: asCsv ? CSV_ROW_CAP : q.pageSize,
      offset: asCsv ? 0 : (q.page - 1) * q.pageSize,
    });

    if (asCsv) {
      await audit(t, auth, { action: 'report.exported', entityType: 'report', entityId: def.key, summary: `Exported "${def.title}" (${q.from} to ${q.to})`, after: { rows: result.rows.length } });
      const rows = result.rows.map((row) => result.columns.map((c) => csvValue(c.type, row[c.key])));
      if (result.totals) rows.push(result.columns.map((c) => csvValue(c.type, result.totals![c.key])));
      return new FileResponse(`${def.key}_${q.from}_to_${q.to}.csv`, 'text/csv; charset=utf-8', toCsv(result.columns.map((c) => c.label), rows));
    }

    const data = { key: def.key, title: def.title, description: def.description, columns: result.columns, totals: result.totals ?? null, note: result.note ?? null, params: { from: q.from, to: q.to, branchId: q.branchId ?? null, groupBy: q.groupBy }, currency: org.currency, generatedAt: new Date().toISOString() };
    // Aggregated reports return every row at once; long detail reports are paged in SQL (page/pageSize/total below).
    return { ...data, rows: result.rows, page: q.page, pageSize: q.pageSize, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)) };
  });
});

export const reportRoutes = r;
