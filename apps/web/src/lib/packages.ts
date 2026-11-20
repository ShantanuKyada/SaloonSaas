import type { PackageSegment, PackageState } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import type { Tone } from '@/components/ui/display';
import { api } from '@/lib/api';
import { fmtDay } from '@/lib/format';
import { qk } from '@/lib/queries';

/** A package (or combo) as the API returns it. */
export interface PackageRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price: number;
  taxRateBp: number | null;
  validityDays: number;
  allBranches: boolean;
  customerSegment: PackageSegment;
  maxPerCustomer: number | null;
  saleLimitTotal: number | null;
  soldCount: number;
  saleStartsOn: string | null;
  saleEndsOn: string | null;
  status: string;
  /** Whether it can be sold today: the switch, the sale dates and the sale limit together. */
  state: PackageState;
  items: Array<{ serviceId: string; quantity: number; serviceName: string; servicePrice: number }>;
  originalValue: number;
  savings: number;
  branchIds: string[];
}

/** The badge on a package: whether it can be sold today, and if not, why. */
export function packageBadge(p: Pick<PackageRow, 'state' | 'saleStartsOn'>, timezone: string): { label: string; tone: Tone } {
  switch (p.state) {
    case 'on_sale': return { label: 'On sale', tone: 'success' };
    case 'scheduled': return { label: `On sale from ${fmtDay(p.saleStartsOn, timezone)}`, tone: 'info' };
    case 'ended': return { label: 'Sale ended', tone: 'neutral' };
    case 'sold_out': return { label: 'Sold out', tone: 'warning' };
    case 'archived': return { label: 'Archived', tone: 'neutral' };
    default: return { label: 'Paused', tone: 'neutral' };
  }
}

/** Packages that can be sold at this branch today: on sale (switch, sale dates and sale limit) and sold here. */
export function sellableAt(packages: PackageRow[] | undefined, branchId: string): PackageRow[] {
  return (packages ?? []).filter((p) => p.state === 'on_sale' && (p.allBranches || p.branchIds.includes(branchId)));
}

export function usePackages() {
  return useQuery({ queryKey: qk.packages, queryFn: () => api.get<PackageRow[]>('/packages'), staleTime: 60_000 });
}
