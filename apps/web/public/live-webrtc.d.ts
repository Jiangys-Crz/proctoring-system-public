export function createProctorWebRtcReader(options: {
  url: string; onTrack?: (event: RTCTrackEvent) => void;
  onError?: (error: unknown) => void; onConnectionState?: (state: RTCPeerConnectionState) => void;
  onReset?: () => void;
}): { close(): void; restart(): void; readonly peer: RTCPeerConnection | null };
export function isProctorWebRtcPlaying(reader: ReturnType<typeof createProctorWebRtcReader> | null, video: HTMLVideoElement | null): boolean;
