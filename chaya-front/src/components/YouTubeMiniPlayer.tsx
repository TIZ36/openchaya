/**
 * 隐藏容器内的 YouTube IFrame API 播放器，供 Chill 条控制播放。
 */
import React, { useEffect, useRef, useCallback } from 'react';

type YTPlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  loadVideoById: (id: { videoId: string; startSeconds?: number } | string) => void;
  setVolume: (v: number) => void;
  mute: () => void;
  unMute: () => void;
  destroy: () => void;
};

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement | string, opts: Record<string, unknown>) => YTPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const readyQueue: Array<() => void> = [];
let apiInjected = false;

function ensureYouTubeApi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    if (window.YT?.Player) {
      resolve();
      return;
    }
    readyQueue.push(resolve);
    if (apiInjected) return;
    apiInjected = true;
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try {
        prev?.();
      } catch {
        /* */
      }
      while (readyQueue.length) {
        const fn = readyQueue.shift();
        try {
          fn?.();
        } catch {
          /* */
        }
      }
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    document.body.appendChild(s);
  });
}

export type YouTubeMiniPlayerProps = {
  videoId: string | null;
  playing: boolean;
  volume: number;
  muted: boolean;
  className?: string;
};

export const YouTubeMiniPlayer: React.FC<YouTubeMiniPlayerProps> = ({
  videoId,
  playing,
  volume,
  muted,
  className = '',
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const lastVideoRef = useRef<string | null>(null);
  const videoIdRef = useRef(videoId);
  const playingRef = useRef(playing);
  videoIdRef.current = videoId;
  playingRef.current = playing;

  const applyVolume = useCallback(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    try {
      p.setVolume(Math.max(0, Math.min(100, volume)));
      if (muted) p.mute();
      else p.unMute();
    } catch {
      /* */
    }
  }, [volume, muted]);

  useEffect(() => {
    let cancelled = false;

    ensureYouTubeApi().then(() => {
      if (cancelled || !hostRef.current) return;
      try {
        playerRef.current = new window.YT!.Player(hostRef.current, {
          height: '120',
          width: '200',
          playerVars: {
            autoplay: 0,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
          },
          events: {
            onReady: () => {
              if (cancelled) return;
              readyRef.current = true;
              applyVolume();
              const id = videoIdRef.current;
              if (id) {
                lastVideoRef.current = id;
                try {
                  playerRef.current?.loadVideoById(id);
                  if (playingRef.current) playerRef.current?.playVideo();
                  else playerRef.current?.pauseVideo();
                } catch {
                  /* */
                }
              }
            },
          },
        });
      } catch {
        /* */
      }
    });

    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {
        /* */
      }
      playerRef.current = null;
      readyRef.current = false;
      lastVideoRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- single init
  }, []);

  useEffect(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    if (!videoId) {
      try {
        p.pauseVideo();
      } catch {
        /* */
      }
      return;
    }
    if (videoId !== lastVideoRef.current) {
      lastVideoRef.current = videoId;
      try {
        p.loadVideoById(videoId);
      } catch {
        /* */
      }
    }
    try {
      if (playing) p.playVideo();
      else p.pauseVideo();
    } catch {
      /* */
    }
  }, [videoId, playing]);

  useEffect(() => {
    applyVolume();
  }, [applyVolume]);

  return (
    <div
      className={`chill-yt-host pointer-events-none fixed w-[1px] h-[1px] overflow-hidden opacity-0 ${className}`}
      style={{ left: -9999, top: -9999 }}
      aria-hidden
    >
      <div ref={hostRef} className="chill-yt-inner" />
    </div>
  );
};
