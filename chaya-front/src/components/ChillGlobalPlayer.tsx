import React from 'react';
import { useChillPlayer } from '../contexts/ChillPlayerContext';
import { YouTubeMiniPlayer } from './YouTubeMiniPlayer';

/** 挂载在应用根部，离开 Chill 页后仍保持 YouTube 播放器实例 */
export const ChillGlobalPlayer: React.FC = () => {
  const { videoId, playing, volume, muted } = useChillPlayer();
  return <YouTubeMiniPlayer videoId={videoId} playing={playing} volume={volume} muted={muted} />;
};
