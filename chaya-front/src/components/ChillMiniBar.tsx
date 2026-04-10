import React from 'react';
import { Headphones, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useChillPlayer } from '../contexts/ChillPlayerContext';

export type ChillMiniBarProps = {
  /** 在 Chill 全屏页内不显示，避免与页内控制条重复 */
  suppress?: boolean;
  onOpenChill: () => void;
};

export const ChillMiniBar: React.FC<ChillMiniBarProps> = ({ suppress, onOpenChill }) => {
  const {
    videoId,
    currentTitle,
    isLive,
    playing,
    volume,
    muted,
    togglePlay,
    setVolume,
    setMuted,
  } = useChillPlayer();

  if (suppress || !videoId) return null;

  return (
    <div
      className={`chill-mini-bar app-no-drag ${playing ? 'chill-mini-bar--playing' : ''}`}
      role="region"
      aria-label="Chill 播放条"
    >
      <div className="chill-mini-bar-ambient" aria-hidden />
      <div className="chill-mini-bar-glow" aria-hidden />
      <div className="chill-mini-bar-inner">
        <button
          type="button"
          className="chill-mini-bar-chill-btn"
          onClick={onOpenChill}
          title="打开 Chill"
        >
          <Headphones className="w-4 h-4 text-[var(--color-accent)]" strokeWidth={2} />
        </button>
        <div className="chill-mini-bar-title-wrap min-w-0 flex-1">
          <span className="chill-mini-bar-title">{currentTitle || 'Chill'}</span>
          {isLive && <span className="chill-pill chill-pill--live chill-pill--sm">LIVE</span>}
        </div>
        <div className="chill-mini-bar-controls">
          <button
            type="button"
            className="chill-mini-bar-icon"
            onClick={togglePlay}
            aria-label={playing ? '暂停' : '播放'}
          >
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            type="button"
            className="chill-mini-bar-icon"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? '取消静音' : '静音'}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="chill-volume chill-mini-volume"
            aria-label="音量"
          />
        </div>
      </div>
    </div>
  );
};
