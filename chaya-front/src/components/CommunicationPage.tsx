/**
 * 通信 — 与 MCP / Skill 同级：左「通信渠道」、右具体渠道配置（当前仅 Discord）
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Radio } from 'lucide-react';
import DiscordPanel, { DiscordIcon } from './DiscordPanel';
import { getDiscordStatus, type DiscordStatus } from '../services/discordApi';

type ChannelId = 'discord';

const CHANNELS: { id: ChannelId; label: string }[] = [{ id: 'discord', label: 'Discord' }];

interface CommunicationPageProps {
  sessionId?: string | null;
}

const CommunicationPage: React.FC<CommunicationPageProps> = ({ sessionId }) => {
  const [activeChannel, setActiveChannel] = useState<ChannelId>('discord');
  const [discordStatus, setDiscordStatus] = useState<DiscordStatus | null>(null);

  const refreshDiscordStatus = useCallback(async () => {
    try {
      const s = await getDiscordStatus(sessionId || undefined);
      setDiscordStatus(s);
    } catch {
      setDiscordStatus(null);
    }
  }, [sessionId]);

  useEffect(() => {
    refreshDiscordStatus();
    const t = setInterval(refreshDiscordStatus, 12_000);
    return () => clearInterval(t);
  }, [refreshDiscordStatus]);

  return (
    <div className="communication-page h-full min-h-0 flex flex-col bg-[var(--surface-primary)]">
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col app-pane-pad">
        <div className="max-w-6xl mx-auto w-full flex-1 min-h-0 flex flex-col gap-3">
          <div className="app-card-item app-card-pad-sm flex items-start gap-3 flex-shrink-0">
            <Radio className="w-5 h-5 text-[var(--color-accent)] flex-shrink-0 mt-0.5" aria-hidden />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">通信</h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                管理外部即时通信渠道：Bot 连接、频道绑定与频道人设
              </p>
            </div>
          </div>

          <div className="persona-two-pane flex-1 min-h-0">
            <aside className="persona-two-pane-nav">
              <div className="persona-two-pane-nav-title">通信渠道</div>
              <div className="persona-two-pane-nav-list">
                {CHANNELS.map((ch) => (
                  <button
                    key={ch.id}
                    type="button"
                    className={`persona-two-pane-nav-item flex items-center gap-2 w-full ${activeChannel === ch.id ? 'is-active' : ''}`}
                    onClick={() => setActiveChannel(ch.id)}
                  >
                    {ch.id === 'discord' ? (
                      <DiscordIcon className="h-4 w-4 flex-shrink-0 text-[#5865F2]" />
                    ) : null}
                    <span className="flex-1 text-left">{ch.label}</span>
                    {ch.id === 'discord' && discordStatus?.running ? (
                      <span className="text-[10px] text-[var(--color-accent)] font-medium tabular-nums">
                        在线
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </aside>
            <div className="persona-two-pane-content min-h-0 flex flex-col overflow-hidden">
              {activeChannel === 'discord' ? (
                <div className="communication-page-channel-pane flex-1 min-h-0 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)]">
                  <DiscordPanel embedded linkedAgentId={sessionId || undefined} />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CommunicationPage;
