import { serveVoiceCall } from '@/lib/voice-call';
import { options } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => serveVoiceCall(request, 'ADMIN');
export const OPTIONS = options;
