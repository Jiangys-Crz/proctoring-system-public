'use client';

import { useEffect, useId, useState } from 'react';
import type { ReactionAdminView, ReactionPresentationView } from './reaction-types';
import styles from './ReactionAdmin.module.css';

/** Layout only: the exported animation still comes from the official generator. */
export function ReactionAppearancePreview({ endpoint, backgroundUrl, fontPreset, candidates, refresh }: {
  endpoint: string; backgroundUrl?: string; fontPreset: ReactionPresentationView['fontPreset'];
  candidates: ReactionAdminView['candidates']; refresh: number;
}) {
  const [teamId, setTeamId] = useState('');
  const [overlay, setOverlay] = useState(true);
  const [state, setState] = useState('pending');
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const [assetError, setAssetError] = useState(false);
  const clipId = useId();
  const team = candidates.find(item => item.teamId === teamId) || candidates[0];
  const imageUrl = backgroundUrl || `${endpoint}/appearance-preview?kind=background`;
  const logoUrl = `${endpoint}/appearance-preview?kind=logo&teamId=${encodeURIComponent(team?.teamId || '')}&revision=${refresh}`;
  useEffect(() => {
    setDimensions(undefined); setAssetError(false);
    const image = new Image();
    image.onload = () => setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => setAssetError(true);
    image.src = imageUrl;
    return () => { image.onload = null; image.onerror = null; };
  }, [imageUrl]);
  const fill = state === 'AC' ? '#1B8041' : state === 'WA' ? '#B22C1B' : '#FDBA12';
  return <div className={styles.assetCard}>
    <div className={styles.heading}><h3>竖屏排版预览</h3><span className="muted">1080 × 1920</span></div>
    {candidates.length ? <label>预览队伍<select aria-label="预览队伍" value={team?.teamId || ''} onChange={event => setTeamId(event.target.value)}>{candidates.map(item => <option key={item.teamId} value={item.teamId}>{item.teamName} · {item.teamId}</option>)}</select></label> : null}
    <div className={styles.previewControls}>
      <label className={styles.check}><input type="checkbox" checked={overlay} onChange={event => setOverlay(event.target.checked)} />显示视频与信息卡位置</label>
      <label>示意状态<select aria-label="预览判题状态" value={state} onChange={event => setState(event.target.value)} disabled={!overlay}><option value="pending">等待判题</option><option value="AC">AC</option><option value="WA">WA</option></select></label>
    </div>
    <svg className={styles.compositionPreview} viewBox="0 0 1080 1920" role="img" aria-label="Reaction 竖屏背景与视频位置预览">
      <title>Reaction 竖屏排版预览，视频、题目、时间及名次为位置示意</title>
      <defs><clipPath id={clipId}><rect x="264" y="871" width="500" height="226" /></clipPath></defs>
      <rect width="1080" height="1920" fill="#c9eafa" />
      <image href={imageUrl} width="1080" height="1920" preserveAspectRatio="xMidYMid slice" />
      {overlay ? <g fontFamily="'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif">
        <g fill="#142b3c"><rect x="40" y="194.5" width="1000" height="562.5" /><rect x="40" y="1163" width="1000" height="562.5" /></g>
        <g fill="none" stroke="#658597" strokeWidth="3">
          <circle cx="540" cy="405" r="55" /><path d="M425 555c0-115 230-115 230 0" />
          <rect x="438" y="1340" width="204" height="132" rx="8" /><path d="M540 1472v34m-65 0h130" />
        </g>
        <g fill="#e5f2f8" textAnchor="middle" fontSize="38"><text x="540" y="639">摄像头画面 · 16:9</text><text x="540" y="1585">桌面画面 · 16:9</text></g>
        <rect x="40" y="855" width="1000" height="258" rx="48" fill={fill} />
        <rect x="790" y="807" width="250" height="66" rx="33" fill="#3D3D3D" />
        <text x="915" y="850" fill="white" fontSize="34" textAnchor="middle">名次区域</text>
        <circle cx="156" cy="984" r="76" fill="white" stroke="#dcecf4" strokeWidth="2" />
        <image key={logoUrl} href={logoUrl} x="92" y="920" width="128" height="128" preserveAspectRatio="xMidYMid meet" />
        <g clipPath={`url(#${clipId})`} fill="white">
          <text x="264" y="968" fontSize={fontPreset === 'broadcast' ? 60 : 58} fontWeight="700">{team?.teamName || '队伍名称'}</text>
          <text x="264" y="1080" fontSize="30">{team?.schoolName || '学校 / 组织名称'}</text>
        </g>
        <g fill="white" textAnchor="middle"><text x="890" y="991" fontFamily="Arial, sans-serif" fontSize="116" fontWeight="bold">A</text><text x="890" y="1078" fontFamily="Consolas, monospace" fontSize="28">{state === 'pending' ? '..' : state} 00:00:00</text></g>
      </g> : null}
    </svg>
    {assetError ? <p role="alert" className={styles.warning}>背景预览加载失败，请重新上传或刷新页面。</p> : null}
    {dimensions ? <p className="muted">{backgroundUrl ? '已上传背景' : '内置背景'}：{dimensions.width} × {dimensions.height} 像素。{Math.abs(dimensions.width / dimensions.height - 9 / 16) > 0.01 ? '当前比例会居中裁切，预览已显示裁切结果。' : '与输出比例一致。'}</p> : null}
    <p className="muted">仅作版式示意；徽章按当前组织设置显示，视频区域为占位画面，题目、时间和名次以实际生成结果为准。导出保留官方动画，字体在预览中使用浏览器字体近似显示。</p>
  </div>;
}
