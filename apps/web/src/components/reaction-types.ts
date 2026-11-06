export type ReactionLogoReferenceView = { path?: string; logoId?: string };
export type ReactionLogoLibraryItem = { id: string; label: string; schoolName: string | null; createdAt: string; archived: boolean; canArchive: boolean; previewUrl: string };
export type ReactionLogoLibraryView = { items: ReactionLogoLibraryItem[]; total: number; limit: number };
export type ReactionPresentationView = {
  version: 1;
  fontPreset: 'broadcast' | 'classic';
  backgroundPath?: string;
  defaultLogoPath?: string;
  defaultLogoId?: string;
  teamLogos: ({ teamId: string } & ReactionLogoReferenceView)[];
  schoolLogos: ({ schoolName: string } & ReactionLogoReferenceView)[];
};

export type ReactionConfigView = {
  enabled: boolean;
  bufferSeconds: number;
  beforeSeconds: number;
  afterSeconds: number;
  maxPendingSeconds: number;
  maxStorageBytes: number;
  retentionDays: number;
  autoGenerate: boolean;
  uploadGraceSeconds: number;
  presentation: ReactionPresentationView;
};

export type ReactionItemView = {
  id: string;
  submissionId: string;
  teamId: string;
  teamName: string;
  problemId: string;
  problemLabel: string;
  verdict: string | null;
  originalVerdict: string | null;
  verdictHistory: unknown;
  status: string;
  durationSeconds: number | null;
  reason: string | null;
  generationStatus: string;
  generationError?: string | null;
  createdAt: string;
  cameraPath: string | null;
  desktopPath: string | null;
  reactionPath: string | null;
  metadataPath: string | null;
};

export type ReactionExportSummary = { generatedCount: number; invalidSubmissionIds: number };

export type ReactionAdminView = {
  exam: { id: string; name: string; platform: string; schools: string[] };
  candidates: { teamId: string; teamName: string; schoolName: string | null }[];
  config: ReactionConfigView & { credentialsConfigured: boolean };
  health: {
    feedStatus: string;
    lastEventAt: string | null;
    lastError: string | null;
    connectedSources: number;
    bufferSegments: number;
    bufferBytes: number;
    processedSubmissions: number;
    savedVideos: number;
    missingOrFailed: number;
  };
  items: ReactionItemView[];
  exportSummary?: ReactionExportSummary;
};
