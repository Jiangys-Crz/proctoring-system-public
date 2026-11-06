export interface BufferedRecording {
  id: string;
  startedAt: string;
  endedAt: string;
}
export interface RecordingEvent {
  id: string;
  occurredAt: string;
  channel: string;
}
export interface RecordingBuffer<T extends BufferedRecording> {
  add(clip: T): Promise<void>;
  mark(event: Pick<RecordingEvent, 'id' | 'occurredAt'>): Promise<void>;
  clear(): void;
  readonly size: number;
}
declare global {
  var createProctorRecordingStream: (source: MediaStream, options: {
    width: number; height: number; frameRate: number; onError: (error: unknown) => void;
  }) => { stream: MediaStream; stop: () => void };
  var createProctorRecordingBuffer: <T extends BufferedRecording>(options: {
    saveFull: () => boolean;
    saveIncidents: () => boolean;
    onSave: (clip: T, evidenceOnly: boolean) => void | Promise<void>;
    now?: () => number;
  }) => RecordingBuffer<T>;
  var proctorEvidenceChannel: (type: string, alert?: { id?: string; message?: string }) => string;
  var proctorRecordingEnabled: (requirements?: { isPublicTest?: boolean; reactionEnabled?: boolean; saveFullRecording?: boolean; saveIncidentRecording?: boolean } | null) => boolean;
}
