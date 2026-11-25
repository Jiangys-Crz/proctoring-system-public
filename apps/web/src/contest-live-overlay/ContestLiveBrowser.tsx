'use client';

import dynamic from 'next/dynamic';
import type { OverlayPageProps } from './OverlayPage';
import styles from './overlay.module.css';

const OverlayPage = dynamic(() => import('./OverlayPage'), { ssr: false });

export function ContestLiveBrowser(props: OverlayPageProps) {
  return <div className={styles.overlay} lang="en"><OverlayPage key={props.examId} {...props} /></div>;
}
