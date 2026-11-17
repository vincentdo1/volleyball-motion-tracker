import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv)$/i;

export function looksLikeVideo(file: File): boolean {
  return file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name);
}

/** Window-wide drag and drop plus paste. `dragging` is true while a file is held over the page. */
export function useWindowDrop(onFile: (file: File) => void, enabled: boolean): { dragging: boolean } {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFile);
  handler.current = onFile;

  const reset = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      reset();
      const file = e.dataTransfer?.files[0];
      if (file) handler.current(file);
    };
    const onPaste = (e: ClipboardEvent) => {
      const file = e.clipboardData?.files[0];
      if (file) handler.current(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
      reset();
    };
  }, [enabled, reset]);

  return { dragging };
}

const noSubscribe = () => () => undefined;

/** Tracks a CSS media query, e.g. `(min-width: 1024px)`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof matchMedia !== 'function') return noSubscribe();
      const list = matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
  );
}
