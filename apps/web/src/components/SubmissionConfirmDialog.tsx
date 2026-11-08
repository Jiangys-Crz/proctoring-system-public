'use client';

import { useEffect, useRef } from 'react';
import { LoaderCircle, Send, X } from 'lucide-react';

export function SubmissionConfirmDialog({ title, description, busy, error, onCancel, onConfirm }: {
  title: string;
  description: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return <dialog ref={dialog} className="nova-dialog submission-confirm-dialog" aria-labelledby="submission-confirm-title" aria-describedby="submission-confirm-description" onCancel={event => {
    event.preventDefault();
    if (!busy) onCancel();
  }}>
    <header className="nova-dialog-header">
      <h2 id="submission-confirm-title">{title}</h2>
      <button type="button" className="nova-dialog-close" aria-label="关闭确认弹窗" disabled={busy} onClick={onCancel}><X size={20} /></button>
    </header>
    <div className="nova-dialog-body">
      <p id="submission-confirm-description">{description}</p>
      {error ? <p className="nova-dialog-error" role="alert">{error}</p> : null}
    </div>
    <footer className="nova-dialog-footer">
      <button type="button" className="button secondary" autoFocus disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" className="button" disabled={busy} onClick={onConfirm}>
        {busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
        {busy ? '提交中…' : '确认提交'}
      </button>
    </footer>
  </dialog>;
}
