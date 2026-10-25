import { lazy, Suspense, createContext, useContext, useMemo, useState, type ReactNode } from 'react';

// Quick actions are reachable from everywhere (top bar, keyboard shortcuts, search results): the same booking, walk-in
// and add-customer screens open over whatever page the receptionist is on, so nothing interrupts the phone call.

const NewAppointmentDrawer = lazy(() => import('@/features/appointments/NewAppointmentDrawer'));
const WalkInDrawer = lazy(() => import('@/features/walkins/WalkInDrawer'));
const CustomerFormModal = lazy(() => import('@/features/customers/CustomerFormModal'));

export interface NewAppointmentPrefill {
  customerId?: string;
  serviceId?: string;
  staffId?: string;
  /** Local date YYYY-MM-DD */
  date?: string;
  /** ISO instant */
  startAt?: string;
  branchId?: string;
  onCreated?: (appointmentId: string) => void;
}

interface QuickActionsValue {
  newAppointment: (prefill?: NewAppointmentPrefill) => void;
  walkIn: (prefill?: { customerId?: string }) => void;
  newCustomer: (opts?: { name?: string; mobile?: string; onCreated?: (customerId: string) => void }) => void;
}

const Ctx = createContext<QuickActionsValue | null>(null);

export function QuickActionsProvider({ children }: { children: ReactNode }) {
  const [appointment, setAppointment] = useState<NewAppointmentPrefill | null>(null);
  const [walkIn, setWalkIn] = useState<{ customerId?: string } | null>(null);
  const [customer, setCustomer] = useState<{ name?: string; mobile?: string; onCreated?: (id: string) => void } | null>(null);

  const value = useMemo<QuickActionsValue>(
    () => ({
      newAppointment: (p) => setAppointment(p ?? {}),
      walkIn: (p) => setWalkIn(p ?? {}),
      newCustomer: (o) => setCustomer(o ?? {}),
    }),
    [],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <Suspense fallback={null}>
        {appointment && <NewAppointmentDrawer prefill={appointment} onClose={() => setAppointment(null)} />}
        {walkIn && <WalkInDrawer prefill={walkIn} onClose={() => setWalkIn(null)} />}
        {customer && <CustomerFormModal initial={customer} onClose={() => setCustomer(null)} onCreated={customer.onCreated} />}
      </Suspense>
    </Ctx.Provider>
  );
}

export function useQuickActions(): QuickActionsValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useQuickActions must be used inside QuickActionsProvider');
  return ctx;
}
