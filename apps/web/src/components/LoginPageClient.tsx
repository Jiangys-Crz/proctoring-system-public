'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogIn } from 'lucide-react';
import { api } from './api';

const PASSWORD_DIGEST_ALGORITHM = 'PROCTOR-PASSWORD-SHA512-V1';

async function digestPassword(password: string) {
  if (!globalThis.crypto?.subtle) return '';
  const bytes = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest('SHA-512', bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${PASSWORD_DIGEST_ALGORITHM}:${hex}`;
}

export function LoginPageClient() {
  const router = useRouter();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const passwordDigest = await digestPassword(password);
      await api('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ account, password, ...(passwordDigest ? { passwordDigest } : {}) })
      });
      router.replace('/dashboard/exams');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="hydro-login-page">
      <form className="card form hydro-login-card" onSubmit={submit}>
        <div className="login-brand hydro-login-brand">
          <img src="/brand/logo.png" alt="西华师范大学 Logo" />
          <div>
            <h1>程序设计算法协会线上监考平台</h1>
            <div className="muted">管理员登录</div>
          </div>
        </div>
        <a className="muted hydro-login-help" href="https://example.org" target="_blank" rel="noreferrer">
          支持本地账号和协会官网账号；协会账号首次请使用官网用户名或邮箱
        </a>
        <label>
          账号
          <input value={account} onChange={(event) => setAccount(event.target.value)} placeholder="请输入账号、学号或邮箱" autoComplete="username" />
        </label>
        <label>
          密码
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="请输入密码" autoComplete="current-password" />
        </label>
        {error ? <div style={{ color: 'var(--danger)' }}>{error}</div> : null}
        <button className="button hydro-login-submit" disabled={loading}>
          <LogIn size={18} />
          {loading ? '登录中' : '登录'}
        </button>
      </form>
    </div>
  );
}
