import type { CommissionType, EmploymentStatus, EmploymentType } from '@salon/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** The full team-member record returned by GET /staff/:id. */
export interface StaffDetail {
  id: string;
  employeeCode: string;
  fullName: string;
  displayName: string;
  branchId: string;
  gender: string;
  dateOfBirth: string | null;
  mobile: string | null;
  email: string | null;
  address: string | null;
  joiningDate: string | null;
  exitDate: string | null;
  designation: string | null;
  employmentType: EmploymentType;
  employmentStatus: EmploymentStatus;
  biometricPunchId: string | null;
  photoUrl: string | null;
  calendarColor: string;
  calendarOrder: number;
  isBookable: boolean;
  onlineBookable: boolean;
  commissionType: CommissionType | null;
  commissionValue: number | null;
  notes: string | null;
  userId: string | null;
  branch: { id: string; name: string; timezone: string };
  expertise: Array<{ id: string; name: string }>;
  services: StaffServiceRow[];
  weeklySchedule: {
    shifts: Array<{ id: string; weekday: number; startTime: string; endTime: string }>;
    breaks: Array<{ id: string; weekday: number; startTime: string; endTime: string; label: string }>;
  };
  weeklyOffDays: number[];
  login: { id: string; email: string; phone: string | null; status: string; lastLoginAt: string | null } | null;
}

export interface StaffServiceRow {
  serviceId: string;
  serviceName: string;
  categoryName: string;
  defaultDuration: number;
  defaultPrice: number;
  durationMinutes: number | null;
  priceOverride: number | null;
  commissionType: CommissionType | null;
  commissionValue: number | null;
  isActive: boolean;
}

export const staffDetailKey = (id: string) => ['staff-detail', id] as const;

export function useStaffDetail(id: string | undefined) {
  return useQuery({ queryKey: staffDetailKey(id ?? ''), queryFn: () => api.get<StaffDetail>(`/staff/${id}`), enabled: !!id });
}

/** Details for a whole team at once (the schedule overview and the service matrix need everyone's hours or services). */
export function useStaffDetails(ids: string[]) {
  const results = useQueries({ queries: ids.map((id) => ({ queryKey: staffDetailKey(id), queryFn: () => api.get<StaffDetail>(`/staff/${id}`), staleTime: 30_000 })) });
  return {
    details: results.map((r) => r.data).filter((d): d is StaffDetail => !!d),
    loading: results.some((r) => r.isLoading),
    error: results.find((r) => r.isError)?.error,
  };
}
