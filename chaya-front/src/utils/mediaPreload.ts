/**
 * 图片预加载/预解码工具
 *
 * 目标：在打开媒体库（右侧面板）前把图片放进缓存并尽量完成 decode，
 * 从而提升“点缩略图→看到大图”的首帧速度。
 */

type PreloadOptions = {
  /** 预解码，能显著降低首次展示卡顿（可能占用 CPU） */
  decode?: boolean;
  /** 允许跨域图片（如果服务端没 CORS 会失败，但不影响正常加载） */
  crossOrigin?: '' | 'anonymous' | 'use-credentials';
};

const inFlight = new Map<string, Promise<void>>();

export function preloadImage(src: string, options: PreloadOptions = {}): Promise<void> {
  const url = String(src || '').trim();
  if (!url) return Promise.resolve();

  // 避免重复预加载
  const existing = inFlight.get(url);
  if (existing) return existing;

  const { decode = true, crossOrigin = 'anonymous' } = options;

  const p = new Promise<void>((resolve) => {
    const img = new Image();
    try {
      img.crossOrigin = crossOrigin;
    } catch {
      // ignore
    }

    img.onload = async () => {
      if (!decode || typeof (img as any).decode !== 'function') {
        resolve();
        return;
      }
      try {
        await (img as any).decode();
      } catch {
        // decode 失败不影响后续正常展示
      } finally {
        resolve();
      }
    };
    img.onerror = () => resolve();
    img.src = url;
  }).finally(() => {
    // 释放 inFlight，避免 map 无限增长
    inFlight.delete(url);
  });

  inFlight.set(url, p);
  return p;
}


