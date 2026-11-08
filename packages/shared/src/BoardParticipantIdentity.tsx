'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { StandingParticipant as RankItem } from './standing-types';
import './BoardParticipantIdentity.css';
const formatAdvisor = (value?: string | null, fallback = '无') => value?.trim() || fallback;

export type BoardParticipant = Pick<RankItem, 'itemId' | 'rank' | 'name' | 'organization' | 'organizationLogo' | 'members' | 'memberInfos' | 'advisor' | 'coach' | 'englishName' | 'isStar' | 'isGirl' | 'group'>;
type Participant = BoardParticipant;
type Props = { row: Participant; isTeam: boolean };
const isUnofficial = (row: Pick<Participant, 'isStar' | 'rank' | 'group'>) => row.isStar || row.group === 'star' || row.rank === -1;
const memberNames = (row: Participant) => row.memberInfos?.map(member => member.name).filter(Boolean).join('、') || row.members?.replace(/[,，]\s*/g, '、') || '';
const coachName = (row: Participant) => formatAdvisor(row.coach || row.advisor, '无');

export function BoardParticipantMarkers({ row }: { row: Pick<Participant, 'isStar' | 'isGirl' | 'rank' | 'group'> }) {
  return <>{(row.isGirl || row.group === 'girl') && <span className="board-participant-marker" role="img" aria-label="女生队伍">👧</span>}{isUnofficial(row) && <span className="board-participant-marker" role="img" aria-label="打星参赛">⭐</span>}</>;
}

function ParticipantDetails({ row, isTeam }: Props) {
  const unofficial = isUnofficial(row);
  const fields = [
    ['学校/组织', 'School / Org', row.organization || '—'],
    [isTeam ? '参赛队伍编号' : '参赛者编号', isTeam ? 'Team ID' : 'Participant ID', String(row.itemId)],
    [isTeam ? '队名' : '姓名', isTeam ? 'Team name' : 'Name', row.name],
    ['指导老师', 'Coach', coachName(row)],
    [isTeam ? '队伍成员' : '选手', isTeam ? 'Members' : 'Participant', memberNames(row) || (isTeam ? '无' : row.name)],
  ];
  return <section className="board-participant-details" aria-label={isTeam ? '队伍详情' : '参赛者详情'}>
    <header><strong>{isTeam ? '队伍信息' : '选手信息'} <small>{isTeam ? 'Team details' : 'Participant details'}</small></strong><span className={`board-participant-kind${unofficial ? ' unofficial' : ''}`}>{unofficial ? '⭐ 打星' : '◆ 正式'}{row.isGirl ? ' · 👧 女生' : ''}</span></header>
    <dl>{fields.map(([label, english, value]) => <div key={english}><dt>{label}<small>{english}</small></dt><dd>{value}</dd></div>)}</dl>
  </section>;
}

export function BoardParticipantOrganization({ row, watermark = false }: Props & { watermark?: boolean }) {
  return <div className="board-participant-organization">{watermark && <BoardParticipantWatermark row={row} />}<span className="board-participant-name" title={row.organization}>{row.organization || '—'}</span></div>;
}

export function BoardParticipantWatermark({ row }: { row: Pick<Participant, 'organizationLogo'> }) {
  const [failedLogo, setFailedLogo] = useState<string>();
  return row.organizationLogo && failedLogo !== row.organizationLogo ? <img className="board-participant-watermark" src={row.organizationLogo} alt="" aria-hidden="true" loading="lazy" decoding="async" onError={() => setFailedLogo(row.organizationLogo)} /> : null;
}

export function BoardParticipantMetadata({ row, isTeam }: Props) {
  const [position, setPosition] = useState<{left:number;top:number} | null>(null);
  const show = (target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    setPosition({ left: Math.max(12, Math.min(bounds.left, window.innerWidth - 456)), top: Math.max(12, Math.min(bounds.bottom + 6, window.innerHeight - 340)) });
  };
  const members = memberNames(row) || (isTeam ? '无' : row.name);
  return <>
    <button type="button" className="board-participant-details-trigger" onMouseEnter={event => show(event.currentTarget)} onMouseLeave={() => setPosition(null)} onFocus={event => show(event.currentTarget)} onBlur={() => setPosition(null)} aria-label={`查看${row.name}的${isTeam ? '队伍' : '参赛者'}详情`}>
      <span className="board-participant-meta" aria-label={`指导老师：${coachName(row)}`}><svg className="anticon" aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/></svg><span>{coachName(row)}</span></span>
      <span className="board-participant-meta" aria-label={`${isTeam ? '队伍成员' : '选手'}：${members}`}><svg className="anticon" aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="9" cy="7" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M16 4a3 3 0 0 1 0 6M18 14a6 6 0 0 1 4 6"/></svg><span>{members}</span></span>
    </button>
    {position && createPortal(<div className="board-participant-details-popup" style={position}><ParticipantDetails row={row} isTeam={isTeam} /></div>, document.body)}
  </>;
}

export function BoardParticipantTeam({ row, isTeam, watermark = true, compact = false }: Props & { watermark?: boolean; compact?: boolean }) {
  return <div className="board-participant-identity">
    {watermark && <BoardParticipantWatermark row={row} />}
    <div className="board-participant-foreground">
      <div className="board-participant-heading"><span className="board-participant-name board-participant-team-name" title={row.name}>{row.name}</span><BoardParticipantMarkers row={row} /></div>
      {!compact && <BoardParticipantMetadata row={row} isTeam={isTeam} />}
    </div>
  </div>;
}
