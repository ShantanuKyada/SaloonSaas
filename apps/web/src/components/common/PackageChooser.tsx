import { Check, Package } from 'lucide-react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { sellableAt, usePackages, type PackageRow } from '@/lib/packages';
import { cn } from '@/lib/utils';
import { useMoney } from './badges';

/**
 * Packages (or combos) the customer buys at this visit, for the booking and walk-in drawers. Choosing one adds its
 * services to the visit and marks them as paid by it: the package is sold on the visit's bill and those services use
 * its sessions. Removing it takes away the services it added.
 */
export function useVisitPackages(serviceIds: string[], setServiceIds: Dispatch<SetStateAction<string[]>>) {
  const packages = usePackages();
  /** Service → the package bought at this visit that pays for it. */
  const [buyPackage, setBuyPackage] = useState<Record<string, string>>({});
  /** Services that were added by choosing a package (removed again with it). */
  const [addedBy, setAddedBy] = useState<Record<string, string>>({});
  const chosen = [...new Set(Object.values(buyPackage))];
  const without = (map: Record<string, string>, packageId: string) => Object.fromEntries(Object.entries(map).filter(([, id]) => id !== packageId));

  const toggle = (pkg: PackageRow) => {
    if (chosen.includes(pkg.id)) {
      const added = Object.entries(addedBy).filter(([, id]) => id === pkg.id).map(([serviceId]) => serviceId);
      setServiceIds((cur) => cur.filter((id) => !added.includes(id)));
      setBuyPackage((cur) => without(cur, pkg.id));
      setAddedBy((cur) => without(cur, pkg.id));
      return;
    }
    // One session of each included service today; a service already paid by another package stays with that one.
    const covered = pkg.items.map((i) => i.serviceId).filter((id) => !buyPackage[id]);
    const fresh = covered.filter((id) => !serviceIds.includes(id));
    setServiceIds((cur) => [...cur, ...fresh.filter((id) => !cur.includes(id))]);
    setAddedBy((cur) => ({ ...cur, ...Object.fromEntries(fresh.map((id) => [id, pkg.id])) }));
    setBuyPackage((cur) => ({ ...cur, ...Object.fromEntries(covered.map((id) => [id, pkg.id])) }));
  };
  /** A service was taken off the visit: it is no longer paid by a package. */
  const forget = (serviceId: string) => {
    setBuyPackage(({ [serviceId]: _gone, ...rest }) => rest);
    setAddedBy(({ [serviceId]: _gone, ...rest }) => rest);
  };
  const reset = () => {
    setBuyPackage({});
    setAddedBy({});
  };
  const total = chosen.reduce((a, id) => a + (packages.data?.find((p) => p.id === id)?.price ?? 0), 0);
  return { buyPackage, chosen, toggle, forget, reset, total };
}

/** The packages and combos on sale at this branch today, as chips next to the services, plus what choosing one means. */
export function PackageChooser({ branchId, chosen, onToggle }: { branchId: string; chosen: string[]; onToggle: (pkg: PackageRow) => void }) {
  const money = useMoney();
  const q = usePackages();
  const onSale = sellableAt(q.data, branchId);
  const picked = (q.data ?? []).filter((p) => chosen.includes(p.id));
  const shown = [...onSale, ...picked.filter((p) => !onSale.some((s) => s.id === p.id))];
  if (shown.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted">Packages and combos</p>
      <div className="flex flex-wrap gap-2">
        {shown.map((p) => {
          const on = chosen.includes(p.id);
          return (
            <button key={p.id} type="button" aria-pressed={on} onClick={() => onToggle(p)} className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors max-md:min-h-10', on ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line bg-surface text-fg hover:border-primary/50')}>
              {on ? <Check className="size-3.5" aria-hidden /> : <Package className="size-3.5 text-muted" aria-hidden />}
              {p.name}
              <span className="font-normal text-muted">· {money(p.price)}</span>
            </button>
          );
        })}
      </div>
      {picked.map((p) => {
        const later = p.items.filter((i) => i.quantity > 1).map((i) => `${i.quantity - 1} × ${i.serviceName}`);
        return (
          <div key={p.id} className="rounded-xl border border-success/30 bg-success-soft p-3 text-sm" role="status">
            <p className="font-medium">{p.name} ({money(p.price)}) is sold on this visit’s bill</p>
            <p className="mt-0.5 text-xs">
              {p.items.map((i) => i.serviceName).join(', ')} today: nothing more to pay for {p.items.length === 1 ? 'it' : 'them'}.
              {later.length > 0 && ` Left for later visits: ${later.join(', ')}.`}
            </p>
          </div>
        );
      })}
    </div>
  );
}
