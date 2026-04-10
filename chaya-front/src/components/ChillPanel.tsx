import React, { useCallback, useMemo } from 'react';
import { Loader2, Search } from 'lucide-react';
import type { ChillSearchItem, ChillVideoItem } from '../services/chillApi';
import type { ChillRecentSource } from './ChillHeaderBar';
import { Input } from './ui/Input';
import { ScrollArea } from './ui/ScrollArea';

export type ChillPanelTab = 'live' | 'search';

export type ChillPanelProps = {
  /** overlay：旧版顶栏下拉；embed：全屏 Chill 页内嵌 */
  variant?: 'overlay' | 'embed';
  tab: ChillPanelTab;
  onTabChange: (t: ChillPanelTab) => void;
  liveItems: ChillVideoItem[];
  loadingLive: boolean;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onSearchSubmit: () => void;
  searchItems: ChillSearchItem[];
  searching: boolean;
  onSelectVideo: (item: ChillVideoItem) => void;
  onSelectChannel: (channelId: string, title: string) => void;
  apiError: string | null;
  isMobile: boolean;
  nowPlayingTitle: string;
  nowPlayingLive: boolean;
  favorites: ChillRecentSource[];
  onSelectFavorite: (s: ChillRecentSource) => void;
  onRemoveFavorite: (videoId: string) => void;
};

