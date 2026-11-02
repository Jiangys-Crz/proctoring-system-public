'use client';

import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { api } from './api';

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function logout() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.replace('/login');
    } catch {
      setError('退出失败，请重试');
      setBusy(false);
    }
  }

  return (
    <button type="button" className="logout-button" onClick={() => void logout()} disabled={busy} title={error || '退出登录'}>
      <LogOut size={16} />
      {error || (busy ? '正在退出…' : '退出登录')}
    </button>
  );
}
