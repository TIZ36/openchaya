import { api } from '../utils/apiClient';
import { buildStoredUser, type CurrentUser, type TenantInfo, type TenantPlan, type PlanLimits, type PlanUsage } from '../utils/themeAccess';

interface MeResponse {
  user: CurrentUser;
  tenant: TenantInfo;
  is_founder: boolean;
  limits?: PlanLimits;
  usage?: PlanUsage;
}

export interface MembershipItem {
  tenant_id: string;
  tenant_name: string;
  plan: TenantPlan;
  user_id: string;
  user_name: string;
  user_email: string;
  is_founder: boolean;
}

export async function getMe(): Promise<MeResponse> {
  const res = await api.get<MeResponse>('/api/me');
  // Pin limits/usage onto the user object so any component holding a
  // CurrentUser ref sees them without re-fetching.
  const user = buildStoredUser({ ...res.user, limits: res.limits, usage: res.usage }, res.tenant);
  return { ...res, user };
}

export async function listMemberships(): Promise<MembershipItem[]> {
  const res = await api.get<{ items: MembershipItem[] }>('/api/admin/memberships');
  return res.items || [];
}

export async function updateMembership(tenantId: string, plan: TenantPlan): Promise<TenantInfo> {
  const res = await api.put<{ tenant: TenantInfo }>(`/api/admin/memberships/${tenantId}`, { plan });
  return res.tenant;
}
