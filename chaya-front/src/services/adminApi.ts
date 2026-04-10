import { api } from '../utils/apiClient';
import { buildStoredUser, type CurrentUser, type TenantInfo, type TenantPlan } from '../utils/themeAccess';

export interface MeResponse {
  user: CurrentUser;
  tenant: TenantInfo;
  is_founder: boolean;
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
  return {
    ...res,
    user: buildStoredUser(res.user, res.tenant),
  };
}

export async function listMemberships(): Promise<MembershipItem[]> {
  const res = await api.get<{ items: MembershipItem[] }>('/api/admin/memberships');
  return res.items || [];
}

export async function updateMembership(tenantId: string, plan: TenantPlan): Promise<TenantInfo> {
  const res = await api.put<{ tenant: TenantInfo }>(`/api/admin/memberships/${tenantId}`, { plan });
  return res.tenant;
}
