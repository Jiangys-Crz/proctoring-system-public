'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, KeyRound, RefreshCw, Save, X } from 'lucide-react';
import { api } from './api';
import { DesktopReleasePanel } from './DesktopReleasePanel';
import { LiveApiKeysPanel } from './LiveApiKeysPanel';
import { ReactionBrandingPanel } from './ReactionBrandingPanel';
import { HYDRO_SETTINGS_VERSION, publicHydroSettings, type HydroConnectionSettings, type HydroSettingsResponse } from '@/lib/hydro-settings-contract';
import type { HydroConnectionCheckResult } from '@/lib/hydro-connection-check';

interface ExternalLoginSettings {
  apiBase: string;
  appKey: string;
}

type HydroSettings = HydroConnectionSettings;

interface StorageSettings {
  provider: 'LOCAL' | 'S3';
  localUploadDir: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
    publicBaseUrl?: string;
  };
}

const fallback: StorageSettings = {
  provider: 'LOCAL',
  localUploadDir: './uploads',
  s3: {
    region: 'auto',
    forcePathStyle: true
  }
};

const externalFallback: ExternalLoginSettings = {
  apiBase: 'https://www.example.org/api',
  appKey: ''
};

const hydroFallback: HydroSettings = {
  baseUrl: 'http://localhost',
  apiKey: '',
  problemDomainId: 'Problems'
};

