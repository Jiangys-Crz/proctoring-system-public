'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CalendarClock, Check, ImagePlus, LoaderCircle, Monitor, Play, RefreshCw, Save, Square, Trash2, Type, Upload, X } from 'lucide-react';
import { api } from './api';
import { datetimeLocalToIso } from '@/lib/datetime-local';
import { ScreenControlTemplateEditor, type ScreenTemplateGroup, type ScreenTemplateImage } from './ScreenControlTemplateEditor';
import './ExamScreenControlPanel.css';

type ImageItem = ScreenTemplateImage;
type ImageGroup = ScreenTemplateGroup & { createdAt: string };
type Display = { id: string; groupId: string; groupName: string; startsAt: string; endsAt: string | null; stoppedAt: string | null; canceledAt: string | null; images: ImageItem[]; intervalMs: number };
type ScreenState = { serverNow: string; current: Display | null; groups: ImageGroup[]; schedules: Display[]; history: Display[] };

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '管理员手动关闭';
}

export function ExamScreenControlPanel({ examId }: { examId: string }) {
  const base = `/api/exams/${examId}/screen-control`;
  const [data, setData] = useState<ScreenState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const actionBusy = useRef(false);
  const readGeneration = useRef(0);
  const [uploadName, setUploadName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [editingGroupId, setEditingGroupId] = useState('');
  const [editingName, setEditingName] = useState('');
  const [editingImages, setEditingImages] = useState<ImageItem[]>([]);
  const [mode, setMode] = useState<'now' | 'scheduled'>('now');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [templateEditor, setTemplateEditor] = useState<{ group: ImageGroup; imageId?: string; readOnly: boolean } | null>(null);

  const load = useCallback(async () => {
    const generation = ++readGeneration.current;
    const next = await api<ScreenState>(base, { cache: 'no-store' });
    if (generation !== readGeneration.current) return;
    setData(next);
    setSelectedGroupId(current => next.groups.some(group => group.id === current) ? current : next.groups[0]?.id || '');
  }, [base]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => { if (!actionBusy.current) void load().catch(err => { if (!disposed) setError(err instanceof Error ? err.message : '屏幕控制加载失败'); }); };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { disposed = true; readGeneration.current++; window.clearInterval(timer); };
  }, [load]);

  async function act(key: string, operation: () => Promise<unknown>, success: string) {
    if (actionBusy.current) return;
    actionBusy.current = true;
    readGeneration.current++;
    setBusy(key); setError(''); setNotice('');
    try { await operation(); await load(); setNotice(success); }
    catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(''); actionBusy.current = false; }
  }

  async function uploadGroup() {
    if (!uploadName.trim() || !files.length) { setError('请填写组名并选择至少一张图片'); return; }
    if (files.length > 30 || files.some(file => file.size <= 0 || file.size > 10 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 80 * 1024 * 1024) { setError('每组最多 30 张图片，单张不超过 10MB，总大小不超过 80MB'); return; }
    const form = new FormData();
    form.append('name', uploadName.trim());
    files.forEach(file => form.append('files', file));
    await act('upload', async () => {
      const group = await api<ImageGroup>(`${base}/groups`, { method: 'POST', body: form });
      setSelectedGroupId(group.id); setUploadName(''); setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
    }, '图片组已保存，可以立即推送或设置定时展示');
  }

  function moveImage(index: number, delta: number) {
    setEditingImages(current => {
      const next = [...current];
      const destination = index + delta;
      if (destination < 0 || destination >= next.length) return current;
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  async function pushDisplay() {
    if (!selectedGroupId) { setError('请先上传并选择图片组'); return; }
    const start = mode === 'scheduled' ? datetimeLocalToIso(startsAt) : undefined;
    const end = endsAt ? datetimeLocalToIso(endsAt) : null;
    const now = data ? new Date(data.serverNow).getTime() : Date.now();
    if (mode === 'scheduled' && (!start || !Number.isFinite(Date.parse(start)) || Date.parse(start) <= now)) { setError('定时展示的开始时间必须晚于当前时间'); return; }
    if (end && (!Number.isFinite(Date.parse(end)) || Date.parse(end) <= (start ? Date.parse(start) : now))) { setError('截止时间必须晚于展示开始时间'); return; }
    await act('push', () => api(base, { method: 'POST', body: JSON.stringify({ groupId: selectedGroupId, ...(start ? { startsAt: start } : {}), endsAt: end }) }), mode === 'scheduled' ? '定时展示已保存，届时客户端会自动全屏展示' : '已推送，已登录和后续登录的客户端将自动全屏展示');
  }

  const selectedGroup = data?.groups.find(group => group.id === selectedGroupId);
  const isReferenced = (id: string) => data?.current?.groupId === id || data?.schedules.some(item => item.groupId === id);

  function openPreview(image: ImageItem) {
    const group = data?.groups.find(item => item.images.some(entry => entry.id === image.id));
    if (group) setTemplateEditor({ group, imageId: image.id, readOnly: true });
  }

  return <div className="screen-control-panel">
    <section className={`card screen-control-status ${data?.current ? 'showing' : ''}`}>
      <div className="screen-control-heading"><div><span className="screen-control-eyebrow">屏幕控制</span><h2><Monitor size={22} />{data?.current ? `正在展示 · ${data.current.groupName}` : '当前无图片展示'}</h2><p>面向本场考试所有桌面客户端，每张图片全屏展示 5 秒并循环播放。</p></div>
        {data?.current ? <button className="button danger" disabled={!!busy} onClick={() => void act('stop', () => api(base, { method: 'PATCH', body: JSON.stringify({ action: 'STOP', displayId: data.current!.id }) }), '当前展示已关闭，客户端将恢复原界面')}><Square size={16} />{busy === 'stop' ? '关闭中…' : '关闭当前展示'}</button> : <button className="button secondary" disabled={!!busy} onClick={() => void act('refresh', load, '已刷新')}><RefreshCw size={16} />刷新</button>}
      </div>
      {data?.current ? <div className="screen-control-status-facts"><span>开始：{dateTime(data.current.startsAt)}</span><span>截止：{dateTime(data.current.endsAt)}</span><span>{data.current.images.length} 张图片 · 5 秒 / 张</span></div> : null}
    </section>

    {error ? <div role="alert" className="screen-control-message error">{error}</div> : null}
    {notice ? <div role="status" className="screen-control-message"><Check size={17} />{notice}</div> : null}
    {!data ? <div className="card"><LoaderCircle size={18} className="spin" /> 正在加载屏幕控制…</div> : <>
      <section className="card screen-control-compose">
        <div className="screen-control-section-heading"><h3><Play size={19} />推送展示</h3><span>开赛前、比赛中及结束后均可操作</span></div>
        <div className="screen-control-form-grid">
          <label>图片组<select value={selectedGroupId} onChange={event => setSelectedGroupId(event.target.value)} disabled={!!busy}><option value="" disabled>请选择图片组</option>{data.groups.map(group => <option value={group.id} key={group.id}>{group.name}（{group.images.length} 张）</option>)}</select></label>
          <label>展示方式<select value={mode} onChange={event => setMode(event.target.value as typeof mode)} disabled={!!busy}><option value="now">立即推送</option><option value="scheduled">定时展示</option></select></label>
          {mode === 'scheduled' ? <label>开始时间<input type="datetime-local" value={startsAt} onChange={event => setStartsAt(event.target.value)} disabled={!!busy} /></label> : null}
          <label>截止时间（可选）<input type="datetime-local" value={endsAt} onChange={event => setEndsAt(event.target.value)} disabled={!!busy} /></label>
        </div>
        {selectedGroup ? <div className="screen-control-preview-strip">{selectedGroup.images.map((item, index) => <button type="button" title={`预览 ${item.name}`} key={item.id} onClick={() => openPreview(item)}><img src={item.url} alt={item.name} /><span>{index + 1}</span></button>)}</div> : null}
        <div className="screen-control-submit"><p>留空截止时间时持续轮播，直到管理员关闭。新展示开始时替换当前展示，结束后恢复客户端原界面。</p><button className="button" disabled={!!busy || !selectedGroup} onClick={() => void pushDisplay()}>{busy === 'push' ? <LoaderCircle size={17} className="spin" /> : mode === 'scheduled' ? <CalendarClock size={17} /> : <Play size={17} />}{busy === 'push' ? '提交中…' : mode === 'scheduled' ? '保存定时展示' : '立即推送'}</button></div>
      </section>

      <section className="card screen-control-upload">
        <div className="screen-control-section-heading"><h3><ImagePlus size={19} />上传图片组</h3><span>每组最多 30 张 · 单张 10MB · 共 80MB</span></div>
        <div className="screen-control-form-grid"><label>组名<input maxLength={100} value={uploadName} onChange={event => setUploadName(event.target.value)} placeholder="例如：比赛规则、开赛须知" disabled={!!busy} /></label><label>选择多张图片<input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" disabled={!!busy} onChange={event => setFiles(Array.from(event.target.files || []))} /></label></div>
        {files.length ? <div className="screen-control-file-list">{files.map((file, index) => <span key={`${index}-${file.name}`}>{index + 1}. {file.name}<button type="button" aria-label={`移除 ${file.name}`} disabled={!!busy} onClick={() => setFiles(items => items.filter((_, i) => i !== index))}><X size={13} /></button></span>)}</div> : null}
        <div className="screen-control-submit"><p>支持 PNG、JPEG、WebP、GIF（取首帧）。可以保存多个图片组，推送时一次选择一组。</p><button className="button" disabled={!!busy || !files.length || !uploadName.trim()} onClick={() => void uploadGroup()}>{busy === 'upload' ? <LoaderCircle size={17} className="spin" /> : <Upload size={17} />}{busy === 'upload' ? '上传中…' : '保存图片组'}</button></div>
      </section>

      <section className="card screen-control-groups"><div className="screen-control-section-heading"><h3>图片组</h3><span>{data.groups.length} 组</span></div>
        {!data.groups.length ? <div className="screen-control-empty">上传第一组图片后即可推送展示。</div> : data.groups.map(group => <article className="screen-control-group" key={group.id}>
          <header><div><strong>{group.name}</strong><span>{group.images.length} 张图片{group.images.some(item => item.template?.blocks.length) ? ` · ${group.images.filter(item => item.template?.blocks.length).length} 张已设置考生信息` : ''}{isReferenced(group.id) ? ' · 已用于展示或定时计划' : ''}</span></div><div className="screen-control-row-actions"><button className="button secondary compact-button" disabled={!!busy || !!isReferenced(group.id)} onClick={() => setTemplateEditor({ group, readOnly: false })}><Type size={15} />添加考生信息</button><button className="button secondary compact-button" disabled={!!busy} onClick={() => setSelectedGroupId(group.id)}>选择推送</button><button className="button secondary compact-button" disabled={!!busy || !!isReferenced(group.id)} onClick={() => { setEditingGroupId(group.id); setEditingName(group.name); setEditingImages(group.images); }}>编辑</button><button className="button danger compact-button" disabled={!!busy || !!isReferenced(group.id)} onClick={() => void act(`delete-${group.id}`, () => api(`${base}/groups/${group.id}`, { method: 'DELETE' }), '图片组已删除')} aria-label={`删除 ${group.name}`}><Trash2 size={15} /></button></div></header>
          {editingGroupId === group.id ? <div className="screen-control-group-edit"><label>组名<input value={editingName} maxLength={100} onChange={event => setEditingName(event.target.value)} disabled={!!busy} /></label><div className="screen-control-edit-images">{editingImages.map((item, index) => <div key={item.id}><button className="screen-control-edit-preview" onClick={() => openPreview(item)}><img src={item.url} alt={item.name} /></button><span>{index + 1}. {item.name}</span><button type="button" disabled={!!busy || index === 0} aria-label={`向前移动 ${item.name}`} onClick={() => moveImage(index, -1)}><ArrowUp size={15} /></button><button type="button" disabled={!!busy || index === editingImages.length - 1} aria-label={`向后移动 ${item.name}`} onClick={() => moveImage(index, 1)}><ArrowDown size={15} /></button></div>)}</div><div className="screen-control-row-actions"><button className="button secondary compact-button" disabled={!!busy} onClick={() => setEditingGroupId('')}>取消</button><button className="button compact-button" disabled={!!busy || !editingName.trim()} onClick={() => void act(`edit-${group.id}`, async () => { await api(`${base}/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ name: editingName.trim(), imageIds: editingImages.map(item => item.id) }) }); setEditingGroupId(''); }, '图片组已更新')}><Save size={15} />保存</button></div></div> : <div className="screen-control-preview-strip">{group.images.map((item, index) => <button type="button" title={`预览 ${item.name}`} key={item.id} onClick={() => openPreview(item)}><img src={item.url} alt={item.name} loading="lazy" /><span>{index + 1}</span></button>)}</div>}
        </article>)}
      </section>

      <section className="card"><div className="screen-control-section-heading"><h3><CalendarClock size={19} />定时展示</h3><span>{data.schedules.length} 个计划</span></div><div className="screen-control-list">{data.schedules.map(item => <article key={item.id}><div><strong>{item.groupName}</strong><span>开始：{dateTime(item.startsAt)}<br />截止：{dateTime(item.endsAt)}</span></div><button className="button secondary compact-button" disabled={!!busy} onClick={() => void act(`cancel-${item.id}`, () => api(base, { method: 'PATCH', body: JSON.stringify({ action: 'CANCEL', displayId: item.id }) }), '定时展示已取消')}>取消计划</button></article>)}</div>{!data.schedules.length ? <div className="screen-control-empty">暂无待执行的定时展示</div> : null}</section>
      <section className="card"><div className="screen-control-section-heading"><h3>展示记录</h3><span>最近的推送与定时展示</span></div><div className="screen-control-list">{data.history.map(item => <article key={item.id}><div><strong>{item.groupName}</strong><span>{dateTime(item.startsAt)} → {item.stoppedAt ? dateTime(item.stoppedAt) : dateTime(item.endsAt)}</span></div><span className="muted">{data.current?.id === item.id ? '正在展示' : data.schedules.some(schedule => schedule.id === item.id) ? '待展示' : item.canceledAt ? '已取消' : item.stoppedAt ? '已关闭' : '已结束'}</span></article>)}</div>{!data.history.length ? <div className="screen-control-empty">暂无展示记录</div> : null}</section>
    </>}
    {templateEditor ? <ScreenControlTemplateEditor examId={examId} group={templateEditor.group} initialImageId={templateEditor.imageId} readOnly={templateEditor.readOnly}
      onClose={() => setTemplateEditor(null)} onSaved={async () => { await load(); setNotice('考生信息模板已保存，推送时将自动生成各考生对应的图片'); }} /> : null}
  </div>;
}