export const ChillPanel: React.FC<ChillPanelProps> = ({
  variant = 'overlay',
  tab,
  onTabChange,
  liveItems,
  loadingLive,
  searchQuery,
  onSearchQueryChange,
  onSearchSubmit,
  searchItems,
  searching,
  onSelectVideo,
  onSelectChannel,
  apiError,
  isMobile,
  nowPlayingTitle,
  nowPlayingLive,
  favorites,
  onSelectFavorite,
  onRemoveFavorite,
}) => {
  const tabs = useMemo(
    () => [
      { id: 'live' as const, label: '直播' },
      { id: 'search' as const, label: '搜索' },
    ],
    [],
  );

  const debouncedSearch = useCallback(() => {
    onSearchSubmit();
  }, [onSearchSubmit]);

  const embed = variant === 'embed';
  return (
    <div
      className={`chill-panel niho-card-3 niho-line-top app-no-drag ${isMobile ? 'chill-panel--mobile' : ''} ${embed ? 'chill-panel--embed' : ''}`}
    >
      <div className="chill-panel-ambient" aria-hidden />
      {apiError && (
        <div className="chill-panel-error niho-block-pink text-xs px-3 py-2 mx-3 mt-2 rounded-md">{apiError}</div>
      )}
      {!embed && (
        <div className="chill-panel-tabs app-view-switch px-3 pt-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`app-view-switch-btn ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className={`chill-panel-body ${!isMobile ? 'chill-panel-body--grid' : ''}`}>
        <div className="chill-panel-main">
        {tab === 'live' && (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="chill-panel-list-scroll chill-panel-list-scroll--fill pr-1">
              <div className="p-3 space-y-2 app-list-layout">
              {loadingLive && (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--niho-skyblue-gray)' }}>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  加载直播中…
                </div>
              )}
              {!loadingLive && liveItems.length === 0 && (
                <p className="text-xs px-1" style={{ color: 'var(--niho-skyblue-gray)' }}>
                  暂无直播结果。可在后端 config.yaml 配置 youtube.default_live_channel_ids，或依赖默认关键词搜索。
                </p>
              )}
              {liveItems.map((v) => (
                <button
                  key={v.videoId}
                  type="button"
                  className="app-list-item chill-source-row w-full text-left"
                  onClick={() => onSelectVideo({ ...v, isLive: true })}
                >
                  {v.thumbnailUrl ? (
                    <img src={v.thumbnailUrl} alt="" className="chill-thumb" />
                  ) : (
                    <div className="chill-thumb chill-thumb--placeholder" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {v.title}
                    </div>
                    <div className="text-[10px] truncate" style={{ color: 'var(--niho-skyblue-gray)' }}>
                      {v.channelTitle || 'YouTube'}
                    </div>
                  </div>
                  <span className="chill-pill chill-pill--live flex-shrink-0">LIVE</span>
                </button>
              ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'search' && (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="flex flex-shrink-0 gap-2 px-3 pt-1 pb-2">
              <Input
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') debouncedSearch();
                }}
                placeholder="视频或频道关键词…"
                className="h-9 flex-1 text-xs"
              />
              <button
                type="button"
                className="chill-search-submit niho-card-2 rounded-lg px-3 flex items-center justify-center border border-[var(--niho-text-border)]"
                onClick={debouncedSearch}
                aria-label="搜索"
              >
                <Search className="w-4 h-4" style={{ color: 'var(--color-accent)' }} />
              </button>
            </div>
            <div
              className="chill-panel-list-scroll chill-panel-list-scroll--fill pr-1"
            >
              <div className="px-3 pb-3 space-y-2 app-list-layout">
                {searching && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--niho-skyblue-gray)' }}>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    搜索中…
                  </div>
                )}
                {!searching &&
                  searchItems.map((item, idx) =>
                    item.kind === 'video' ? (
                      <button
                        key={`${item.videoId}-${idx}`}
                        type="button"
                        className="app-list-item chill-source-row w-full text-left"
                        onClick={() => onSelectVideo(item)}
                      >
                        {item.thumbnailUrl ? (
                          <img src={item.thumbnailUrl} alt="" className="chill-thumb" />
                        ) : (
                          <div className="chill-thumb chill-thumb--placeholder" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium truncate">{item.title}</div>
                          <div className="text-[10px] truncate" style={{ color: 'var(--niho-skyblue-gray)' }}>
                            {item.channelTitle || '视频'}
                          </div>
                        </div>
                        {item.liveBroadcastContent === 'live' && (
                          <span className="chill-pill chill-pill--live flex-shrink-0">LIVE</span>
                        )}
                      </button>
                    ) : (
                      <button
                        key={`${item.channelId}-${idx}`}
                        type="button"
                        className="app-list-item chill-source-row w-full text-left"
                        onClick={() => onSelectChannel(item.channelId, item.title)}
                      >
                        {item.thumbnailUrl ? (
                          <img src={item.thumbnailUrl} alt="" className="chill-thumb rounded-full" />
                        ) : (
                          <div className="chill-thumb chill-thumb--placeholder rounded-full" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium truncate">{item.title}</div>
                          <div className="text-[10px] truncate" style={{ color: 'var(--niho-skyblue-gray)' }}>
                            频道 · 点击播放当前直播
                          </div>
                        </div>
                      </button>
                    ),
                  )}
              </div>
            </div>
          </div>
        )}
        </div>

        {!isMobile && (
          <aside className="chill-panel-side niho-card-1 rounded-lg m-3 ml-0 p-3 flex flex-col gap-3 min-h-0">
            <div>
              <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--niho-skyblue-gray)' }}>
                正在播放
              </div>
              <div className="text-xs font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>
                {nowPlayingTitle || '—'}
              </div>
              {nowPlayingLive && (
                <span className="chill-pill chill-pill--live inline-block mt-1">LIVE</span>
              )}
            </div>
            <div className="min-h-0 flex-1 flex flex-col gap-1">
              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--niho-skyblue-gray)' }}>
                收藏
              </div>
              <ScrollArea className="flex-1 min-h-[120px] max-h-[200px]">
                <div className="space-y-1 pr-1">
                  {favorites.length === 0 && (
                    <p className="text-[10px]" style={{ color: 'var(--niho-skyblue-gray)' }}>
                      在顶栏点爱心收藏当前音源
                    </p>
                  )}
                  {favorites.map((f) => (
                    <div key={f.videoId} className="flex items-center gap-1 group">
                      <button
                        type="button"
                        className="flex-1 truncate rounded-md border border-transparent px-2 py-1 text-left text-xs hover:border-[var(--color-accent)]/35 hover:bg-[var(--surface-elevated)]"
                        style={{ color: 'var(--text-primary)' }}
                        onClick={() => onSelectFavorite(f)}
                        title={f.title}
                      >
                        {f.title}
                      </button>
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 text-[10px] px-1 rounded"
                        style={{ color: 'var(--color-secondary)' }}
                        onClick={() => onRemoveFavorite(f.videoId)}
                        aria-label="移除收藏"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};
