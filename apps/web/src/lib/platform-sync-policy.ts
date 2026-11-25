// Login approvals and identity photos belong to the server that verified the
// candidate. Other exam data, including session history, keeps synchronizing.
// Legacy wire kinds remain parseable for rolling server upgrades.
export const LOCAL_PLATFORM_KINDS = ['LOGIN', 'PHOTO'] as const;
const localKinds = new Set<string>(LOCAL_PLATFORM_KINDS);
export const isSynchronizedPlatformKind = (kind: string) => !localKinds.has(kind);
