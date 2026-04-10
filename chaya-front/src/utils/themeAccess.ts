export type TenantPlan = 'free' | 'pro' | 'ultra';
export type SkinId = 'quiet' | 'niho' | 'ultra';
export type ThemeMode = 'light' | 'dark';

export interface TenantInfo {
  id?: string;
  name?: string;
  plan?: string;
}

export interface CurrentUser {
  id?: string;
  name?: string;
  email?: string;
  tenant_id?: string;
  tenant?: TenantInfo;
  primary_agent_id?: string;
  is_founder?: boolean;
}

const PLAN_TO_SKINS: Record<TenantPlan, SkinId[]> = {
  free: ['quiet'],
  pro: ['quiet', 'niho'],
  ultra: ['quiet', 'niho', 'ultra'],
};

export function normalizeTenantPlan(plan?: string | null): TenantPlan {
  if (plan === 'pro') return 'pro';
  if (plan === 'ultra' || plan === 'enterprise') return 'ultra';
  return 'free';
}

export function getTenantPlan(user?: CurrentUser | null): TenantPlan {
  return normalizeTenantPlan(user?.tenant?.plan);
}

export function getAllowedSkins(plan: TenantPlan): SkinId[] {
  return PLAN_TO_SKINS[plan];
}

export function isSkinAllowed(plan: TenantPlan, skin: SkinId): boolean {
  return PLAN_TO_SKINS[plan].includes(skin);
}

export function normalizeSkinForPlan(plan: TenantPlan, skin?: string | null): SkinId {
  if (skin === 'ultra' && isSkinAllowed(plan, 'ultra')) return 'ultra';
  if (skin === 'niho' && isSkinAllowed(plan, 'niho')) return 'niho';
  return 'quiet';
}

export function getThemeFamilyForPlan(plan: TenantPlan): SkinId {
  if (plan === 'ultra') return 'ultra';
  if (plan === 'pro') return 'niho';
  return 'quiet';
}

export function normalizeThemeMode(mode?: string | null): ThemeMode {
  return mode === 'dark' ? 'dark' : 'light';
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
