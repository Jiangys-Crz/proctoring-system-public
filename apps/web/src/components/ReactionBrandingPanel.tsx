'use client';

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Pencil, RefreshCw, RotateCcw, Save, Trash2, X } from 'lucide-react';
import type { ReactionBrandingView } from '@/lib/reaction-branding-contract';
import { api } from './api';
import styles from './ReactionBrandingPanel.module.css';

const endpoint = '/api/settings/reaction-branding';
const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
type OrganizationBadge = ReactionBrandingView['organizations'][number];

function selectedImage(file?: File) {
  if (!file) return;
  if (!imageTypes.includes(file.type) || !file.size || file.size > 4 * 1024 ** 2) throw new Error('请选择不超过 4 MiB 的 PNG、JPEG 或 WebP 图片');
  return file;
}
function useImagePreview(file?: File) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file) { setUrl(''); return; }
    const value = URL.createObjectURL(file); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return url;
}
function BadgePreview({ src, label, compact = false }: { src?: string; label: string; compact?: boolean }) {
  return <div className={`${styles.badge} ${compact ? styles.compactBadge : ''}`}>
    {src ? <img src={src} alt={label} /> : <ImagePlus size={compact ? 24 : 32} aria-hidden="true" />}
  </div>;
}

export function ReactionBrandingPanel() {
  const [data, setData] = useState<ReactionBrandingView | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [organizationFile, setOrganizationFile] = useState<File>();
  const [defaultFile, setDefaultFile] = useState<File>();
  const [search, setSearch] = useState('');
  const organizationInput = useRef<HTMLInputElement>(null), defaultInput = useRef<HTMLInputElement>(null);
  const organizationPreview = useImagePreview(organizationFile), defaultPreview = useImagePreview(defaultFile);

  useEffect(() => {
    const abort = new AbortController();
    void api<ReactionBrandingView>(endpoint, { signal: abort.signal, cache: 'no-store' }).then(setData)
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '组织徽章设置加载失败'); });
    return () => abort.abort();
  }, []);

  async function mutate(key: string, success: string, action: () => Promise<unknown>) {
    setBusy(key); setError(''); setMessage('');
    try {
      await action();
      setData(await api<ReactionBrandingView>(endpoint, { cache: 'no-store' }));
      setMessage(success); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : '组织徽章操作失败'); return false; }
    finally { setBusy(''); }
  }
  function pick(file: File | undefined, setter: (value: File | undefined) => void, input: HTMLInputElement) {
    try { setter(selectedImage(file)); setError(''); }
    catch (cause) { setter(undefined); input.value = ''; setError(cause instanceof Error ? cause.message : '图片不正确'); }
  }
  async function addOrganization() {
    if (!organizationFile || !name.trim()) return;
    const body = new FormData(); body.set('kind', 'organization'); body.set('name', name); body.set('file', organizationFile);
    if (await mutate('add', '组织徽章已添加。后续生成的视频会按组织名称自动选用。', () => api(endpoint, { method: 'POST', body }))) {
      setName(''); setOrganizationFile(undefined); if (organizationInput.current) organizationInput.current.value = '';
    }
  }
  async function replaceOrganization(existingName: string, file: File) {
    const body = new FormData(); body.set('kind', 'organization'); body.set('name', existingName); body.set('existingName', existingName); body.set('replace', 'true'); body.set('file', file);
    return mutate('replace', '组织徽章已替换；已有成片需要重新生成才能应用。', () => api(endpoint, { method: 'POST', body }));
  }
  async function renameOrganization(existingName: string, nextName: string) {
    return mutate('rename', '组织名称已修改。请确保考生资料中的学校/组织名称与它对应。', () => api(endpoint, { method: 'PATCH', body: JSON.stringify({ name: existingName, newName: nextName }) }));
  }
  async function deleteOrganization(existingName: string) {
    return mutate('delete', '组织徽章映射已删除；未匹配组织将使用全局默认徽章。', () => api(endpoint, { method: 'DELETE', body: JSON.stringify({ name: existingName }) }));
  }
  async function saveDefault() {
    if (!defaultFile) return;
    const body = new FormData(); body.set('kind', 'default'); body.set('file', defaultFile);
    if (data?.defaultBadge.logoId) { body.set('replace', 'true'); body.set('existingName', 'default'); }
    if (await mutate('default', '全局默认徽章已保存，未匹配组织时会使用该徽章。', () => api(endpoint, { method: 'POST', body }))) {
      setDefaultFile(undefined); if (defaultInput.current) defaultInput.current.value = '';
    }
  }
  async function resetDefault() {
    if (await mutate('reset-default', '已恢复内置中性默认徽章。', () => api(endpoint, { method: 'DELETE', body: '{}' }))) {
      setDefaultFile(undefined); if (defaultInput.current) defaultInput.current.value = '';
    }
  }

  const organizations = data?.organizations.filter(item => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) || [];
  return <div className={styles.panel}>
    <div className={styles.introduction}>
      <p className="muted">所有考试共用这份组织徽章设置。组织名称来自考生资料中的学校/组织字段，规范化后精确匹配；未匹配时使用全局默认徽章。</p>
      <p className="muted">名称会统一兼容字符、去掉首尾空白并合并连续空白，保留大小写。请使用实际组织名称，不按相似名称猜测。</p>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {message ? <div className={styles.message} role="status">{message}</div> : null}
    <div className={styles.heading}><span className="muted">{data ? `${data.organizations.length} 个组织 · 上限 ${data.limit}` : '正在加载组织徽章…'}</span><button type="button" className="button secondary compact-button" disabled={Boolean(busy)} onClick={() => void mutate('refresh', '组织徽章设置已刷新。', async () => {})}><RefreshCw size={16} className={busy === 'refresh' ? 'spin' : undefined} />刷新</button></div>
    <fieldset className={`form ${styles.fields}`} disabled={Boolean(busy) || !data}>
      <div className={styles.settingsGrid}>
        <section className={styles.settingCard} aria-label="添加组织徽章">
          <h3>添加组织徽章</h3>
          <div className={styles.uploadLayout}>
            <BadgePreview src={organizationPreview} label="待添加的组织徽章预览" />
            <div className={styles.uploadFields}>
              <label>组织名称<input aria-label="组织名称" value={name} maxLength={200} placeholder="与考生学校/组织名称一致" onChange={event => setName(event.target.value)} /></label>
              <label>徽章图片<input ref={organizationInput} aria-label="新增组织徽章图片" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => pick(event.target.files?.[0], setOrganizationFile, event.target)} /></label>
            </div>
          </div>
          <div className={styles.actions}><button type="button" className="button" disabled={!name.trim() || !organizationFile || Boolean(data && data.organizations.length >= data.limit)} onClick={() => void addOrganization()}><ImagePlus size={16} />{busy === 'add' ? '添加中…' : '添加组织徽章'}</button></div>
        </section>
        <section className={styles.settingCard} aria-label="全局默认徽章">
          <h3>全局默认徽章</h3>
          <div className={styles.uploadLayout}>
            <BadgePreview src={defaultPreview || data?.defaultBadge.previewUrl} label={defaultPreview ? '待保存的默认徽章预览' : '当前全局默认徽章'} />
            <div className={styles.uploadFields}>
              <p className="muted">{defaultPreview ? '已选择新图片，保存后生效。' : data?.defaultBadge.logoId ? '当前使用自定义默认徽章。' : '当前使用内置中性徽章。'}</p>
              <label>替换默认徽章<input ref={defaultInput} aria-label="默认徽章图片" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => pick(event.target.files?.[0], setDefaultFile, event.target)} /></label>
            </div>
          </div>
          <div className={styles.actions}><button type="button" className="button" disabled={!defaultFile} onClick={() => void saveDefault()}><Save size={16} />保存默认徽章</button><button type="button" className="button secondary" disabled={!data?.defaultBadge.logoId} onClick={() => void resetDefault()}><RotateCcw size={16} />恢复内置默认</button></div>
        </section>
      </div>
      <p className="muted">支持 PNG、JPEG、WebP，单张不超过 4 MiB。建议使用 512×512 的透明正方形图片；下方预览展示圆形底衬效果。设置保存后，已有视频需重新生成才能应用。</p>
      <section className={styles.organizations} aria-label="已配置的组织徽章">
        <div className={styles.heading}><h3>已配置的组织</h3><input className={styles.search} aria-label="搜索组织徽章" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索组织名称" /></div>
        {organizations.length ? organizations.map(item => <OrganizationBadgeRow key={item.name} item={item} rename={renameOrganization} replace={replaceOrganization} remove={deleteOrganization} setError={setError} />) : <p className="muted">{search ? '没有匹配的组织。' : '尚未添加组织徽章；目前使用全局默认徽章。'}</p>}
      </section>
    </fieldset>
  </div>;
}

