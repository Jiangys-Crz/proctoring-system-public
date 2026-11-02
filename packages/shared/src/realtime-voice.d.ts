export interface VoiceCallInfo {
  id: string; sessionId: string; target: 'DESKTOP'; status: 'RINGING' | 'CONNECTING' | 'ACTIVE' | 'ENDED';
  callerName: string; createdAt: string; acceptedAt: string | null; startedAt: string | null; endedAt: string | null; endReason: string | null;
}
export interface VoiceCallState {
  phase: 'idle' | 'preparing' | 'ringing' | 'incoming' | 'connecting' | 'active' | 'ended' | 'error';
  call: VoiceCallInfo | null; muted: boolean; playbackBlocked: boolean; message: string;
}
export interface VoiceCallController {
  start(sessionId: string): Promise<void>; accept(): Promise<void>; hangup(reason?: string): Promise<void>; listen(): void;
  mute(): void; play(): Promise<void>; dispose(): void; readonly state: VoiceCallState;
}
declare global {
  var createProctorVoiceCall: (options: {
    side: 'ADMIN' | 'DESKTOP'; sessionId?: string; audio: HTMLAudioElement;
    request: (body: Record<string, unknown>) => Promise<any>;
    getMicrophone?: () => Promise<MediaStream>;
    onState?: (state: VoiceCallState) => void;
  }) => VoiceCallController;
}
