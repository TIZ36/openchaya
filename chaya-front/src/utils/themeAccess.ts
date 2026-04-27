export type TenantPlan = 'free' | 'pro' | 'ultra';

export interface TenantInfo {
  id?: string;
  name?: string;
  plan?: string;
}

export interface PlanLimits {
  agents: number;    // -1 = unlimited
  dark_mode: boolean;
}

export interface PlanUsage {
  agents: number;
}

export interface CurrentUser {
  id?: string;
  name?: string;
  email?: string;
  tenant_id?: string;
  tenant?: TenantInfo;
  primary_agent_id?: string;
  is_founder?: boolean;
  limits?: PlanLimits;
  usage?: PlanUsage;
}

export function normalizeTenantPlan(plan?: string | null): TenantPlan {
  if (plan === 'pro') return 'pro';
  if (plan === 'ultra' || plan === 'enterprise') return 'ultra';
  return 'free';
}

export function getTenantPlan(user?: CurrentUser | null): TenantPlan {
  return normalizeTenantPlan(user?.tenant?.plan);
}

export function buildStoredUser<T extends CurrentUser>(user: T, tenant?: TenantInfo | null): T {
  const nextTenant = tenant ?? user.tenant ?? { id: user.tenant_id, plan: 'free' };
  return {
    ...user,
    tenant_id: user.tenant_id ?? nextTenant?.id,
    tenant: {
      ...nextTenant,
      plan: normalizeTenantPlan(nextTenant?.plan),
    },
  };
}
