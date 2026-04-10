import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, Download, Loader } from 'lucide-react';
import { Button } from './ui/Button';

export interface AudioPlayerProps {
  audioBlob: Blob;
  autoPlay?: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  className?: string;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  audioBlob,
  autoPlay = false,
  onPlay,
  onPause,
  className = '',
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef = useRef<string>('');

  useEffect(() => {
    const url = URL.createObjectURL(audioBlob);
    urlRef.current = url;

    if (audioRef.current) {
      audioRef.current.src = url;
      audioRef.current.addEventListener('loadedmetadata', handleLoadedMetadata);
      audioRef.current.addEventListener('timeupdate', handleTimeUpdate);
      audioRef.current.addEventListener('ended', handleEnded);
      audioRef.current.addEventListener('play', handlePlay);
      audioRef.current.addEventListener('pause', handlePause);

      if (autoPlay) {
        audioRef.current.play().catch(err => console.error('Autoplay failed:', err));
      }
    }

    return () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
      }
    };
  }, [audioBlob, autoPlay]);

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
      setIsLoading(false);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
  };

  const handlePlay = () => {
    setIsPlaying(true);
    if (onPlay) onPlay();
  };

  const handlePause = () => {
    setIsPlaying(false);
    if (onPause) onPause();
  };

  const togglePlayPause = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play().catch(err => console.error('Play failed:', err));
      }
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (audioRef.current && duration > 0) {
      const rect = e.currentTarget.getBoundingClientRect();
      const percent = (e.clientX - rect.left) / rect.width;
      audioRef.current.currentTime = percent * duration;
    }
  };

  const handleDownload = () => {
    const url = URL.createObjectURL(audioBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'speech.mp3';
    link.click();
    URL.revokeObjectURL(url);
  };

  const formatTime = (seconds: number) => {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className={`flex items-center gap-2 bg-gray-100 dark:bg-gray-800 rounded-lg p-2 max-w-xs [data-skin='niho']:bg-[var(--niho-text-bg)] [data-skin='niho']:border [data-skin='niho']:border-[var(--niho-text-border)] ${className}`}>
      <Button
        size="sm"
        variant="ghost"
        onClick={togglePlayPause}
        disabled={isLoading}
        className="flex-shrink-0 [data-skin='niho']:hover:bg-[var(--color-accent-bg)]"
      >
        {isLoading ? (
          <Loader className="w-4 h-4 animate-spin" />
        ) : isPlaying ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4" />
        )}
      </Button>

      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <div
          onClick={handleProgressClick}
          className="w-full h-1 bg-gray-300 dark:bg-gray-600 rounded-full cursor-pointer hover:h-1.5 transition-all [data-skin='niho']:bg-[var(--niho-text-border)]"
          role="progressbar"
          aria-valuenow={Math.round((currentTime / duration) * 100) || 0}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-blue-500 rounded-full transition-all [data-skin='niho']:bg-[var(--color-accent)]"
            style={{ width: `${(currentTime / duration) * 100 || 0}%` }}
          />
        </div>
        <div className="text-xs text-gray-600 dark:text-gray-400 [data-skin='niho']:text-[var(--text-secondary)]">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>
      </div>

      <Button
        size="sm"
        variant="ghost"
        onClick={handleDownload}
        className="flex-shrink-0 [data-skin='niho']:hover:bg-[var(--color-accent-bg)]"
        title="Download audio"
      >
        <Download className="w-4 h-4" />
      </Button>

      <audio ref={audioRef} />
    </div>
  );
};