export function SystemPageClient() {
  const [externalSettings, setExternalSettings] = useState<ExternalLoginSettings>(externalFallback);
  const [hydroSettings, setHydroSettings] = useState<HydroSettings>(hydroFallback);
  const [storageSettings, setStorageSettings] = useState<StorageSettings>(fallback);
  const [openPanel, setOpenPanel] = useState<'hydro' | 'external' | 'storage' | 'desktop' | 'live' | 'branding' | null>('hydro');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState('');
  const [isError, setIsError] = useState(false);
  const [hydroLoaded, setHydroLoaded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [apiKeyPendingSave, setApiKeyPendingSave] = useState(false);
  const [connectionCheck, setConnectionCheck] = useState<HydroConnectionCheckResult | null>(null);

  async function loadExternalSettings() {
    setExternalSettings(await api<ExternalLoginSettings>('/api/settings/external-login'));
  }

  async function loadHydroSettings() {
    const saved = await api<HydroSettingsResponse>('/api/settings/hydro', { cache: 'no-store' });
    if (saved.settingsVersion !== HYDRO_SETTINGS_VERSION) throw new Error('当前后台服务仍是旧版本，请重新构建并重建监考网页容器后刷新页面');
    setHydroSettings(publicHydroSettings(saved));
    setHydroLoaded(true);
  }

  async function loadStorageSettings() {
    setStorageSettings(await api<StorageSettings>('/api/settings/storage'));
  }

  useEffect(() => {
    for (const load of [loadExternalSettings, loadHydroSettings, loadStorageSettings]) {
      void load().catch(error => { setIsError(true); setMessage(error instanceof Error ? error.message : '系统设置加载失败'); });
    }
  }, []);

  useEffect(() => {
    const openLinkedPanel = () => { if (window.location.hash === '#reaction-branding') setOpenPanel('branding'); };
    openLinkedPanel(); window.addEventListener('hashchange', openLinkedPanel);
    return () => window.removeEventListener('hashchange', openLinkedPanel);
  }, []);

  async function saveExternalSettings() {
    setMessage('');
    setIsError(false);
    setSaving('external');
    try {
      await api('/api/settings/external-login', {
        method: 'PUT',
        body: JSON.stringify(externalSettings)
      });
      setMessage('已保存协会官网登录 API 设置');
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving('');
    }
  }

  async function saveHydroSettings() {
    setMessage('');
    setIsError(false);
    setSaving('hydro');
    try {
      const saved = await api<HydroSettings>('/api/settings/hydro', {
        method: 'PUT',
        body: JSON.stringify(hydroSettings)
      });
      setHydroSettings(saved);
      setApiKeyPendingSave(false);
      setMessage('已保存评测服务设置');
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving('');
    }
  }

  async function saveStorageSettings() {
    setMessage('');
    setIsError(false);
    setSaving('storage');
    try {
      await api('/api/settings/storage', {
        method: 'PUT',
        body: JSON.stringify(storageSettings)
      });
      setMessage('已保存系统存储设置');
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving('');
    }
  }

  function updateHydroSettings(patch: Partial<HydroSettings>) {
    setHydroSettings(previous => ({ ...previous, ...patch }));
    setConnectionCheck(null);
  }

  async function checkConnection() {
    setChecking(true);
    setConnectionCheck(null);
    setMessage('');
    setIsError(false);
    try {
      const result = await api<HydroConnectionCheckResult>('/api/settings/hydro/check', {
        method: 'POST', body: JSON.stringify(hydroSettings),
      });
      setConnectionCheck(result);
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : '连接检测失败');
    } finally {
      setChecking(false);
    }
  }

  async function generateApiKey() {
    setGeneratingKey(true);
    setMessage('');
    setIsError(false);
    try {
      const result = await api<{ apiKey: string }>('/api/settings/hydro/api-key', { method: 'POST' });
      updateHydroSettings({ apiKey: result.apiKey });
      setApiKeyPendingSave(true);
      setMessage('API-Key 已生成，请先保存评测服务设置，再复制到评测服务插件中填写');
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : 'API-Key 生成失败');
    } finally {
      setGeneratingKey(false);
    }
  }

  async function copyApiKey() {
    setIsError(false);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(hydroSettings.apiKey);
      } else {
        const field = document.createElement('textarea');
        field.value = hydroSettings.apiKey;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        try {
          field.select();
          if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请通过 HTTPS 或 localhost 打开后台');
        } finally {
          field.remove();
        }
      }
      setMessage('API-Key 已复制，请填写到评测服务的「系统设置 → 考试监考平台 → API-Key」');
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : '复制失败');
    }
  }

  function panelHeader(panel: 'hydro' | 'external' | 'storage' | 'desktop' | 'live' | 'branding', title: string) {
    const open = openPanel === panel;
    return (
      <button className="collapse-header" onClick={() => setOpenPanel(open ? null : panel)}>
        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        <span>{title}</span>
      </button>
    );
  }

  return (
    <div className="grid">
      <div>
        <h1 style={{ margin: 0 }}>系统设置</h1>
      </div>
      {message ? <div className="card" role={isError ? 'alert' : 'status'} style={{ color: isError ? '#b42318' : 'var(--accent-2)' }}>{message}</div> : null}

      <section className="card form">
        {panelHeader('desktop', '客户端发布与安装包管理')}
        {openPanel === 'desktop' && <DesktopReleasePanel />}
      </section>

      <section className="card form">
        {panelHeader('live', '直播 API Key 管理')}
        {openPanel === 'live' && <LiveApiKeysPanel />}
      </section>

      <section className="card form" id="reaction-branding">
        {panelHeader('branding', 'Reaction 组织徽章与默认徽章')}
        {openPanel === 'branding' && <ReactionBrandingPanel />}
      </section>

      <section className="card form">
        {panelHeader('hydro', '评测服务设置')}
        {openPanel === 'hydro' ? (
          <fieldset className="form" disabled={!hydroLoaded || saving === 'hydro' || checking || generatingKey} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="muted">评测设置版本：{HYDRO_SETTINGS_VERSION}</div>
            <div className="muted">所有考试共用此评测服务。填写服务主地址，不包含 /api 或其他子路由。</div>
            <div className="muted">在评测服务的「系统设置 → 考试监考平台」中填写相同的 API-Key 和题库域 ID（默认 Problems）。保存后立即生效。</div>
            <label>
              评测服务主地址（域名）
              <input type="url" value={hydroSettings.baseUrl} onChange={(event) => updateHydroSettings({ baseUrl: event.target.value })} placeholder="http://localhost" required />
            </label>
            <div className="grid two">
              <div style={{ display: 'grid', gap: 8 }}>
                <label>
                API-Key
                <input type="password" autoComplete="off" value={hydroSettings.apiKey} readOnly placeholder="由监考后台生成" />
                </label>
                <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="button secondary compact-button" onClick={() => void generateApiKey()}><KeyRound size={16} />{generatingKey ? '生成中…' : hydroSettings.apiKey ? '重新生成 API-Key' : '生成 API-Key'}</button>
                  <button type="button" className="button secondary compact-button" disabled={!hydroSettings.apiKey || apiKeyPendingSave} onClick={() => void copyApiKey()}><Copy size={16} />复制 API-Key</button>
                </span>
                {apiKeyPendingSave ? <span className="muted">新 API-Key 尚未保存，保存后即可复制。</span> : null}
              </div>
              <label>
                题库域 ID
                <input value={hydroSettings.problemDomainId} onChange={(event) => updateHydroSettings({ problemDomainId: event.target.value })} placeholder="Problems" required />
              </label>
            </div>
            <div className="muted">API-Key 由监考后台生成。生成后先保存，再复制到评测服务插件；重新生成时，两端都需要更新。</div>
            <div className="muted">监考后台仅使用 API-Key 调用判题机。无需账号、密码、签名密钥或 Hydro 比赛匹配；考生和考试记录保存在监考系统。</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button className="button" onClick={() => void saveHydroSettings()} disabled={saving === 'hydro' || checking}>
              <Save size={18} />
              {saving === 'hydro' ? '保存中' : '保存评测服务设置'}
            </button>
            <button className="button secondary" onClick={() => void checkConnection()} disabled={saving === 'hydro' || checking}>
              <RefreshCw size={18} className={checking ? 'spin' : undefined} />
              {checking ? '检测中…' : '检测连接与配置'}
            </button>
            </div>
            <div className="muted">检测使用当前填写的内容，不会保存配置或产生判题记录。</div>
          </fieldset>
        ) : null}
        {openPanel === 'hydro' && connectionCheck ? <div role="status" style={{ display: 'grid', gap: 10, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <strong style={{ color: connectionCheck.matched ? 'var(--accent-2)' : '#b42318' }}>{connectionCheck.matched ? '连接正常，已核对的配置一致' : '检测完成，服务配置或插件版本需要调整'}</strong>
          {connectionCheck.checks.map(item => <div key={item.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: item.matched === false ? '#b42318' : undefined }}>{item.matched === true ? <Check size={17} /> : item.matched === false ? <X size={17} /> : <span>—</span>}<div><strong>{item.label}</strong><div className="muted">{item.message}</div></div></div>)}
        </div> : null}
      </section>

      <section className="card form">
        {panelHeader('external', '协会官网登录API管理')}
        {openPanel === 'external' ? (
          <>
            <label>
              API 基础地址
              <input value={externalSettings.apiBase} onChange={(event) => setExternalSettings({ ...externalSettings, apiBase: event.target.value })} placeholder="https://www.example.org/api" />
            </label>
            <label>
              AppKey
              <input type="password" value={externalSettings.appKey} onChange={(event) => setExternalSettings({ ...externalSettings, appKey: event.target.value })} placeholder="请输入协会官网分配的 AppKey" />
            </label>
            <small className="muted">比赛外榜推送未单独填写密钥时使用此密钥；推送域名、赛事 ID 和可选密钥在每场比赛的管理设置中配置。开启推送前，请在 CWNUPAA 官网接口管理中为该密钥授予“外榜”权限。</small>
            <button className="button" onClick={() => void saveExternalSettings()} disabled={saving === 'external'}>
              <Save size={18} />
              {saving === 'external' ? '保存中' : '保存协会官网登录API设置'}
            </button>
          </>
        ) : null}
      </section>

      <section className="card form">
        {panelHeader('storage', '存储设置')}
        {openPanel === 'storage' ? (
          <>
        <label>
          存储模式
          <select value={storageSettings.provider} onChange={(event) => setStorageSettings({ ...storageSettings, provider: event.target.value as 'LOCAL' | 'S3' })}>
            <option value="LOCAL">本机 uploads</option>
            <option value="S3">对象存储（S3 兼容）</option>
          </select>
        </label>
        <label>
          本机上传目录
          <input value={storageSettings.localUploadDir} onChange={(event) => setStorageSettings({ ...storageSettings, localUploadDir: event.target.value })} />
        </label>
        <div className="grid two">
          <label>
            S3 Endpoint
            <input value={storageSettings.s3.endpoint || ''} onChange={(event) => setStorageSettings({ ...storageSettings, s3: { ...storageSettings.s3, endpoint: event.target.value || undefined } })} />
          </label>
          <label>
            Region
            <input value={storageSettings.s3.region} onChange={(event) => setStorageSettings({ ...storageSettings, s3: { ...storageSettings.s3, region: event.target.value } })} />
          </label>
          <label>
            Bucket
            <input value={storageSettings.s3.bucket || ''} onChange={(event) => setStorageSettings({ ...storageSettings, s3: { ...storageSettings.s3, bucket: event.target.value || undefined } })} />
          </label>
          <label>
            Public Base URL
            <input value={storageSettings.s3.publicBaseUrl || ''} onChange={(event) => setStorageSettings({ ...storageSettings, s3: { ...storageSettings.s3, publicBaseUrl: event.target.value || undefined } })} />
          </label>
          <label>
            Access Key ID
            <input value={storageSettings.s3.accessKeyId || ''} onChange={(event) => setStorageSettings({ ...storageSettings, s3: { ...storageSettings.s3, accessKeyId: event.target.value || undefined } })} />
          </label>
          <label>
            Secret Access Key
            <input type="password" value={storageSettings.s3.secretAccessKey || ''} onChange={(event) => setStorageSettings({ ...storageSettings, s3: { ...storageSettings.s3, secretAccessKey: event.target.value || undefined } })} />
          </label>
        </div>
        <label>
          <span>
            <input type="checkbox" checked={storageSettings.s3.forcePathStyle} onChange={(event) => setStorageSettings({ ...storageSettings, s3: { ...storageSettings.s3, forcePathStyle: event.target.checked } })} /> 使用 Path Style
          </span>
        </label>
        <button className="button" onClick={() => void saveStorageSettings()} disabled={saving === 'storage'}>
          <Save size={18} />
          {saving === 'storage' ? '保存中' : '保存存储设置'}
        </button>
          </>
        ) : null}
      </section>
    </div>
  );
}
