'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

type SyncState = { examCode: string; role: 'HUB' | 'EDGE' | null; enabled: boolean; baseUrl: string; hasKey: boolean;
  lastSuccessAt: string | null; lastError: string; communicationSuccessAt: string | null; communicationError: string; local: number; imported: number; queued: number; pendingPush: number;
  issuedKey?: string; checked?: boolean; matchedCandidates?: number; matchedProblems?: number };
export function ExamFederationSettings({ examId }: { examId: string }) {
  const saving = useRef(false), revision = useRef(0);
  const [state, setState] = useState<SyncState | null>(null);
  const [baseUrl, setBaseUrl] = useState(''); const [code, setCode] = useState(''); const [key, setKey] = useState('');
  const [issuedKey, setIssuedKey] = useState(''); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async (initial: boolean) => {
      if (fetching || saving.current) return;
      fetching = true; const version = revision.current;
      try {
        const value = await api<SyncState>(`/api/exams/${examId}/federation`, { signal: controller.signal, cache: 'no-store' });
        if (controller.signal.aborted || version !== revision.current) return;
        setState(value);
        if (initial) { setBaseUrl(value.baseUrl); setCode(value.examCode); }
      } catch (err) { if (!controller.signal.aborted && version === revision.current) setError(err instanceof Error ? err.message : '加载失败'); }
      finally { fetching = false; }
    };
    void load(true); const timer = setInterval(() => void load(false), 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [examId]);
  async function save(action: string) {
    if (saving.current) return;
    saving.current = true; revision.current++;
    setBusy(true); setError(''); setMessage('');
    try {
      const input = action === 'check' || action === 'edge-connect' ? { action, baseUrl, examCode: code, apiKey: key || undefined } : { action };
      const value = await api<SyncState>(`/api/exams/${examId}/federation`, { method: 'POST', body: JSON.stringify(input) });
      setState(value);
      if (value.issuedKey) setIssuedKey(value.issuedKey);
      if (action === 'edge-connect') { setKey(''); setCode(value.examCode); }
      setMessage(action === 'check' ? `一致性检查通过：${value.matchedCandidates} 个考生账号，${value.matchedProblems} 道题目。` : '同步设置已保存');
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <section className="card form exam-settings-card" style={{ gap: 16 }}>
    <h2 style={{ margin: 0 }}>公网与内网同步</h2>
    <p style={{ margin: 0 }}>两端分别判题，按考试编号和考号同步代码、评测详情、排行榜、公告和答疑。请先导入相同的考生账号、密码和题目，并保持题目顺序、题面、判题设置和分值一致；两端 Hydro 题号可以不同，检查通过后自动建立对应关系。考室、座位和监考安排可不同。开启后考试定义、题目及考生资料将锁定，有同步记录后仍会保留此限制。</p>
    {error ? <div role="alert" className="exam-editor-error">{error}</div> : null}
    {message ? <p role="status">{message}</p> : null}
    {state ? <>
      <p>考试编号：<strong>{state.examCode}</strong>　当前角色：{state.role === 'HUB' ? '公网汇总' : state.role === 'EDGE' ? '内网节点' : '尚未配置'}　同步：{state.enabled ? '已开启' : '已关闭'}</p>
      <p>本机提交 {state.local} 条，接收提交 {state.imported} 条，待整理更新 {state.queued} 条{state.role === 'EDGE' ? `，待推送 ${state.pendingPush} 条` : ''}。最近同步：{state.lastSuccessAt ? new Date(state.lastSuccessAt).toLocaleString('zh-CN') : '暂无'}。</p>
      <p>公告答疑最近同步：{state.communicationSuccessAt ? new Date(state.communicationSuccessAt).toLocaleString('zh-CN') : '暂无'}。两端均可回复，图片会一并同步。</p>
      {state.communicationError ? <div role="alert" className="exam-editor-error">{state.communicationError}</div> : null}
      {state.lastError ? <div role="alert" className="exam-editor-error">{state.lastError}</div> : null}
      {!state.role || state.role === 'HUB' ? <div className="grid" style={{ gap: 12 }}>
        <h3 style={{ margin: 0 }}>在公网服务器设置</h3>
        <p style={{ margin: 0 }}>生成此考试专用的同步密钥，并将密钥填写到内网。重新生成后，所有内网节点需要更新密钥。生成时会开启公网接收。</p>
        <button className="button" disabled={busy} onClick={() => void save('hub-key')}>{state.hasKey ? '重新生成同步密钥' : '生成同步密钥并开启接收'}</button>
        {issuedKey ? <label>本次生成的密钥（仅显示本次，请及时保存）<input readOnly value={issuedKey} onFocus={event => event.target.select()} autoComplete="off" /></label> : null}
      </div> : null}
      {!state.role || state.role === 'EDGE' ? <div className="grid" style={{ gap: 12 }}>
        <h3 style={{ margin: 0 }}>在内网服务器设置</h3>
        <label>公网系统地址<input type="url" value={baseUrl} placeholder="https://proctoring.example.com" onChange={event => setBaseUrl(event.target.value)} /></label>
        <label>公网考试编号<input value={code} inputMode="numeric" maxLength={10} onChange={event => setCode(event.target.value)} /></label>
        <label>此考试的同步密钥<input type="password" value={key} autoComplete="new-password" placeholder={state.hasKey ? '留空保留已保存的密钥' : '粘贴公网生成的密钥'} onChange={event => setKey(event.target.value)} /></label>
        <p style={{ margin: 0 }}>开启后会推送本机提交，同时拉取公网合并记录。若本地编号不同，仅在尚无提交或登录会话时可自动对齐。断网时保留进度，恢复后自动补齐。</p>
        <div className="exam-list-actions" style={{ flexWrap: 'wrap' }}><button className="button secondary" disabled={busy} onClick={() => void save('check')}>检查两端一致性</button><button className="button" disabled={busy} onClick={() => void save('edge-connect')}>保存并开启双向同步</button></div>
      </div> : null}
      {state.role ? <div className="exam-list-actions" style={{ flexWrap: 'wrap' }}><button className="button secondary" disabled={busy} onClick={() => void save(state.enabled ? 'pause' : 'resume')}>{state.enabled ? '暂停同步' : '恢复同步'}</button><button className="button secondary" disabled={busy || !state.enabled} onClick={() => void save('retry')}>立即重试</button></div> : null}
      <p style={{ margin: 0 }}>两端都可以手动重测已同步的代码、取消成绩或人工评分，调用操作服务器自己的判题服务，结果再同步到其他节点。收到记录时不会自动重复判题。双方离线同时修改时按版本及节点标识确定一致结果。暂停同步不会删除已有记录。</p>
    </> : <p>正在读取同步设置…</p>}
  </section>;
}