function OrganizationBadgeRow({ item, rename, replace, remove, setError }: {
  item: OrganizationBadge;
  rename: (name: string, newName: string) => Promise<boolean>;
  replace: (name: string, file: File) => Promise<boolean>;
  remove: (name: string) => Promise<boolean>;
  setError: (message: string) => void;
}) {
  const [editing, setEditing] = useState<'name' | 'image' | 'delete' | null>(null);
  const [name, setName] = useState(item.name);
  const [file, setFile] = useState<File>();
  const preview = useImagePreview(file);
  function close() { setEditing(null); setFile(undefined); setName(item.name); }
  return <article className={styles.organizationCard}>
    <div className={styles.organizationSummary}>
      <BadgePreview src={item.previewUrl} label={`${item.name} 徽章`} compact />
      <strong className={styles.organizationName}>{item.name}</strong>
      <div className={styles.actions}>
        <button type="button" className="button secondary compact-button" aria-label={`替换 ${item.name} 徽章`} onClick={() => { close(); setEditing('image'); }}><ImagePlus size={15} />替换徽章</button>
        <button type="button" className="button secondary compact-button" aria-label={`修改 ${item.name} 名称`} onClick={() => { close(); setEditing('name'); }}><Pencil size={15} />修改名称</button>
        <button type="button" className="button secondary compact-button" aria-label={`删除 ${item.name} 徽章`} onClick={() => { close(); setEditing('delete'); }}><Trash2 size={15} />删除</button>
      </div>
    </div>
    {editing ? <div className={styles.editor}>
      {editing === 'name' ? <><label>新组织名称<input aria-label={`重命名 ${item.name}`} value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label><div className={styles.actions}><button type="button" className="button" disabled={!name.trim() || name === item.name} onClick={() => void rename(item.name, name).then(saved => { if (saved) close(); })}><Save size={15} />保存名称</button><button type="button" className="button secondary" onClick={close}><X size={15} />取消</button></div></> : null}
      {editing === 'image' ? <><div className={styles.uploadLayout}><BadgePreview src={preview || item.previewUrl} label={`${item.name} 替换预览`} compact /><label>新徽章图片<input aria-label={`选择 ${item.name} 新徽章`} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { try { setFile(selectedImage(event.target.files?.[0])); setError(''); } catch (cause) { setFile(undefined); event.target.value = ''; setError(cause instanceof Error ? cause.message : '图片不正确'); } }} /></label></div><div className={styles.actions}><button type="button" className="button" disabled={!file} onClick={() => file && void replace(item.name, file).then(saved => { if (saved) close(); })}><Save size={15} />保存替换</button><button type="button" className="button secondary" onClick={close}><X size={15} />取消</button></div></> : null}
      {editing === 'delete' ? <><p>删除“{item.name}”的徽章映射后，该组织后续生成的视频将使用默认徽章。已有成片保持不变。</p><div className={styles.actions}><button type="button" className="button danger" aria-label={`确认删除 ${item.name} 徽章`} onClick={() => void remove(item.name)}><Trash2 size={15} />确认删除</button><button type="button" className="button secondary" onClick={close}><X size={15} />取消</button></div></> : null}
    </div> : null}
  </article>;
}
