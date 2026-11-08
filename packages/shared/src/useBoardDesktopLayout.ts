'use client';

import { useLayoutEffect, useRef, useState } from 'react';

export function useBoardDesktopLayout(contentKey: string) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ width: number; scale: number; height?: number }>({ width: 1280, scale: 1 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let active = true;
    let frame = 0;
    const update = () => {
      if (!active) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const currentScale = content.getBoundingClientRect().width / content.offsetWidth || 1;
        let width = Math.max(1280, viewport.clientWidth);
        const title = content.querySelector<HTMLElement>('.rank-page-title h3');
        if (title) {
          const range = document.createRange();
          range.selectNodeContents(title);
          const insets = content.offsetWidth - title.clientWidth;
          width = Math.max(width, range.getBoundingClientRect().width / currentScale + insets);
        }
        content.querySelectorAll<HTMLElement>('.rank-page-filters, .board-submission-filters, .rank-page-timeline-bottom').forEach(row => {
          // A stretched row's scrollWidth includes its current allocated width.
          // Adding a fixed margin to that width feeds each fit back into the next.
          // Instead measure actual controls, ignoring flexible empty spacers.
          const children = Array.from(row.children).filter((child): child is HTMLElement => child instanceof HTMLElement && getComputedStyle(child).display !== 'none');
          const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
          const required = children.reduce((sum, child) => {
            const spacer = Number(getComputedStyle(child).flexGrow) > 0 && !child.textContent?.trim() && child.children.length === 0;
            return sum + (spacer ? 0 : child.getBoundingClientRect().width / currentScale);
          }, Math.max(0, children.length - 1) * gap);
          const insets = content.offsetWidth - row.clientWidth;
          width = Math.max(width, required + insets);
        });
        width = Math.ceil(width - .01);
        const scale = Math.min(1, Math.max(1, viewport.clientWidth) / width);
        const height = Math.ceil(content.offsetHeight * scale);
        setFit(previous => previous.width === width && Math.abs(previous.scale - scale) < 0.0001 && previous.height === height
          ? previous : { width, scale, height });
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(content);
    update();
    void document.fonts.ready.then(update);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [contentKey]);
  return { viewportRef, contentRef, fit };
}
