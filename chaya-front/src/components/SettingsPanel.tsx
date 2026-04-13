import React, { useState, useCallback, useEffect } from 'react';
import { Settings, Key, MessageSquare, RefreshCw, Users } from 'lucide-react';
import { GlobalSettings as SettingsType } from '../services/core/shared/types';
import PageLayout, { Card } from './ui/PageLayout';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { toast } from './ui/use-toast';
import { getBackendUrl } from '../utils/backendUrl';
import { api } from '../utils/apiClient';
import ActorPoolDialog from './ActorPoolDialog';
import { getMe, listMemberships, updateMembership, type MembershipItem } from '../services/adminApi';
import type { TenantPlan } from '../utils/themeAccess';

interface SettingsPanelProps {
  settings: SettingsType;
  onUpdateSettings: (settings: Partial<SettingsType>) => void;
  section: 'general' | 'agent-status' | 'membership';
}

interface LLMKeyStatus {
  total: number;
  enabled: number;
  withKey: number;
  withoutKey: number;
}

interface TopicStatus {
  total: number;
  active: number;
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({ section }) => {
  const [backendUrl, setBackendUrl] = useState<string>(getBackendUrl());
  const [isFounder, setIsFounder] = useState(false);
  const [memberships, setMemberships] = useState<MembershipItem[]>([]);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipSavingTenantId, setMembershipSavingTenantId] = useState<string | null>(null);
  const [llmKeyStatus, setLlmKeyStatus] = useState<LLMKeyStatus>({
    total: 0,
    enabled: 0,
    withKey: 0,
    withoutKey: 0,
  });
  const [topicStatus, setTopicStatus] = useState<TopicStatus>({ total: 0, active: 0 });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actorPoolOpen, setActorPoolOpen] = useState(false);

  const checkStatus = useCallback(async () => {
    setIsRefreshing(true);
    try {
      try {
        const configs = await api.get<any[]>('/api/llm/configs');
        const enabled = configs.filter((c: any) => c.enabled);
        const withKey = enabled.filter((c: any) => {
          if (c.provider === 'ollama') return true;
          if (c.has_api_key !== undefined) return c.has_api_key === true;
          return !!c.api_key;
        });
        const withoutKey = enabled.filter((c: any) => {
          if (c.provider === 'ollama') return false;
          if (c.has_api_key !== undefined) return c.has_api_key === false;
          return !c.api_key;
        });
        setLlmKeyStatus({ total: configs.length, enabled: enabled.length, withKey: withKey.length, withoutKey: withoutKey.length });
      } catch (e) {
        console.error('[Settings] Failed to fetch LLM configs:', e);
      }
      try {
        const topics = await api.get<any[]>('/api/sessions');
        const activeTopics = topics.filter((t: any) => {
          if (!t.last_message_at) return false;
          return Date.now() - new Date(t.last_message_at).getTime() < 24 * 60 * 60 * 1000;
        });
        setTopicStatus({ total: topics.length, active: activeTopics.length });
      } catch (e) {
        console.error('[Settings] Failed to fetch topics:', e);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    let alive = true;
    const loadFounderState = async () => {
      try {
        const me = await getMe();
        if (!alive) return;
        setIsFounder(me.is_founder === true);
        if (me.is_founder) {
          setMembershipLoading(true);
          const items = await listMemberships();
          if (!alive) return;
          setMemberships(items);
        }
      } catch {
        if (!alive) return;
        setIsFounder(false);
      } finally {
        if (alive) setMembershipLoading(false);
      }
    };
    void loadFounderState();
    return () => { alive = false; };
  }, []);

  const handleSaveBackendUrl = () => {
    localStorage.setItem('chatee_backend_url', backendUrl);
    (window as any).__cachedBackendUrl = backendUrl;
    toast({
      title: '保存成功',
      description: '后端地址已更新，刷新页面后生效',
    });
    setBackendUrl(getBackendUrl());
  };

  const handleMembershipChange = async (tenantId: string, plan: TenantPlan) => {
    setMembershipSavingTenantId(tenantId);
    try {
      const tenant = await updateMembership(tenantId, plan);
      setMemberships((prev) => prev.map((item) => (
        item.tenant_id === tenantId ? { ...item, plan: tenant.plan as TenantPlan } : item
      )));
      toast({ title: '会员等级已更新', description: `${tenant.name} 已切换为 ${tenant.plan}`, variant: 'success' });
    } catch (error) {
      toast({ title: '更新失败', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    } finally {
      setMembershipSavingTenantId(null);
    }
  };

  const renderGeneralSettings = () => (
    <Card title="后端服务器" variant="persona" size="relaxed" className="settings-panel-card app-card-item">
      <div className="app-section-gap">
        <div>
          <label className="settings-panel-label mb-1.5 block text-sm font-medium text-[var(--text-primary)]">
            后端服务器地址
          </label>
          <Input
            type="text"
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
            placeholder="http://localhost:3002"
            className="w-full"
          />
          <p className="settings-panel-desc mt-1 text-xs text-[var(--text-secondary)]">
            设置后端 API 服务器地址，留空则使用默认值或根据当前域名自动推断
          </p>
        </div>
        <Button
          variant="primary"
          onClick={handleSaveBackendUrl}
          className="settings-panel-btn-primary w-full"
        >
          保存后端地址
        </Button>
      </div>
    </Card>
  );

  const renderAgentStatus = () => (
    <Card title="Agent 状态" variant="persona" size="relaxed" className="settings-panel-card app-card-item">
      <div className="app-section-gap">
        <div className="flex flex-wrap items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            className="text-[var(--text-primary)]"
            onClick={() => setActorPoolOpen(true)}
            title="查看正在工作的 Actor"
          >
            <Users className="w-4 h-4 mr-2" />
            Actor 池
          </Button>
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-[var(--text-muted)]" />
            <span className="text-sm text-[var(--text-secondary)]">LLM</span>
            {llmKeyStatus.withoutKey > 0 ? (
              <span className="text-xs text-amber-500">
                {llmKeyStatus.withKey}/{llmKeyStatus.enabled} 有Key
              </span>
            ) : llmKeyStatus.enabled > 0 ? (
              <span className="text-xs text-emerald-500">{llmKeyStatus.enabled} 已配置</span>
            ) : (
              <span className="text-xs text-[var(--text-muted)]">未配置</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-[var(--text-muted)]" />
            <span className="text-sm text-[var(--text-secondary)]">Topic</span>
            <span className="text-xs text-[var(--text-muted)]">
              {topicStatus.total} 个 / {topicStatus.active} 活跃
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={checkStatus}
            disabled={isRefreshing}
            className="text-[var(--text-muted)]"
            title="刷新状态"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          当前后端：{backendUrl || '（默认）'}
        </p>
      </div>
    </Card>
  );

  const renderMembership = () => (
    <Card title="会员管理" variant="persona" size="relaxed" className="settings-panel-card app-card-item">
      {!isFounder ? (
        <div className="text-sm text-[var(--text-secondary)]">
          仅创始人可见。
        </div>
      ) : (
        <div className="app-section-gap">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-[var(--text-primary)]">创始人会员控制台</div>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                `tianz8701@gmail.com` 已自动识别为创始人账号。
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                setMembershipLoading(true);
                try {
                  setMemberships(await listMemberships());
                } finally {
                  setMembershipLoading(false);
                }
              }}
              disabled={membershipLoading}
            >
              刷新
            </Button>
          </div>

          <div className="space-y-3">
            {membershipLoading ? (
              <div className="text-xs text-[var(--text-muted)]">正在加载会员列表…</div>
            ) : memberships.map((item) => (
              <div key={item.user_id} className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                      {item.user_name || item.user_email}
                      {item.is_founder ? <span className="ml-2 text-[10px] text-[var(--color-highlight)]">Founder</span> : null}
                    </div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1 truncate">{item.user_email}</div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-1 truncate">{item.tenant_name}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(['free', 'pro', 'ultra'] as TenantPlan[]).map((plan) => (
                      <Button
                        key={plan}
                        variant={item.plan === plan ? 'primary' : 'secondary'}
                        size="sm"
                        disabled={membershipSavingTenantId === item.tenant_id}
                        onClick={() => void handleMembershipChange(item.tenant_id, plan)}
                      >
                        {plan}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );

  return (
    <PageLayout
      title="设置"
      description="管理应用配置和偏好设置"
      icon={Settings}
      variant="persona"
      showHeader={false}
    >
      <section className="settings-panel h-full min-h-0 settings-two-pane-content-scroll no-scrollbar">
        {section === 'general' && renderGeneralSettings()}
        {section === 'agent-status' && renderAgentStatus()}
        {section === 'membership' && renderMembership()}
      </section>

      <ActorPoolDialog open={actorPoolOpen} onOpenChange={setActorPoolOpen} />
    </PageLayout>
  );
};

export default SettingsPanel;
