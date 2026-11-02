'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Database, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { api } from './api';
import { problemTypeLabel } from '@cwnupaa/proctor-shared';

type Problem = { id: string; pid: string; title: string; config: Record<string, unknown>; tags: string[]; difficulty: number; score?: number };

export function ProblemsPageClient() {
  const [items, setItems] = useState<Problem[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const searchController = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const queryRef = useRef(query);
  queryRef.current = query;

  const load = useCallback(async (nextQuery: string, signal?: AbortSignal) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const result = await api<Problem[]>(`/api/problems?query=${encodeURIComponent(nextQuery)}&limit=100`, {
        signal,
        cache: 'no-store'
      });
      if (signal?.aborted || nextQuery !== queryRef.current) return;
      setItems(result);
      setError('');
      setUpdatedAt(new Date());
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError('题库服务暂时无法连接，正在自动重试');
    } finally {
      busy.current = false;
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const timer = window.setTimeout(() => void load(query, controller.signal), 260);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, query]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(queryRef.current), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  return <div className="problems-page grid">
    <div className="topbar problems-page-header">
      <div><h1>题库管理</h1></div>
      <button className="button secondary problems-refresh" onClick={() => void load(query)} disabled={loading}>
        <RefreshCw size={15} className={loading ? 'spin' : ''} />{loading ? '刷新中…' : '刷新'}
      </button>
    </div>
    {error ? <div className="card problem-error" role="status">{error}</div> : null}
    <section className="card problems-browser">
      <div className="problems-browser-toolbar">
        <div className={`problems-search${query ? ' has-value' : ''}${loading ? ' is-loading' : ''}`}>
          <span className="problems-search-icon"><Search size={18} /></span>
          <input type="search" aria-label="搜索题库" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索题号、题目标题或标签" autoComplete="off" spellCheck={false} />
          <span className="problems-search-status" aria-live="polite">{loading ? <><LoaderCircle className="spin" size={14} /> 刷新中</> : query ? `${items.length} 条结果` : '实时更新'}</span>
          {query ? <button type="button" className="problems-search-clear" onClick={() => setQuery('')} aria-label="清空搜索"><X size={15} /></button> : null}
        </div>
        <div className="problems-count"><span className="problems-count-icon"><Database size={15} /></span><span>共 <strong>{items.length}</strong> 道题</span></div>
      </div>
      <div className="problems-list-caption"><span>题目列表</span>{updatedAt ? <small>更新于 {updatedAt.toLocaleTimeString('zh-CN', { hour12: false })}</small> : null}</div>
      <div className="problems-table-wrap"><table className="table hydro-problem-table"><thead><tr><th className="problem-col-index">#</th><th>题目</th><th>题型</th><th>标签</th><th>难度</th><th>分值</th><th></th></tr></thead><tbody>
        {items.map(problem => {
          const type = problemTypeLabel(String(problem.config?.type || 'default'));
          const tags = Array.isArray(problem.tags) ? problem.tags : [];
          const difficulty = Number(problem.difficulty || 0);
          const score = Number(problem.score);
          return <tr key={problem.id}>
            <td className="problem-col-index"><span className="problem-pid">{problem.pid}</span></td>
            <td><Link className="problem-row-title" href={`/dashboard/problems/${problem.id}`}>{problem.title}</Link><span className="problem-row-subtitle">题号 {problem.pid}</span></td>
            <td><span className="problem-type-badge">{type}</span></td>
            <td><div className="problem-tags">{tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}{!tags.length ? <em>未分类</em> : null}</div></td>
            <td><span className={`problem-difficulty difficulty-${Math.min(5, Math.max(0, difficulty))}`}>{difficulty ? `Lv.${difficulty}` : '—'}</span></td>
            <td><strong className="problem-score">{Number.isFinite(score) && score > 0 ? score : '—'}</strong></td>
            <td className="problem-row-action"><Link href={`/dashboard/problems/${problem.id}`} aria-label={`查看 ${problem.title}`}><ArrowRight size={16} /></Link></td>
          </tr>;
        })}
        {!items.length && !loading && !error ? <tr><td colSpan={7} className="problems-empty"><Database size={24} /><strong>暂无题目</strong><span>题目创建后会自动显示在这里</span></td></tr> : null}
        {!items.length && !loading && error ? <tr><td colSpan={7} className="problems-empty"><RefreshCw size={24} /><strong>正在等待题库服务恢复</strong><span>连接恢复后会自动显示最新题目</span></td></tr> : null}
        {loading && !items.length ? Array.from({ length: 5 }, (_, index) => <tr className="problem-skeleton-row" key={index}><td colSpan={7}><span /></td></tr>) : null}
      </tbody></table></div>
    </section>
  </div>;
}
