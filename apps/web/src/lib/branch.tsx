import type { BranchSummary } from '@salon/shared';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useUser } from './auth';

// Every screen works in the context of a branch. Receptionists have one; owners can look at one or all.

interface BranchContextValue {
  branches: BranchSummary[];
  /** 'all' or a branch id. */
  selection: string;
  setSelection: (value: string) => void;
  canChoose: boolean;
  /** A single concrete branch for screens that cannot span branches (calendar, front desk). */
  branchId: string;
  branch: BranchSummary;
  /** Branch filter for list endpoints: undefined means every branch the user can see. */
  scopeBranchId: string | undefined;
  timezone: string;
  currency: string;
}

const Ctx = createContext<BranchContextValue | null>(null);
const storageKey = (orgId: string | undefined) => `salonos:branch:${orgId ?? 'none'}`;

function readStored(orgId: string | undefined): string | null {
  try {
    return localStorage.getItem(storageKey(orgId));
  } catch {
    return null;
  }
}

export function BranchProvider({ children }: { children: ReactNode }) {
  const user = useUser();
  const branches = useMemo(() => user.branches.filter((b) => b.status === 'active'), [user.branches]);
  const [selection, setSelectionState] = useState<string>(() => {
    const stored = readStored(user.organization?.id);
    if (stored === 'all' && branches.length > 1) return 'all';
    if (stored && branches.some((b) => b.id === stored)) return stored;
    return branches[0]?.id ?? 'all';
  });

  useEffect(() => {
    if (selection !== 'all' && !branches.some((b) => b.id === selection)) setSelectionState(branches[0]?.id ?? 'all');
  }, [branches, selection]);

  const value = useMemo<BranchContextValue>(() => {
    const first = branches[0];
    const current = branches.find((b) => b.id === selection) ?? first;
    return {
      branches,
      selection,
      setSelection(v) {
        setSelectionState(v);
        try {
          localStorage.setItem(storageKey(user.organization?.id), v);
        } catch {
          /* private mode: selection simply is not remembered */
        }
      },
      canChoose: branches.length > 1,
      branchId: current?.id ?? '',
      branch: current ?? { id: '', code: '', name: '', timezone: 'Asia/Kolkata', status: 'active', phone: null },
      scopeBranchId: selection === 'all' ? undefined : current?.id,
      timezone: current?.timezone ?? user.organization?.timezone ?? 'Asia/Kolkata',
      currency: user.organization?.currency ?? 'INR',
    };
  }, [branches, selection, user.organization]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBranch(): BranchContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useBranch must be used inside BranchProvider');
  return ctx;
}
