import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronUp, Heart, Pause, Play, Radio, Volume2, VolumeX } from 'lucide-react';

export type ChillRecentSource = { videoId: string; title: string; isLive?: boolean };

export type ChillHeaderBarProps = {
  expanded: boolean;
  onToggleExpand: () => void;
  currentTitle: string;
  /** 有 videoId 时才允许播放/暂停 */
  hasVideo: boolean;
  isLive: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  volume: number;
  onVolumeChange: (v: number) => void;
  muted: boolean;
  onToggleMute: () => void;
  recentSources: ChillRecentSource[];
  onPickRecent: (s: ChillRecentSource) => void;
  favoriteActive?: boolean;
  onToggleFavorite?: () => void;
  /** 全屏页顶栏：隐藏展开箭头（由页面承载内容） */
  hideExpand?: boolean;
  /** 全屏页：收藏已在上方快捷区展示时可隐藏顶栏爱心 */
  hideFavoriteButton?: boolean;
};

export const ChillHeaderBar: React.FC<ChillHeaderBarProps> = ({
  expanded,
  onToggleExpand,
  currentTitle,
  hasVideo,
  isLive,
  playing,
  onTogglePlay,
  volume,
  onVolumeChange,
  muted,
  onToggleMute,
  recentSources,
  onPickRecent,
  favoriteActive,
  onToggleFavorite,
  hideExpand,
  hideFavoriteButton,
}) => {
  const [recentOpen, setRecentOpen] = useState(false);
  const recentWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!recentOpen) return;
    const close = (e: MouseEvent) => {
      if (!recentWrapRef.current?.contains(e.target as Node)) setRecentOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [recentOpen]);

  return (
    <div className="chill-header-bar niho-card-2 niho-line-top app-no-drag" role="region" aria-label="Chill 氛围音频">
      <div className="chill-header-bar-ambient" aria-hidden />
      <div className="chill-header-bar-inner">
        <div className="chill-header-bar-left">
          <span className="chill-header-bar-brand">
            <Radio className="chill-header-bar-brand-icon" strokeWidth={2} aria-hidden />
            <span className="chill-header-bar-brand-text">Chill</span>
          </span>
          <div className="chill-header-bar-title-wrap" ref={recentWrapRef}>
            <button
              type="button"
              className="chill-header-bar-title-btn"
              onClick={() => {
                if (recentSources.length > 0) setRecentOpen((o) => !o);
                else onToggleExpand();
              }}
              title={recentSources.length ? '最近播放' : '展开面板'}
            >
              <span className="chill-header-bar-title-text">{currentTitle || '选择音源'}</span>
              {isLive && <span className="chill-pill chill-pill--live">LIVE</span>}
            </button>
            {recentOpen && recentSources.length > 0 && (
              <div className="chill-recent-popover niho-card-3 no-scrollbar">
                {recentSources.map((s) => (
                  <button
                    key={s.videoId}
                    type="button"
                    className="chill-recent-item"
                    onClick={() => {
                      onPickRecent(s);
                      setRecentOpen(false);
                    }}
                  >
                    <span className="chill-recent-item-title">{s.title || s.videoId}</span>
                    {s.isLive && <span className="chill-pill chill-pill--live chill-pill--sm">LIVE</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="chill-header-bar-controls">
          {onToggleFavorite && !hideFavoriteButton && (
            <button
              type="button"
              className={`chill-icon-btn ${favoriteActive ? 'chill-icon-btn--active' : ''}`}
              onClick={onToggleFavorite}
              disabled={!hasVideo}
              aria-label={favoriteActive ? '取消收藏' : '收藏当前'}
              title={favoriteActive ? '取消收藏' : '收藏当前'}
            >
              <Heart className={`w-4 h-4 ${favoriteActive ? 'fill-current' : ''}`} />
            </button>
          )}
          <button
            type="button"
            className="chill-icon-btn"
            onClick={onTogglePlay}
            disabled={!hasVideo}
            aria-label={playing ? '暂停' : '播放'}
            title={playing ? '暂停' : '播放'}
          >
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            type="button"
            className="chill-icon-btn"
            onClick={onToggleMute}
            aria-label={muted ? '取消静音' : '静音'}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            className="chill-volume"
            aria-label="音量"
          />
          {!hideExpand && (
            <button
              type="button"
              className="chill-expand-btn"
              onClick={onToggleExpand}
              aria-expanded={expanded}
              aria-label={expanded ? '收起面板' : '展开面板'}
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
