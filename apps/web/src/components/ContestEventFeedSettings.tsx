'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ContestFeedSettingsStatus } from '@/lib/contest-event-feed-settings';
import { api } from './api';

const endpoint = '/api/settings/contest-event-feed';

export function ContestEventFeedSettings() {
  const [saved, setSaved] = useState<ContestFeedSettingsStatus>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void api<ContestFeedSettingsStatus>(endpoint, { cache: 'no-store' }).then(result => {
      if (!disposed) setSaved(result);
    }).catch(reason => {
      if (!disposed) { setError(true); setMessage(reason.message); }
    });
    return () => { disposed = true; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>, remove = false) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const body = remove ? { platform: 'nova', remove: true } : {
      platform: 'nova', origin: fields.get('origin'), username: fields.get('username'), password: fields.get('secret'),
    };
    setBusy(true); setMessage(''); setError(false);
    try {
      setSaved(await api<ContestFeedSettingsStatus>(endpoint, { method: 'PUT', body: JSON.stringify(body) }));
      form.reset();
      setMessage(remove ? '已移除 NovaJudge 后台凭据' : '已保存，直播和大屏会在下一次读取时使用该凭据');
    } catch (reason) {
      setError(true);
      setMessage(reason instanceof Error ? reason.message : '保存失败');
    } finally { setBusy(false); }
  }

  return <div className="form">
    {message && <div role={error ? 'alert' : 'status'}>{message}</div>}
    <p className="muted">HydroOJ 浏览器考试的 EventFeed 密钥已移到对应考试的「HydroOJ 接入」设置中。此处仅保留 NovaJudge 的后台凭据。</p>
    <form className="form"
      onSubmit={event => void save(event, (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'remove')}>
      <fieldset className="form" disabled={!saved || busy}>
        <legend>NovaJudge</legend>
        <p className="muted">{saved?.nova ? '已保存后台凭据' : '暂无后台凭据'}。站点地址需与 NovaJudge 考试配置的站点一致。</p>
        <label>CCS 站点地址<input key={saved?.nova?.origin || ''} name="origin" type="url" placeholder="https://novajudge.example.com" defaultValue={saved?.nova?.origin} required /></label>
        <label>NovaJudge 超级管理员账号<input key={saved?.nova?.username || ''} name="username" defaultValue={saved?.nova?.username} autoComplete="off" required /></label>
        <label>CCS 登录密码<input name="secret" type="password" autoComplete="new-password" required /></label>
        <div className="toolbar">
          <button className="button" type="submit">保存凭据</button>
          {saved?.nova && <button className="button secondary" type="submit" value="remove" formNoValidate>移除后台凭据</button>}
        </div>
      </fieldset>
    </form>
  </div>;
}
