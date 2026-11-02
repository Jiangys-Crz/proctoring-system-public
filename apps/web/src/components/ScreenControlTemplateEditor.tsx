'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Eye, LoaderCircle, Plus, Save, Trash2, X } from 'lucide-react';
import { api } from './api';
import { screenTemplateFields, type ScreenImageTemplate, type ScreenTextBlock } from '@/lib/screen-control-template';
import './ScreenControlTemplateEditor.css';

export type ScreenTemplateImage = {
  id: string; name: string; url: string; order: number; width: number; height: number; template: ScreenImageTemplate | null;
};
export type ScreenTemplateGroup = { id: string; name: string; images: ScreenTemplateImage[]; updatedAt: string };
type CandidateOption = { id: string; name: string | null; teamName: string | null; examNumber: string };
type TemplateData = { contestType: 'INDIVIDUAL' | 'TEAM'; candidates: CandidateOption[] };

export function ScreenControlTemplateEditor({ examId, group, initialImageId, readOnly = false, onClose, onSaved }: {
  examId: string; group: ScreenTemplateGroup; initialImageId?: string; readOnly?: boolean;
  onClose: () => void; onSaved: () => Promise<void>;
}) {
  const base = `/api/exams/${examId}/screen-control`;
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [imageId, setImageId] = useState(initialImageId || group.images[0].id);
  const [drafts, setDrafts] = useState<Record<string, ScreenImageTemplate | null>>(() => Object.fromEntries(group.images.map(image => [image.id, image.template])));
  const [selectedId, setSelectedId] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [context, setContext] = useState<TemplateData | null>(null);
  const [search, setSearch] = useState('');
  const [candidate, setCandidate] = useState<CandidateOption | null>(null);
  const [preview, setPreview] = useState<{ imageId: string; url: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [showResult, setShowResult] = useState(readOnly);
  const canvas = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; clientX: number; clientY: number } | null>(null);
  const image = group.images.find(item => item.id === imageId)!;
  const template = drafts[image.id];
  const blocks = template?.blocks || [];
  const selected = blocks.find(block => block.id === selectedId);
  const isTeam = context?.contestType === 'TEAM';

  useEffect(() => { setContainer(document.body); }, []);

  useEffect(() => {
    if (!container) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, [container]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<TemplateData>(`${base}/template-data?q=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then(setContext).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '考生列表加载失败'); });
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [base, search]);

  useEffect(() => {
    const controller = new AbortController();
    setPreviewBusy(true); setPreviewError('');
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`${base}/images/${image.id}/preview`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ template, ...(candidate ? { candidateId: candidate.id } : {}) }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(body?.message || '图片预览失败');
          }
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          const objectUrl = URL.createObjectURL(blob);
          setPreview({ imageId: image.id, url: objectUrl });
        } catch (err) {
          if (!controller.signal.aborted) setPreviewError(err instanceof Error ? err.message : '图片预览失败');
        } finally { if (!controller.signal.aborted) setPreviewBusy(false); }
      })();
    }, 300);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [base, image.id, template, candidate]);

  function changeBlocks(next: ScreenTextBlock[]) {
    setDrafts(current => ({ ...current, [image.id]: { version: 1, blocks: next } }));
    setNotice('');
  }

  function updateBlock(id: string, patch: Partial<ScreenTextBlock>) {
    changeBlocks(blocks.map(block => block.id === id ? { ...block, ...patch } : block));
  }

  function addBlock(content?: string) {
    if (blocks.length >= 20) return;
    const block: ScreenTextBlock = {
      id: crypto.randomUUID(), content: content || (isTeam ? '<teamname>' : '<name>'),
      x: 10, y: Math.min(80, 15 + blocks.length * 12), width: 80, height: 12,
      fontSize: 32, fontFamily: 'SANS', alignment: 'center', color: '#111111', bold: false,
    };
    changeBlocks([...blocks, block]); setSelectedId(block.id); setShowResult(false);
  }

  function changeNumber(key: 'x' | 'y' | 'width' | 'height' | 'fontSize', value: number) {
    if (!selected || !Number.isFinite(value)) return;
    const max = key === 'x' ? 100 - selected.width : key === 'y' ? 100 - selected.height
      : key === 'width' ? 100 - selected.x : key === 'height' ? 100 - selected.y : 160;
    const min = key === 'fontSize' ? 8 : key === 'width' || key === 'height' ? 1 : 0;
    updateBlock(selected.id, { [key]: Math.round(Math.max(min, Math.min(max, value)) * 100) / 100 });
  }

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      await api(`${base}/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({
        templates: group.images.map(item => ({ imageId: item.id, template: drafts[item.id] })), expectedUpdatedAt: group.updatedAt,
      }) });
      await onSaved(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : '模板保存失败'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  function candidateLabel(item: CandidateOption) {
    return `${isTeam ? item.teamName || item.name || '未命名队伍' : item.name || '未填写姓名'} · ${item.examNumber}`;
  }

  if (!container) return null;

  return createPortal(<div className="screen-template-backdrop">
    <div ref={dialog} className="screen-template-dialog" role="dialog" aria-modal="true" aria-labelledby="screen-template-title"
      onKeyDown={event => {
        if (event.key === 'Escape' && !saving) { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])
          .filter(element => element.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header className="screen-template-heading">
        <div><h2 id="screen-template-title">{readOnly ? '图片预览' : '添加考生信息'} · {group.name}</h2><p>{readOnly ? '选择考生，查看实际推送的图片。' : '添加文字块并拖动到图片上的指定位置，可单独配置每张图片，也可复制到多张。'}</p></div>
        <div className="screen-template-actions">
          {!readOnly ? <button className="button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{saving ? '保存中…' : '保存全部图片'}</button> : null}
          <button ref={closeButton} className="button secondary" disabled={saving} onClick={onClose}><X size={16} />关闭</button>
        </div>
      </header>
      <div className="screen-template-content" inert={saving}>
        {error ? <p className="screen-control-message error" role="alert">{error}</p> : null}
        {notice ? <p className="screen-control-message" role="status">{notice}</p> : null}
        <div className="screen-template-images" aria-label="组内图片">
          {group.images.map((item, index) => <div key={item.id} className={item.id === imageId ? 'selected' : ''}>
            <button type="button" aria-pressed={item.id === imageId} onClick={() => { setImageId(item.id); setSelectedId(''); }} title={item.name}>
              <img src={item.url} alt={item.name} /><span>{index + 1}. {item.name}</span>
              <small>{drafts[item.id]?.blocks.length ? `${drafts[item.id]!.blocks.length} 个文字块` : '原图'}</small>
            </button>
            {!readOnly ? <label><input type="checkbox" checked={targets.includes(item.id)} onChange={event => setTargets(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />批量应用</label> : null}
          </div>)}
        </div>
        {!readOnly ? <div className="screen-template-batch">
          <button className="button secondary compact-button" onClick={() => setTargets(group.images.map(item => item.id))}>全选图片</button>
          <button className="button secondary compact-button" disabled={!targets.length} onClick={() => setTargets([])}>取消全选</button>
          <button className="button secondary compact-button" disabled={!targets.length} onClick={() => {
            setDrafts(current => ({ ...current, ...Object.fromEntries(targets.map(id => [id, template ? structuredClone(template) : null])) }));
            setNotice(`已将当前图片布局复制到 ${targets.length} 张图片，保存后生效`);
          }}><Copy size={14} />将当前布局应用到所选 {targets.length} 张图片</button>
          <span>按相对位置复制，适配不同尺寸图片；会替换所选图片的已有文字块。</span>
        </div> : null}
        <div className="screen-template-preview-controls">
          <label>搜索考生<input value={search} onChange={event => setSearch(event.target.value)} placeholder="姓名、队伍名称或考号" /></label>
          <label>预览身份<select aria-label="预览身份" value={candidate?.id || ''} onChange={event => setCandidate(context?.candidates.find(item => item.id === event.target.value) || null)}>
            <option value="">示例资料</option>
            {candidate && !context?.candidates.some(item => item.id === candidate.id) ? <option value={candidate.id}>{candidateLabel(candidate)}</option> : null}
            {context?.candidates.map(item => <option value={item.id} key={item.id}>{candidateLabel(item)}</option>)}
          </select></label>
          {!readOnly ? <button className="button secondary compact-button" aria-pressed={showResult} onClick={() => setShowResult(current => !current)}><Eye size={15} />{showResult ? '继续定位文字' : '查看成品'}</button> : null}
          <span className="screen-template-preview-status" role="status">{previewBusy ? <><LoaderCircle size={14} className="spin" />生成预览中…</> : candidate ? '实际考生资料' : '示例资料，仅用于预览'}</span>
        </div>
        {context?.candidates.length === 50 ? <p className="screen-template-hint">当前显示前 50 条，请输入姓名、队伍名称或考号查找更多考生。</p> : null}
        {previewError ? <p className="screen-control-message error" role="alert">{previewError}</p> : null}
        <div className={`screen-template-workspace ${readOnly ? 'preview-only' : ''}`}>
          <div className="screen-template-stage">
            <div ref={canvas} className="screen-template-canvas" style={{ aspectRatio: `${image.width} / ${image.height}` }}
              onPointerMove={event => {
                const moving = drag.current, rect = canvas.current?.getBoundingClientRect();
                const block = blocks.find(item => item.id === moving?.id);
                if (!moving || !rect || !block) return;
                const x = Math.max(0, Math.min(100 - block.width, moving.x + (event.clientX - moving.clientX) / rect.width * 100));
                const y = Math.max(0, Math.min(100 - block.height, moving.y + (event.clientY - moving.clientY) / rect.height * 100));
                updateBlock(block.id, { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
              }}
              onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
              <img src={preview?.imageId === image.id ? preview.url : image.url} alt={`${image.name} · ${candidate ? candidateLabel(candidate) : '示例资料'}预览`} draggable={false} />
              {!showResult && !readOnly ? blocks.map((block, index) => <button type="button" key={block.id}
                className={`screen-template-block ${block.id === selectedId ? 'selected' : ''}`}
                aria-label={`定位文字块 ${index + 1}`} style={{ left: `${block.x}%`, top: `${block.y}%`, width: `${block.width}%`, height: `${block.height}%` }}
                onClick={() => setSelectedId(block.id)}
                onPointerDown={event => {
                  event.preventDefault(); setSelectedId(block.id);
                  drag.current = { id: block.id, x: block.x, y: block.y, clientX: event.clientX, clientY: event.clientY };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}><span>文字块 {index + 1}</span></button>) : null}
            </div>
            <p className="screen-template-hint">{image.name} · {image.width} × {image.height}{!readOnly ? ' · 拖动框定位，长文字会在框内自动换行、缩小。' : ''}</p>
          </div>
          {!readOnly ? <aside className="screen-template-properties">
            <div className="screen-template-actions"><strong>文字块（{blocks.length}/20）</strong><button className="button secondary compact-button" disabled={!context || blocks.length >= 20} onClick={() => addBlock()}><Plus size={15} />添加文字块</button></div>
            <div className="screen-template-block-list">{blocks.map((block, index) => <button className={block.id === selectedId ? 'selected' : ''} key={block.id} onClick={() => { setSelectedId(block.id); setShowResult(false); }}>{index + 1}. {block.content || '空文字块'}</button>)}</div>
            <div className="screen-template-fields"><span>{isTeam ? '团队赛' : '个人赛'}可添加字段</span><div>{context ? screenTemplateFields(isTeam).map(field => <button key={field.token} type="button" disabled={!selected && blocks.length >= 20} onClick={() => {
              if (selected) updateBlock(selected.id, { content: `${selected.content}${field.token}`.slice(0, 500) }); else addBlock(field.token);
            }}>{field.label}</button>) : <span>加载中…</span>}</div></div>
            {selected ? <>
              <label>文字内容<textarea aria-label="文字内容" rows={3} maxLength={500} value={selected.content} onChange={event => updateBlock(selected.id, { content: event.target.value })} /></label>
              <p className="screen-template-hint">可以混合普通文字和字段，例如：学校：{'<school>'}。未填写的考生资料会留空。</p>
              <div className="screen-template-number-grid">
                {([['x', '横向位置（%）'], ['y', '纵向位置（%）'], ['width', '文字框宽（%）'], ['height', '文字框高（%）'], ['fontSize', '字号（1000 像素图）']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" min={key === 'fontSize' ? 8 : key === 'x' || key === 'y' ? 0 : 1} max={key === 'fontSize' ? 160 : 100} step={key === 'fontSize' ? 1 : 0.1} value={selected[key]} onChange={event => changeNumber(key, Number(event.target.value))} /></label>)}
                <label>对齐方式<select value={selected.alignment} onChange={event => updateBlock(selected.id, { alignment: event.target.value as ScreenTextBlock['alignment'] })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
                <label>字体<select value={selected.fontFamily} onChange={event => updateBlock(selected.id, { fontFamily: event.target.value as ScreenTextBlock['fontFamily'] })}><option value="SANS">黑体</option><option value="SERIF">宋体</option></select></label>
                <label>文字颜色<input type="color" value={selected.color} onChange={event => updateBlock(selected.id, { color: event.target.value })} /></label>
              </div>
              <label className="screen-template-check"><input type="checkbox" checked={selected.bold} onChange={event => updateBlock(selected.id, { bold: event.target.checked })} />加粗</label>
              <button className="button danger compact-button" onClick={() => { changeBlocks(blocks.filter(block => block.id !== selected.id)); setSelectedId(''); }}><Trash2 size={15} />删除当前文字块</button>
            </> : <p className="screen-template-hint">点击字段添加文字块，或选择图片上的文字框进行设置。没有文字块的图片会推送原图。</p>}
          </aside> : null}
        </div>
      </div>
    </div>
  </div>, container);
}
