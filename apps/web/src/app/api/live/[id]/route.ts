import { relayWebRtcOptions, serveRelayWebRtc } from '@/lib/live-relay-webrtc';
export const runtime = 'nodejs';
async function handle(request: Request, context: { params: Promise<{ id: string }> }) { return serveRelayWebRtc(request, (await context.params).id, 'read'); }
export { handle as GET, handle as HEAD, handle as POST, handle as PATCH, handle as DELETE };
export const OPTIONS = relayWebRtcOptions;
