import type { ProctorApi } from '../shared/types';

declare global {
  interface Window {
    proctorApi: ProctorApi;
    proctorWindowPolicy(session: { status?: string; lockdown?: boolean; lockdownReason?: string } | null): { mode: 'setup' | 'floating' | 'locked'; cheating: boolean };
    proctorCapturePolicy(session: { id?: string; status?: string } | null, requirements: { requireFrontCamera?: boolean } | null, live?: { screen?: boolean; camera?: boolean }): { captureScreen: boolean; captureCamera: boolean; previewScreen: boolean; previewCamera: boolean; channels: string[] };
    PROCTOR_DEFAULT_SERVER_URL?: string;
    PROCTOR_CLIENT_WEB_URL?: string;
    PROCTOR_MOBILE_WEB_URL?: string;
    PROCTOR_PUBLIC_API_URL?: string;
    PROCTOR_MEDIA_RTMP_BASE?: string;
    PROCTOR_MEDIA_HLS_BASE?: string;
  }
}

export {};
