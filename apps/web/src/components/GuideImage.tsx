'use client';

import { useRef } from 'react';
import { Expand, X } from 'lucide-react';
import imageData from '@/content/guide-images.json';
import styles from '@/app/guide/guide.module.css';

export function GuideImage({ src, alt }: { src: string; alt: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dimensions = (imageData as Record<string, { width: number; height: number }>)[src];
  return <figure className={styles.figure}>
    <button type="button" className={styles.imageButton} onClick={() => dialog.current?.showModal()} aria-label={`放大查看：${alt}`} aria-haspopup="dialog">
      <img src={src} alt={alt} width={dimensions?.width} height={dimensions?.height} loading="lazy" decoding="async" />
      <span><Expand size={13} />点击查看大图</span>
    </button>
    <figcaption>{alt}</figcaption>
    <dialog ref={dialog} className={styles.imageDialog} aria-label={alt} onClick={event => {
      if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.current?.close();
      }
    }}>
      <button type="button" className={styles.closeImage} onClick={() => dialog.current?.close()} aria-label="关闭大图"><X size={22} /></button>
      <img src={src} alt={alt} width={dimensions?.width} height={dimensions?.height} />
      <p>{alt}</p>
    </dialog>
  </figure>;
}
