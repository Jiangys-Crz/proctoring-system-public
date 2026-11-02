'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, LoaderCircle } from 'lucide-react';
import { api } from './api';
import { codeCheckLanguageLabel, codeCheckPercent, codeCheckSeverity, type CodeCheckDetailData, type CodeCheckMatch } from '@/lib/code-check/types';
import styles from './ExamCodeCheck.module.css';

function lines(code: string, matches: CodeCheckMatch[], side: 'First' | 'Second') {
  return code.split(/\r?\n/).map((text, index) => ({ number: index + 1, text, blocks: matches.flatMap((match, block) => index + 1 >= match[`startIn${side}`].line && index + 1 <= match[`endIn${side}`].line ? [block + 1] : []) }));
}

export function ExamCodeCheckDetailClient({ examId, pairId }: { examId: string; pairId: string }) {
  const [data, setData] = useState<CodeCheckDetailData | null>(null); const [error, setError] = useState('');
  const [activeBlock, setActiveBlock] = useState(0);
  useEffect(() => {
    let mounted = true;
    api<CodeCheckDetailData>(`/api/exams/${examId}/code-check/pairs/${pairId}`).then(result => { if (mounted) setData(result); }).catch(cause => { if (mounted) setError(cause instanceof Error ? cause.message : '查重对比加载失败'); });
    return () => { mounted = false; };
  }, [examId, pairId]);
  function jump(match: CodeCheckMatch, block: number) {
    setActiveBlock(block);
    document.getElementById(`cc-first-${match.startInFirst.line}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    document.getElementById(`cc-second-${match.startInSecond.line}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  const timing = data?.timing;
  const timingText = timing?.earlier === 'first' ? `左侧先提交，右侧晚 ${timing.differenceText}。` : timing?.earlier === 'second' ? `右侧先提交，左侧晚 ${timing.differenceText}。` : timing?.earlier === 'same' ? '两份代码在同一秒提交，无法据此确定先后。' : '部分提交时间缺失，无法比较先后。';
  return <div className={`exam-workspace-page ${styles.page}`}>
    <header className="exam-workspace-header"><div className="return-only-row"><Link className="exam-back" href={`/dashboard/exams/${examId}/code-check${data ? `?jobId=${data.pair.jobId}` : ''}`}><ArrowLeft size={18} /> 返回查重结果</Link></div><div className="exam-workspace-title-row"><h1>代码对比详情</h1></div></header>
    <main className={styles.detailMain}>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {!data ? !error ? <div className={styles.empty}><LoaderCircle size={20} className="spin" /> 正在加载代码快照…</div> : null : <section className={styles.card}>
        <div className={styles.detailSummary}><span className={`${styles.badge} ${styles.largeBadge} ${styles[codeCheckSeverity(data.pair.similarity)]}`}>{codeCheckPercent(data.pair.similarity)}%</span><div><h2>{data.pair.problemTitle} · {codeCheckLanguageLabel(data.pair.language)}</h2><p>代码相似度 · 在 {data.pair.versions} 个提交版本配对中选取最相似的一组</p></div></div>
        <div className={styles.timing}><strong>提交时间对比</strong><span>{timingText}</span></div>
        <p className={styles.muted}>左侧代码匹配覆盖 {codeCheckPercent(data.pair.firstSimilarity)}%，右侧 {codeCheckPercent(data.pair.secondSimilarity)}%。高亮表示匹配片段所在行，不表示整行字符完全相同。</p>
        {data.pair.matches.length ? <div className={styles.matchList} aria-label="匹配片段">{data.pair.matches.map((match, index) => <button key={index} type="button" className={activeBlock === index + 1 ? styles.activeMatch : ''} onClick={() => jump(match, index + 1)}>片段 {index + 1} · A {match.startInFirst.line}–{match.endInFirst.line} / B {match.startInSecond.line}–{match.endInSecond.line}</button>)}</div> : <p>未找到满足当前灵敏度的匹配片段。</p>}
        <div className={styles.codePanes}>{([['first', 'First'], ['second', 'Second']] as const).map(([key, side]) => {
          const source = data[key];
          return <div key={key} className={styles.codePane}><div className={styles.codeHeading}><strong>{source.candidateName} <small>{source.examNumber}</small></strong><span>{source.lang} · 提交 {source.submissionId}</span><time dateTime={source.submittedAt}>提交时间：{new Date(source.submittedAt).toLocaleString('zh-CN', { hour12: false })}</time></div><div className={styles.source}><table><tbody>{lines(source.code, data.pair.matches, side).map(line => <tr id={`cc-${key}-${line.number}`} key={line.number} className={line.blocks.includes(activeBlock) ? styles.selectedLine : line.blocks.length ? styles.matchedLine : ''}><td className={styles.lineNumber}>{line.number}</td><td><pre>{line.text || ' '}</pre></td></tr>)}</tbody></table></div></div>;
        })}</div>
        <p className={styles.muted}>以上为查重时保存的代码快照。相似结果需要结合题目、公共模板和实际提交情况进行人工复核。</p>
      </section>}
    </main>
  </div>;
}
