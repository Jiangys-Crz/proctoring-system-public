'use client';

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Save } from 'lucide-react';
import { api } from './api';
import styles from './ExternalBoardSettings.module.css';

type Config = { baseUrl: string; eventId: string; appKey: string; intervalSeconds: string };
type PushLog = { id: string; createdAt: string; status: 'SUCCESS' | 'ERROR' | 'INFO'; message: string; problemCount: number; submissionCount: number; durationMs: number; baseUrl: string | null; eventId: string | null };
type State = Omit<Config, 'intervalSeconds'> & { intervalSeconds: number; enabled: boolean; lastSuccessAt?: string | null; lastError?: string | null; scanUntil?: string | null; nextAttemptAt?: string | null; logs: PushLog[] };
const draftOf = (state: State): Config => ({ baseUrl: state.baseUrl, eventId: state.eventId, appKey: state.appKey, intervalSeconds: String(state.intervalSeconds) });
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function ExternalBoardSettings({ examId }: { examId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [config, setConfig] = useState<Config>({ baseUrl: 'www.example.org', eventId: '', appKey: '', intervalSeconds: '10' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const dirty = useRef(false), saving = useRef(false), revision = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const endpoint = `/api/exams/${examId}/external-board`;

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || saving.current) return;
      fetching = true;
      const version = revision.current;
      try {
        const next = await api<State>(endpoint, { signal: controller.signal, cache: 'no-store' });
        if (controller.signal.aborted || version !== revision.current) return;
        setState(next);
        setMessage('');
        if (!dirty.current) setConfig(draftOf(next));
        setLoading(false);
      } catch (cause) {
        if (!controller.signal.aborted && version === revision.current) { setError(cause instanceof Error ? cause.message : '外榜配置加载失败'); setLoading(false); }
      } finally { fetching = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 5_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [endpoint, reload]);

  function edit(patch: Partial<Config>) {
    dirty.current = true;
    setConfig(current => ({ ...current, ...patch }));
    setMessage('');
  }

  async function save(enabled?: boolean) {
    if (saving.current || !state) return;
    // A stop request always uses the saved settings, even if a draft is incomplete.
    if (enabled !== false && !form.current?.reportValidity()) return;
    const input = enabled === false ? { externalBoardEnabled: false } : {
      ...(enabled === undefined ? {} : { externalBoardEnabled: enabled }),
      externalBoardBaseUrl: config.baseUrl || null, externalBoardEventId: config.eventId || null, externalBoardApiKey: config.appKey || null,
      externalBoardIntervalSeconds: Number(config.intervalSeconds),
    };
    saving.current = true; revision.current += 1; setBusy(true); setError(''); setMessage('');
    try {
      const next = await api<State>(endpoint, { method: 'PATCH', body: JSON.stringify(input) });
      setState(next);
      if (enabled !== false) {
        dirty.current = false;
        setConfig(draftOf(next));
      }
      setMessage(enabled === false ? '推送已关闭' : enabled === true ? '推送已开启，正在开始同步' : '外榜配置已保存并生效');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '外榜配置保存失败'); }
    finally { saving.current = false; setBusy(false); }
  }

  return <section className="card grid exam-settings-card">
    <div className="table-toolbar"><div><h2 style={{ margin: 0 }}>外榜推送</h2><p className="muted">比赛进行中也可调整。开关立即生效，配置在这里独立保存。</p></div><button className="button secondary" disabled={busy} onClick={() => { setError(''); setReload(value => value + 1); }}><RefreshCw size={17} />刷新状态</button></div>
    {error ? <div className="exam-editor-error" role="alert">{error}</div> : null}
    <form ref={form} className="form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={loading || busy || !state} style={{ border: 0, padding: 0, margin: 0 }} className="form">
        <div className={styles.switchRow}>
          <div><strong>自动推送外榜</strong><p className="muted">点击开启立即推送，之后按设置的间隔同步；点击关闭停止推送。</p></div>
          <div className={styles.switchControl}><span>{busy ? '处理中…' : state?.enabled ? '已开启' : '已关闭'}</span><button type="button" className={styles.switchButton} role="switch" aria-label="外榜推送开关" aria-checked={state?.enabled ?? false} aria-busy={busy} onClick={() => { void save(!state?.enabled); }}><span className={styles.switchThumb} /></button></div>
        </div>
        <label>CWNUPAA 官网域名<input maxLength={512} placeholder="www.example.org（默认）" value={config.baseUrl} onChange={event => edit({ baseUrl: event.target.value })} /></label>
        <label>CWNUPAA 官网赛事 ID<input inputMode="numeric" maxLength={19} required pattern="[1-9][0-9]*" placeholder="必须填写官网比赛 ID" value={config.eventId} onChange={event => edit({ eventId: event.target.value })} /></label>
        <label>推送密钥 <span className="muted">（可选）</span><input type="password" autoComplete="new-password" maxLength={2000} placeholder="留空使用 CWNUPAA 外部登录密钥" value={config.appKey} onChange={event => edit({ appKey: event.target.value })} /></label>
        <label>推送间隔（秒）<input type="number" min={1} max={86400} step={1} required value={config.intervalSeconds} onChange={event => edit({ intervalSeconds: event.target.value })} /><small className="muted">默认 10 秒，可设置 1～86400 秒。修改后点击保存，已开启的比赛立即按新间隔运行。</small></label>
        <small className="muted">域名默认 www.example.org。密钥留空使用系统设置中的 CWNUPAA 外部登录密钥，所用密钥需有官网“外榜”权限。官网已审核报名的比赛账号须与本场考号一致。开启时会一并保存当前配置，关闭立即停止推送。</small>
        <div><button type="submit" className="button">{busy ? <LoaderCircle size={17} className="spin" /> : <Save size={17} />}{busy ? '处理中…' : '保存外榜配置'}</button></div>
      </fieldset>
    </form>
    <div className="muted" role="status">{loading ? '正在加载外榜配置…' : message || (!state?.enabled ? '推送已关闭' : state.lastError ? `推送失败：${state.lastError}` : state.scanUntil ? '正在同步比赛记录…' : state.lastSuccessAt ? `最近同步：${time(state.lastSuccessAt)}` : '等待同步比赛记录')}{state?.enabled && state.nextAttemptAt ? <span> · 下次推送：{time(state.nextAttemptAt)}（间隔 {state.intervalSeconds} 秒）</span> : null}</div>
    <section className={styles.logs} aria-label="推送日志">
      <div className={styles.logHeading}><h3>推送日志</h3><span className="muted">实时刷新 · 最近 100 条临时日志，网站重启后清空</span></div>
      <div className={styles.logScroll}><table className="table"><thead><tr><th>时间</th><th>结果</th><th>说明</th><th>题目</th><th>提交</th><th>耗时</th></tr></thead><tbody>
        {state?.logs.map(log => <tr key={log.id}><td className={styles.logTime}>{time(log.createdAt)}</td><td><span className={`${styles.badge} ${styles[log.status]}`}>{log.status === 'SUCCESS' ? '成功' : log.status === 'ERROR' ? '失败' : '操作'}</span></td><td className={styles.logMessage}><span>{log.message}</span><small className="muted">{log.baseUrl}{log.eventId ? ` · 比赛 ID ${log.eventId}` : ''}</small></td><td>{log.problemCount}</td><td>{log.submissionCount}</td><td>{log.status === 'INFO' ? '—' : `${log.durationMs} ms`}</td></tr>)}
        {!state?.logs.length ? <tr><td colSpan={6} className="muted">{loading ? '正在加载日志…' : '暂无推送日志，开启推送后将在这里显示结果。'}</td></tr> : null}
      </tbody></table></div>
    </section>
  </section>;
}
