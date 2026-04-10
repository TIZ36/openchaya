/**
 * Chill 全屏页：侧栏第三入口，氛围背景 + 顶栏快速切换 / 收藏 + 直播与搜索。
 * 播放状态由 ChillPlayerContext 全局持有，离开本页音乐不中断。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Headphones, Heart } from 'lucide-react';
import { fetchChillLive, searchChill, fetchChannelLive, type ChillSearchItem, type ChillVideoItem } from '../services/chillApi';
import { useChillPlayer } from '../contexts/ChillPlayerContext';
import { toast } from './ui/use-toast';
import { ChillHeaderBar } from './ChillHeaderBar';
import { ChillPanel, type ChillPanelTab } from './ChillPanel';

export type ChillPageProps = {
  isMobile: boolean;
  tab: ChillPanelTab;
  onTabChange: (t: ChillPanelTab) => void;
};

export const ChillPage: React.FC<ChillPageProps> = ({ isMobile, tab: panelTab, onTabChange }) => {
  const {
    videoId,
    currentTitle,
    isLive,
    playing,
    volume,
    muted,
    recentSources,
    favorites,
    setTrack,
    setVolume,
    setMuted,
    togglePlay,
    pushRecent,
    pickRecent,
    toggleFavorite,
    removeFavorite,
  } = useChillPlayer();

  const [liveItems, setLiveItems] = useState<ChillVideoItem[]>([]);
  const [loadingLive, setLoadingLive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchItems, setSearchItems] = useState<ChillSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveFetchedRef = useRef(false);

  const loadLive = useCallback(async () => {
    setLoadingLive(true);
    setApiError(null);
    const res = await fetchChillLive();
    setLoadingLive(false);
    if (!res.ok) {
      setApiError(res.error || 'YouTube API 不可用（请配置 backend/config.yaml 的 youtube.api_key）');
      setLiveItems([]);
      return;
    }
    setLiveItems(res.items);
  }, []);

  useEffect(() => {
    if (panelTab !== 'live') return;
    if (liveFetchedRef.current) return;
    liveFetchedRef.current = true;
    loadLive();
  }, [panelTab, loadLive]);

  const onSelectVideo = useCallback(
    (item: ChillVideoItem) => {
      if (!item.videoId) return;
      setTrack({
        videoId: item.videoId,
        title: item.title || item.videoId,
        isLive: !!item.isLive || item.liveBroadcastContent === 'live',
      });
      pushRecent(
        item.videoId,
        item.title || item.videoId,
        !!item.isLive || item.liveBroadcastContent === 'live',
      );
    },
    [setTrack, pushRecent],
  );

  const onSelectChannel = useCallback(
    async (channelId: string, title: string) => {
      const res = await fetchChannelLive(channelId);
      if (!res.ok) {
        toast({ title: '频道直播查询失败', description: res.error || '', variant: 'destructive' });
        return;
      }
      if (!res.videoId) {
        toast({ title: '该频道当前无直播', description: '可换关键词搜索其他频道', variant: 'destructive' });
        return;
      }
      setTrack({ videoId: res.videoId, title: res.title || title, isLive: true });
      pushRecent(res.videoId, res.title || title, true);
    },
    [setTrack, pushRecent],
  );

  const runSearch = useCallback(async (q: string) => {
    const t = q.trim();
    if (t.length < 2) {
      setSearchItems([]);
      return;
    }
    setSearching(true);
    setApiError(null);
    const res = await searchChill(t);
    setSearching(false);
    if (!res.ok) {
      setApiError(res.error || '搜索失败');
      setSearchItems([]);
      return;
    }
    setSearchItems(res.items);
  }, []);

  useEffect(() => {
    if (panelTab !== 'search') return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchItems([]);
      return;
    }
    searchTimer.current = setTimeout(() => {
      runSearch(q);
    }, 450);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery, panelTab, runSearch]);

  const favoriteActive = !!(videoId && favorites.some((f) => f.videoId === videoId));

  return (
    <div
      className={`chill-page h-full min-h-0 flex flex-col overflow-hidden app-no-drag ${playing && videoId ? 'chill-page--playing' : ''}`}
    >
      <div className="chill-page-bg" aria-hidden />
      <div className="chill-page-grid" aria-hidden />
      {playing && videoId && <div className="chill-page-aura" aria-hidden />}
      <div className="chill-page-content flex flex-col flex-1 min-h-0 relative z-[1]">
        <header className="chill-page-top flex-shrink-0 px-3 sm:px-4 pt-3 pb-2 space-y-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="chill-page-title-icon">
              <Headphones className="w-5 h-5 text-[var(--color-accent)]" strokeWidth={2} aria-hidden />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold tracking-wide text-[var(--text-primary)]">Chill</h1>
              <p className="text-[10px] text-[var(--text-muted)] mt-0.5">氛围音频 · 快速切换与收藏</p>
            </div>
          </div>

          <div className="chill-page-quick niho-card-2 rounded-xl px-3 py-2.5 border border-[var(--niho-text-border)]">
            <div className="chill-page-quick-grid">
              <section className="chill-page-quick-section chill-page-quick-section--recent">
                <div className="chill-page-quick-label">最近</div>
                <div className="chill-page-chips flex flex-wrap gap-1.5 min-w-0">
                  {recentSources.length === 0 && (
                    <span className="text-[10px] text-[var(--text-muted)] opacity-80">播放后在此快速切回</span>
                  )}
                  {recentSources.map((s) => (
                    <button
                      key={s.videoId}
                      type="button"
                      className={`chill-chip ${videoId === s.videoId ? 'chill-chip--active' : ''}`}
                      onClick={() => pickRecent(s)}
                      title={s.title}
                    >
                      <span className="truncate max-w-[120px] sm:max-w-[160px]">{s.title || s.videoId}</span>
                      {s.isLive && <span className="chill-pill chill-pill--live chill-pill--sm">LIVE</span>}
                    </button>
                  ))}
                </div>
              </section>

              <section className="chill-page-quick-section chill-page-quick-section--favorites">
                <div className="chill-page-quick-label">喜爱</div>
                <div className="chill-page-chips flex flex-wrap gap-1.5 min-w-0">
                  {favorites.length === 0 && (
                    <span className="text-[10px] text-[var(--text-muted)] opacity-80">在播放条点爱心收藏当前音源</span>
                  )}
                  {favorites.map((f) => (
                    <button
                      key={f.videoId}
                      type="button"
                      className={`chill-chip chill-chip--pink ${videoId === f.videoId ? 'chill-chip--active' : ''}`}
                      onClick={() => pickRecent(f)}
                      title={f.title}
                    >
                      <Heart className="w-3 h-3 shrink-0 opacity-90" />
                      <span className="truncate max-w-[104px] sm:max-w-[132px]">{f.title || f.videoId}</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </div>

          <ChillHeaderBar
            expanded
            onToggleExpand={() => {}}
            hideExpand
            currentTitle={currentTitle}
            hasVideo={!!videoId}
            isLive={isLive}
            playing={playing}
            onTogglePlay={() => {
              if (!videoId) return;
              togglePlay();
            }}
            volume={volume}
            onVolumeChange={setVolume}
            muted={muted}
            onToggleMute={() => setMuted((m) => !m)}
            recentSources={recentSources}
            onPickRecent={pickRecent}
            favoriteActive={favoriteActive}
            onToggleFavorite={toggleFavorite}
          />
        </header>

        <div className="chill-page-panel-wrap flex-1 min-h-0 px-3 sm:px-4 pb-3">
          <ChillPanel
            variant="embed"
            tab={panelTab}
            onTabChange={onTabChange}
            liveItems={liveItems}
            loadingLive={loadingLive}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSearchSubmit={() => runSearch(searchQuery)}
            searchItems={searchItems}
            searching={searching}
            onSelectVideo={onSelectVideo}
            onSelectChannel={onSelectChannel}
            apiError={apiError}
            isMobile={isMobile}
            nowPlayingTitle={currentTitle}
            nowPlayingLive={isLive}
            favorites={favorites}
            onSelectFavorite={pickRecent}
            onRemoveFavorite={removeFavorite}
          />
        </div>
      </div>
    </div>
  );
};
