import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChillRecentSource } from '../components/ChillHeaderBar';

const LS_STATE = 'chaya_chill_v1';
const LS_FAV = 'chaya_chill_favorites';

type PersistedState = {
  volume: number;
  muted: boolean;
  recentSources: ChillRecentSource[];
  lastVideoId: string | null;
  lastTitle: string;
  isLive: boolean;
  playing: boolean;
};

function readState(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<PersistedState>;
  } catch {
    return {};
  }
}

function writeState(p: PersistedState) {
  try {
    localStorage.setItem(LS_STATE, JSON.stringify(p));
  } catch {
    /* */
  }
}

function readFavorites(): ChillRecentSource[] {
  try {
    const raw = localStorage.getItem(LS_FAV);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ChillRecentSource[];
    return Array.isArray(arr) ? arr.slice(0, 30) : [];
  } catch {
    return [];
  }
}

function writeFavorites(f: ChillRecentSource[]) {
  try {
    localStorage.setItem(LS_FAV, JSON.stringify(f.slice(0, 30)));
  } catch {
    /* */
  }
}

export type ChillPlayerContextValue = {
  videoId: string | null;
  currentTitle: string;
  isLive: boolean;
  playing: boolean;
  volume: number;
  muted: boolean;
  recentSources: ChillRecentSource[];
  favorites: ChillRecentSource[];
  setTrack: (p: { videoId: string; title: string; isLive?: boolean; autoPlay?: boolean }) => void;
  setPlaying: (p: boolean | ((b: boolean) => boolean)) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean | ((b: boolean) => boolean)) => void;
  togglePlay: () => void;
  pushRecent: (id: string, title: string, live: boolean) => void;
  pickRecent: (s: ChillRecentSource) => void;
  toggleFavorite: () => void;
  removeFavorite: (id: string) => void;
  clearPlayback: () => void;
};

const ChillPlayerContext = createContext<ChillPlayerContextValue | null>(null);

export function ChillPlayerProvider({ children }: { children: React.ReactNode }) {
  const persisted = useMemo(() => readState(), []);
  const [videoId, setVideoId] = useState<string | null>(persisted.lastVideoId ?? null);
  const [currentTitle, setCurrentTitle] = useState(persisted.lastTitle ?? '');
  const [isLive, setIsLive] = useState(!!persisted.isLive);
  const [playing, setPlaying] = useState(!!persisted.playing);
  const [volume, setVolumeState] = useState(typeof persisted.volume === 'number' ? persisted.volume : 70);
  const [muted, setMutedState] = useState(!!persisted.muted);
  const [recentSources, setRecentSources] = useState<ChillRecentSource[]>(
    Array.isArray(persisted.recentSources) ? persisted.recentSources.slice(0, 8) : [],
  );
  const [favorites, setFavorites] = useState<ChillRecentSource[]>(() => readFavorites());

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      writeState({
        volume,
        muted,
        recentSources,
        lastVideoId: videoId,
        lastTitle: currentTitle,
        isLive,
        playing,
      });
    }, 200);
  }, [volume, muted, recentSources, videoId, currentTitle, isLive, playing]);

  useEffect(() => {
    persist();
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [persist]);

  const setTrack = useCallback(
    (p: { videoId: string; title: string; isLive?: boolean; autoPlay?: boolean }) => {
      setVideoId(p.videoId);
      setCurrentTitle(p.title || p.videoId);
      setIsLive(!!p.isLive);
      if (p.autoPlay !== false) setPlaying(true);
    },
    [],
  );

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    if (v > 0) setMutedState(false);
  }, []);

  const setMuted = useCallback((m: boolean | ((b: boolean) => boolean)) => {
    setMutedState(m);
  }, []);

  const togglePlay = useCallback(() => {
    setPlaying((x) => !x);
  }, []);

  const pushRecent = useCallback((id: string, title: string, live: boolean) => {
    setRecentSources((prev) => {
      const next = [{ videoId: id, title, isLive: live }, ...prev.filter((x) => x.videoId !== id)];
      return next.slice(0, 8);
    });
  }, []);

  const pickRecent = useCallback((s: ChillRecentSource) => {
    setVideoId(s.videoId);
    setCurrentTitle(s.title);
    setIsLive(!!s.isLive);
    setPlaying(true);
  }, []);

  const toggleFavorite = useCallback(() => {
    if (!videoId || !currentTitle) return;
    setFavorites((prev) => {
      const exists = prev.some((f) => f.videoId === videoId);
      let next: ChillRecentSource[];
      if (exists) {
        next = prev.filter((f) => f.videoId !== videoId);
      } else {
        next = [{ videoId, title: currentTitle, isLive }, ...prev.filter((f) => f.videoId !== videoId)].slice(0, 30);
      }
      writeFavorites(next);
      return next;
    });
  }, [videoId, currentTitle, isLive]);

  const removeFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = prev.filter((f) => f.videoId !== id);
      writeFavorites(next);
      return next;
    });
  }, []);

  const clearPlayback = useCallback(() => {
    setVideoId(null);
    setCurrentTitle('');
    setPlaying(false);
    setIsLive(false);
  }, []);

  const value = useMemo<ChillPlayerContextValue>(
    () => ({
      videoId,
      currentTitle,
      isLive,
      playing,
      volume,
      muted,
      recentSources,
      favorites,
      setTrack,
      setPlaying,
      setVolume,
      setMuted,
      togglePlay,
      pushRecent,
      pickRecent,
      toggleFavorite,
      removeFavorite,
      clearPlayback,
    }),
    [
      videoId,
      currentTitle,
      isLive,
      playing,
      volume,
      muted,
      recentSources,
      favorites,
      setTrack,
      setPlaying,
      setVolume,
      setMuted,
      togglePlay,
      pushRecent,
      pickRecent,
      toggleFavorite,
      removeFavorite,
      clearPlayback,
    ],
  );

  return <ChillPlayerContext.Provider value={value}>{children}</ChillPlayerContext.Provider>;
}

export function useChillPlayer(): ChillPlayerContextValue {
  const v = useContext(ChillPlayerContext);
  if (!v) {
    throw new Error('useChillPlayer must be used within ChillPlayerProvider');
  }
  return v;
}

export function useChillPlayerOptional(): ChillPlayerContextValue | null {
  return useContext(ChillPlayerContext);
}
