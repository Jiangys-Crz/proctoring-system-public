'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Film, LoaderCircle, RefreshCw, Save, X } from 'lucide-react';
import { api } from './api';
import type { ReactionAdminView, ReactionConfigView, ReactionExportSummary, ReactionItemView, ReactionPresentationView } from './reaction-types';
import styles from './ReactionAdmin.module.css';
import { ReactionAppearancePreview } from './ReactionAppearancePreview';
import { ReactionCcsSetupHelp } from './ReactionCcsSetupHelp';
import { canGenerateReaction, reactionExportBlockReason, reactionSubmissionLabel } from './reaction-generation-ui';

const defaults: ReactionConfigView = { enabled: false, bufferSeconds: 60, beforeSeconds: 3, afterSeconds: 10, maxPendingSeconds: 1800, maxStorageBytes: 20 * 1024 ** 3, retentionDays: 30, autoGenerate: false, uploadGraceSeconds: 30, presentation: { version: 1, fontPreset: 'broadcast', teamLogos: [], schoolLogos: [] } };
const editableConfig = ({ credentialsConfigured: _configured, ...config }: ReactionAdminView['config']): ReactionConfigView => config;
const statusNames: Record<string, string> = { PENDING: '等待判题', TAIL: '录制判题后画面', CAPTURING: '正在裁剪', UNMAPPED: '队伍未映射', RECORDING: '录制中', WAITING: '等待片段', FINALIZING: '正在裁剪', PROCESSING: '正在处理', COMPLETE: '完整保存', COMPLETED: '完整保存', PARTIAL: '录像不完整', MISSING: '缺失录像', FAILED: '失败', TIMEOUT: '判题超时', TIMED_OUT: '判题超时', DELETED: '提交已删除', CANCELLED: '已取消', EXPIRED: '已到保留期限' };
const feedNames: Record<string, string> = { STOPPED: '已停止', CONNECTING: '连接中', INITIALIZING: '初始化历史记录', CONNECTED: '已连接', RECONNECTING: '正在重连', ERROR: '连接异常', DISCONNECTED: '已断开' };
const generationNames: Record<string, string> = { IDLE: '未生成', QUEUED: '等待生成', RUNNING: '生成中', GENERATING: '生成中', COMPLETE: '已生成', COMPLETED: '已生成', FAILED: '生成失败' };
const reasonNames: Record<string, string> = {
  CAPTURE_FAILED_CHECK_MEDIA_INPUTS: '录像裁剪失败，请检查输入视频与媒体处理服务',
  CCS_DISCONNECTED_OR_INVALID_EVENT: 'CCS 连接中断或事件格式无效，正在重试',
  JUDGEMENT_TIMEOUT: '超过最长待判时间',
  VIDEO_FRAME_CADENCE_INCOMPLETE: '采集帧间隔过长，可能受到客户端后台节流影响；已保留可用录像',
  VIDEO_FRAME_TIMING_UNVERIFIED: '无法验证原始视频的逐帧时间戳；已保留可用录像',
  VIDEO_DURATION_MISMATCH: '视频实际时长与采集时间记录不一致，无法确认录像区间完整',
  VIDEO_CLOCK_UNCERTAIN: '采集时钟未能可靠同步，无法确认两路视频的时间对应关系',
  VIDEO_INTERVAL_MISSING: '所需时间区间内有录像缺失，无法生成完整 Reaction',
  VIDEO_SOURCE_UNAVAILABLE: '原始录像无法读取或解码，请检查录像文件与存储服务',
  VIDEO_COVERAGE_OR_CLOCK_INCOMPLETE: '录像区间缺失或采集时钟未能可靠同步',
  TEAM_USERNAME_NOT_MAPPED: '未找到与队伍 username 完全匹配的监考考号',
  SUBMISSION_DELETED: 'NovaJudge 已删除这次提交',
  SUBMISSION_IDENTITY_CHANGED: '提交对应的队伍或题目发生变化',
  REACTION_DISABLED: 'Reaction 已关闭，当前录像已取消'
};
const ccsErrorNames: Record<string, string> = {
  CCS_HTTP_401: 'NovaJudge CCS 登录失败（401）：请检查服务端全局管理员账号、密码和单考试覆盖配置。不是比赛尚未开始；参见上方“CCS 授权在哪里填写”。',
  CCS_HTTP_403: 'NovaJudge CCS 拒绝访问（403）：请检查账号权限及代理访问规则。',
  CCS_HTTP_404: 'NovaJudge CCS 地址或比赛不存在（404）：请核对平台地址和 NovaJudge 比赛 ID。'
};
const reasonText = (value: string) => ccsErrorNames[value] || reasonNames[value] || value;
const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const megabytes = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MiB`;
type VideoKind = 'camera' | 'desktop' | 'reaction';
const kindNames: Record<VideoKind, string> = { camera: 'Camera', desktop: 'Desktop', reaction: 'Reaction' };

export function ReactionAdminClient({ examId }: { examId: string }) {
  const [data, setData] = useState<ReactionAdminView | null>(null);
  const [draft, setDraft] = useState(defaults);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<{ item: ReactionItemView; kind: VideoKind } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [customBackground, setCustomBackground] = useState<string>();
  const dirty = useRef(false), saving = useRef(false), revision = useRef(0);
  const exportingRef = useRef(false);
  const exportCooldown = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endpoint = `/api/exams/${encodeURIComponent(examId)}/reactions`;
  const fileUrl = (id: string, kind: string, download = false) => `${endpoint}/${encodeURIComponent(id)}/files/${kind}${download ? '?download=1' : ''}`;
  const assetUrl = (value: string) => `${endpoint}/assets?asset=${encodeURIComponent(value.split('/').at(-1) || '')}`;
  const exportBlockReason = reactionExportBlockReason(data?.exportSummary);
  const previewItem = preview ? data?.items.find(item => item.id === preview.item.id) || preview.item : null;
  useEffect(() => () => { if (exportCooldown.current) clearTimeout(exportCooldown.current); }, []);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      const version = revision.current;
      try {
        if (!saving.current) {
          const result = await api<ReactionAdminView>(endpoint, { signal: abort.signal, cache: 'no-store' });
          if (abort.signal.aborted || version !== revision.current) return;
          setData(result);
          if (!dirty.current) {
            setDraft(editableConfig(result.config));
            if (result.config.presentation.backgroundPath) setCustomBackground(result.config.presentation.backgroundPath);
          }
          setError('');
        }
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Reaction 状态加载失败');
      } finally { if (!abort.signal.aborted) timer = setTimeout(() => void load(), 5000); }
    }
    void load();
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [endpoint, refresh]);

  function edit(patch: Partial<ReactionConfigView>) { dirty.current = true; setDraft(value => ({ ...value, ...patch })); setMessage(''); }
  function editPresentation(patch: Partial<ReactionPresentationView>) {
    dirty.current = true; setDraft(value => ({ ...value, presentation: { ...value.presentation, ...patch } })); setMessage('');
  }

  async function uploadAsset(file: File | undefined) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4 * 1024 ** 2) { setError('请选择不超过 4 MiB 的 PNG、JPEG 或 WebP 图片'); return; }
    saving.current = true; revision.current++; setBusy(true); setError(''); setMessage('');
    try {
      const body = new FormData(); body.set('file', file); body.set('kind', 'background');
      const result = await api<{ path: string }>(`${endpoint}/assets`, { method: 'POST', body });
      dirty.current = true;
      setCustomBackground(result.path);
      setDraft(value => ({ ...value, presentation: { ...value.presentation, backgroundPath: result.path } }));
      setMessage('素材已上传，请保存视频外观设置，再生成或重新生成视频。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '素材上传失败'); }
    finally { saving.current = false; setBusy(false); }
  }

  async function save() {
    saving.current = true; revision.current++; setBusy(true); setError(''); setMessage('');
    try {
      await api(endpoint, { method: 'PATCH', body: JSON.stringify(draft) });
      dirty.current = false; setMessage('Reaction 配置已保存'); setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '配置保存失败'); }
    finally { saving.current = false; setBusy(false); }
  }

  async function generate(ids?: string[]) {
    if (dirty.current) { setError('请先保存配置和视频外观，再生成视频。'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<{ queued: number }>(`${endpoint}/generate`, { method: 'POST', body: JSON.stringify({ reactionIds: ids }) });
      setMessage(result.queued ? `已将 ${result.queued} 段录像加入生成队列，完成后可预览和下载` : '暂无可加入生成队列的录像，请确认桌面录像已保存，且没有正在生成的任务'); setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '生成任务提交失败'); }
    finally { setBusy(false); }
  }

  async function exportVideos() {
    if (busy || exportingRef.current) return;
    if (exportBlockReason) { setError(exportBlockReason); return; }
    exportingRef.current = true; setExporting(true); setError(''); setMessage('');
    let downloadStarted = false;
    try {
      const summary = await api<ReactionExportSummary>(`${endpoint}/export?check=1`, { cache: 'no-store', timeoutMs: 600_000 });
      const reason = reactionExportBlockReason(summary);
      if (reason) { setRefresh(value => value + 1); throw new Error(reason); }
      const link = document.createElement('a');
      link.href = `${endpoint}/export`;
      link.download = '';
      link.hidden = true;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
      downloadStarted = true;
      setMessage(`已开始下载本场 ${summary.generatedCount} 个竖屏视频，请在浏览器下载列表查看进度。`);
      exportCooldown.current = setTimeout(() => { exportingRef.current = false; setExporting(false); exportCooldown.current = null; }, 2000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '视频导出失败，请稍后重试'); }
    finally { if (!downloadStarted) { exportingRef.current = false; setExporting(false); } }
  }

  const field = (key: 'bufferSeconds' | 'beforeSeconds' | 'afterSeconds' | 'maxPendingSeconds' | 'retentionDays', label: string, min: number, max: number) => <label>{label}<input type="number" required min={min} max={max} step={1} value={draft[key]} onChange={event => edit({ [key]: Number(event.target.value) })} /></label>;

  return <div className="exam-workspace-page">
    <header className="exam-workspace-header">
      <div className="return-only-row"><Link className="exam-back" href={`/dashboard/exams/${examId}`}><ArrowLeft size={18} /> 返回比赛详情</Link></div>
      <div className="exam-workspace-title-row"><h1>Reaction 录像</h1><span>{data?.exam.name}</span></div>
    </header>
    <main className={styles.content}>
      {error ? <div className="exam-editor-error" role="alert">{error}</div> : null}
      {message ? <div className={styles.message} role="status">{message}</div> : null}
      <section className="card grid">
        <div className={styles.heading}><div><h2>自动保存提交 Reaction</h2><p className="muted">复用电脑摄像头和屏幕录像。提交后保留判题等待期间的画面，并在结果出现后继续录制。</p></div><button className="button secondary" onClick={() => setRefresh(value => value + 1)} disabled={busy}><RefreshCw size={17} />刷新状态</button></div>
        <form className="form" onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={!data || busy} className="form" style={{ border: 0, margin: 0, padding: 0 }}>
            <label className={styles.check}><input type="checkbox" checked={draft.enabled} onChange={event => edit({ enabled: event.target.checked })} />开启本场考试 Reaction</label>
            <div className={styles.config}>
              {field('bufferSeconds', '滚动缓存（秒）', 10, 600)}
              {field('beforeSeconds', '提交前保留（秒）', 0, 60)}
              {field('afterSeconds', '判题结果后保留（秒）', 0, 120)}
              {field('maxPendingSeconds', '最长等待判题（秒）', 30, 86400)}
              <label>本场存储上限（GiB）<input type="number" required min={0.1} max={10000} step={0.1} value={Number((draft.maxStorageBytes / 1024 ** 3).toFixed(2))} onChange={event => edit({ maxStorageBytes: Math.round(Number(event.target.value) * 1024 ** 3) })} /></label>
              {field('retentionDays', '录像保存天数', 1, 3650)}
            </div>
            <label className={styles.check}><input type="checkbox" checked={draft.autoGenerate} onChange={event => edit({ autoGenerate: event.target.checked })} />自动生成竖屏视频（默认关闭）</label>
            <p className="muted">比赛期间建议仅保存原始录像，赛后再生成竖屏视频。滚动缓存长度不限制已触发提交的录像时长。</p>
            <div><button className="button" type="submit">{busy ? <LoaderCircle size={17} className="spin" /> : <Save size={17} />}保存配置</button></div>
          </fieldset>
        </form>
        {data && !data.config.credentialsConfigured ? <p className={styles.warning}>CCS 服务端授权尚未配置，或平台地址不匹配。请展开下方“CCS 授权在哪里填写”，由部署管理员完成配置。</p> : null}
        <ReactionCcsSetupHelp />
      </section>
      <section className="card grid" aria-label="视频外观设置">
        <div className={styles.heading}><div><h2>视频外观</h2><p className="muted">选择背景和字体，预览竖屏排版。保存后用于新生成的视频，已有视频可点击“重新生成”应用设置。</p></div></div>
        <fieldset disabled={!data || busy} className={'form ' + styles.appearanceFields}>
          <div className={styles.appearanceGrid}>
            <div className={styles.assetCard}>
              <h3>背景与字体</h3>
              <label>背景来源<select aria-label="背景来源" value={draft.presentation.backgroundPath ? 'custom' : 'default'} onChange={event => editPresentation({ backgroundPath: event.target.value === 'custom' ? customBackground : undefined })}><option value="default">内置比赛背景</option><option value="custom" disabled={!customBackground}>自定义背景（上传后选用）</option></select></label>
              <label>上传背景图片<input aria-label="上传背景图片" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void uploadAsset(event.target.files?.[0]); event.target.value = ''; }} /></label>
              <p className="muted">推荐 <strong>1080 × 1920 像素（9:16）</strong>。支持静态 PNG、JPEG、WebP，单张不超过 <strong>4 MiB</strong>，最多 1600 万像素、单边不超过 8192 像素。</p>
              <p className="muted">其他比例会等比放大并居中裁切。摄像头、信息卡和桌面会覆盖背景的中部，请把背景标题或装饰放在顶部、底部及边缘，先用右侧预览检查。</p>
              <label>字体风格<select aria-label="字体风格" value={draft.presentation.fontPreset} onChange={event => editPresentation({ fontPreset: event.target.value as ReactionPresentationView['fontPreset'] })}><option value="broadcast">比赛播报</option><option value="classic">经典风格</option></select></label>
              <p className="muted">组织徽章由系统按队伍的学校/组织自动匹配，未匹配时使用系统默认徽章。由超级管理员在系统设置维护。</p>
              <div><button className="button" type="button" onClick={() => void save()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Save size={17} />}保存视频外观</button></div>
            </div>
            <ReactionAppearancePreview endpoint={endpoint} backgroundUrl={draft.presentation.backgroundPath ? assetUrl(draft.presentation.backgroundPath) : undefined} fontPreset={draft.presentation.fontPreset} candidates={data?.candidates || []} refresh={refresh} />
          </div>
        </fieldset>
      </section>
      <section className="card" aria-label="Reaction 运行状态">
        <div className={styles.heading}><h2>运行状态</h2><span>{data ? feedNames[data.health.feedStatus] || data.health.feedStatus : '正在加载…'}</span></div>
        <dl className={styles.metrics}>
          <div className={styles.metric}><dt>活跃视频源</dt><dd>{data?.health.connectedSources ?? '—'}</dd></div>
          <div className={styles.metric}><dt>已处理提交</dt><dd>{data?.health.processedSubmissions ?? '—'}</dd></div>
          <div className={styles.metric}><dt>已保存视频</dt><dd>{data?.health.savedVideos ?? '—'}</dd></div>
          <div className={styles.metric}><dt>失败或缺失</dt><dd>{data?.health.missingOrFailed ?? '—'}</dd></div>
        </dl>
        <p className="muted">缓存：{data ? `${data.health.bufferSegments} 个片段 · ${megabytes(data.health.bufferBytes)}` : '—'}。最近事件：{data?.health.lastEventAt ? dateTime(data.health.lastEventAt) : '暂无'}。状态每 5 秒更新。</p>
        {data?.health.lastError ? <p className={styles.warning} role="status">{reasonText(data.health.lastError)}</p> : null}
      </section>
      {preview ? <section className={`card ${styles.preview}`} aria-label="录像预览">
        <div className={styles.heading}><h2>{kindNames[preview.kind]} · Submission {reactionSubmissionLabel(previewItem!)}</h2><button className="button secondary" onClick={() => { setPreview(null); setPreviewError(''); }}><X size={17} />关闭预览</button></div>
        <video key={`${preview.item.id}:${preview.kind}`} controls playsInline preload="metadata" src={fileUrl(preview.item.id, preview.kind)} onError={() => setPreviewError('视频暂时无法播放，请刷新状态或下载后检查。')} />
        {previewError ? <p role="alert" className={styles.warning}>{previewError}</p> : null}
        <div><a className="button secondary" href={fileUrl(preview.item.id, preview.kind, true)}><Download size={16} />下载 {kindNames[preview.kind]}</a></div>
      </section> : null}
      <section className="card grid">
        <div className={styles.heading}><h2>Submission 录像</h2><div className={styles.toolbar}>
          <button className="button" disabled={busy || exporting || !data?.items.some(canGenerateReaction)} onClick={() => void generate()}><Film size={17} />批量生成竖屏视频</button>
          <button className="button secondary" disabled={busy || exporting || Boolean(exportBlockReason)} onClick={() => void exportVideos()}>{exporting ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}{exporting ? '正在准备下载…' : '批量导出 MP4（ZIP）'}</button>
        </div></div>
        <p className="muted">不完整录像只要有桌面画面，也可以生成竖屏。缺少摄像头录像时，摄像头区域使用占位模板；两路都有时，按较短的有效时长结束。成片可能缺少画面，原录像仍标记为“不完整”。</p>
        <p className={data?.exportSummary?.invalidSubmissionIds ? styles.warning : 'muted'} role={data?.exportSummary?.invalidSubmissionIds ? 'status' : undefined}>{exportBlockReason || `导出本场全部 ${data?.exportSummary?.generatedCount} 个已生成竖屏视频，文件名使用 Submission UUID。`}</p>
        <div className="table-scroll"><table className={`table ${styles.table}`}><thead><tr><th>Submission</th><th>Team</th><th>Problem</th><th>Verdict</th><th>Duration</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          {data?.items.map(item => <tr key={item.id}>
            <td>{reactionSubmissionLabel(item)}<small className={styles.small}>{dateTime(item.createdAt)}</small></td>
            <td>{item.teamName}<small className={styles.small}>{item.teamId}</small></td>
            <td>{item.problemLabel || item.problemId}</td><td>{item.verdict || '—'}{item.originalVerdict && item.originalVerdict !== item.verdict ? <small className={styles.small}>原录像：{item.originalVerdict}（已重判）</small> : null}</td><td>{item.durationSeconds == null ? '—' : `${item.durationSeconds.toFixed(2)} s`}</td>
            <td>{statusNames[item.status] || item.status}<small className={styles.small}>{generationNames[item.generationStatus] || item.generationStatus}</small>{item.reason || item.generationError ? <small className={styles.small}>{reasonText(item.reason || item.generationError!)}</small> : null}</td>
            <td><div className={styles.actions}>{(['camera', 'desktop', 'reaction'] as const).map(kind => item[`${kind}Path`] ? <button className="button secondary" key={kind} onClick={() => { setPreview({ item, kind }); setPreviewError(''); }}>{kindNames[kind]} 预览</button> : null)}
              <button className="button secondary" disabled={busy || !canGenerateReaction(item)} onClick={() => void generate([item.id])}>{item.reactionPath ? '重新生成' : '生成竖屏'}{item.status === 'PARTIAL' ? '（部分录像）' : ''}</button>
              {item.metadataPath ? <a href={fileUrl(item.id, 'metadata', true)}>metadata.json</a> : null}</div></td>
          </tr>)}
          {!data?.items.length ? <tr><td colSpan={7} className={styles.empty}>{data ? '暂无 Reaction。开启功能并连接监考客户端后，新提交会自动出现在这里。' : '正在加载 Reaction…'}</td></tr> : null}
        </tbody></table></div>
      </section>
    </main>
  </div>;
}
