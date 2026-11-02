'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Volume2, X } from 'lucide-react';
import '@cwnupaa/proctor-shared/realtime-voice';
import type { VoiceCallController, VoiceCallState } from '@cwnupaa/proctor-shared/realtime-voice';
import { api } from './api';

export function VoiceCallPanel({ sessionId, name, examNumber, onClose, onBusyChange }: {
  sessionId: string; name: string; examNumber: string; onClose: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const controller = useRef<VoiceCallController | null>(null);
  const latest = useRef({ onBusyChange }); latest.current = { onBusyChange };
  const [state, setState] = useState<VoiceCallState>({ phase: 'preparing', call: null, muted: false, playbackBlocked: false, message: '正在准备通话…' });
  const [seconds, setSeconds] = useState(0);
  const busy = ['preparing', 'ringing', 'connecting', 'active'].includes(state.phase);
  useEffect(() => {
    const call = globalThis.createProctorVoiceCall({ side: 'ADMIN', audio: audio.current!,
      request: body => api('/api/voice/calls', { method: 'POST', body: JSON.stringify(body) }),
      onState: next => { setState(next); latest.current.onBusyChange(['preparing', 'ringing', 'connecting', 'active'].includes(next.phase)); }
    });
    controller.current = call;
    void call.start(sessionId);
    return () => { call.dispose(); controller.current = null; latest.current.onBusyChange(false); };
  }, [sessionId]);
  useEffect(() => {
    setSeconds(0);
    if (state.phase !== 'active') return;
    const started = Date.now(), timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [state.phase]);
  return <section className="floating-panel voice-panel realtime-call-panel" aria-label="实时语音通话">
    <div className="panel-head"><strong>语音通话</strong><button type="button" className="button secondary icon-button" title={busy ? '挂断并关闭' : '关闭'} onClick={onClose}><X size={16} /></button></div>
    <div className="call-recipient"><span className={`call-avatar ${state.phase === 'active' ? 'connected' : ''}`}><Phone size={26} /></span>
      <strong>{name}</strong><span className="muted">考号 {examNumber} · 电脑客户端</span></div>
    <div className="call-state" role="status" aria-live="polite">{state.message}{state.phase === 'active' ? ` · ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : ''}</div>
    <audio ref={audio} autoPlay playsInline />
    {state.playbackBlocked ? <button className="button" onClick={() => void controller.current?.play()}><Volume2 size={18} />播放通话声音</button> : null}
    <div className="call-controls">
      {state.phase === 'active' || state.phase === 'connecting' ? <button className="button secondary" onClick={() => controller.current?.mute()} aria-pressed={state.muted}>{state.muted ? <MicOff size={18} /> : <Mic size={18} />}{state.muted ? '取消静音' : '静音'}</button> : null}
      {busy ? <button className="button danger" onClick={() => void controller.current?.hangup(state.phase === 'active' ? 'HUNG_UP' : 'CANCELLED')}><PhoneOff size={18} />挂断</button>
        : <button className="button" onClick={() => void controller.current?.start(sessionId)}><Phone size={18} />重新呼叫</button>}
    </div>
    <small className="muted">接听后双方可直接说话，声音实时传输。</small>
  </section>;
}
