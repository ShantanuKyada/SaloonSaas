import type { AppointmentDto, CustomerDetail, ServiceDto, StaffListItem } from '@salon/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

// Shared, cached lookups used by many screens. Keeping them here means the booking screen, the bill screen and the
// walk-in screen all see the same service list without refetching it.

export const qk = {
  services: (branchId?: string) => ['services', branchId ?? 'all'] as const,
  staff: (branchId?: string, serviceId?: string) => ['staff', branchId ?? 'all', serviceId ?? 'any'] as const,
  categories: ['service-categories'] as const,
  expertise: ['expertise'] as const,
  customer: (id: string) => ['customer', id] as const,
  customer360: (id: string) => ['customer-360', id] as const,
  appointment: (id: string) => ['appointment', id] as const,
  invoice: (id: string) => ['invoice', id] as const,
  payment: (id: string) => ['payment', id] as const,
  roles: ['roles'] as const,
  branchesFull: ['branches-full'] as const,
  offers: ['offers'] as const,
  packages: ['packages'] as const,
};

export function useServices(branchId?: string, opts: { popular?: boolean; includeInactive?: boolean } = {}) {
  return useQuery({
    queryKey: [...qk.services(branchId), opts.popular ?? false, opts.includeInactive ?? false],
    queryFn: () => api.get<ServiceDto[]>('/services', { branchId, sort: opts.popular ? 'popular' : undefined, includeInactive: opts.includeInactive ? 'true' : undefined }),
    staleTime: 60_000,
  });
}

export function useStaffList(branchId?: string, opts: { serviceId?: string; bookableOnly?: boolean; status?: 'active' | 'all' | 'inactive' } = {}) {
  return useQuery({
    queryKey: [...qk.staff(branchId, opts.serviceId), opts.bookableOnly ?? false, opts.status ?? 'active'],
    queryFn: async () => (await api.list<StaffListItem>('/staff', { branchId, serviceId: opts.serviceId, bookableOnly: opts.bookableOnly ? 'true' : undefined, status: opts.status ?? 'active', pageSize: 100 })).rows,
    staleTime: 60_000,
  });
}

export function useCategories() {
  return useQuery({ queryKey: qk.categories, queryFn: () => api.get<Array<{ id: string; name: string; description: string | null; color: string; sortOrder: number; status: string; serviceCount: number }>>('/service-categories'), staleTime: 60_000 });
}

export function useExpertise() {
  return useQuery({ queryKey: qk.expertise, queryFn: () => api.get<Array<{ id: string; name: string; description: string | null; staffCount: number; serviceCount: number }>>('/expertise'), staleTime: 60_000 });
}

export function useCustomer(id: string | undefined) {
  return useQuery({ queryKey: qk.customer(id ?? ''), queryFn: () => api.get<CustomerDetail>(`/customers/${id}`), enabled: !!id });
}

export function useAppointment(id: string | undefined) {
  return useQuery({ queryKey: qk.appointment(id ?? ''), queryFn: () => api.get<AppointmentDto>(`/appointments/${id}`), enabled: !!id });
}

export type ServiceLookup = Map<string, ServiceDto>;
export function toLookup(services: ServiceDto[] | undefined): ServiceLookup {
  return new Map((services ?? []).map((s) => [s.id, s]));
}
