import { requireSuperAdmin } from '@/lib/auth';
import { relayFailure, relayHeaders } from '@/lib/live-relay-http';
export async function POST(request: Request) {
  try { await requireSuperAdmin(request); return Response.json({ ok: false, message: '请使用系统设置中的全局直播 API-KEY' }, { status: 410, headers: relayHeaders }); }
  catch (error) { return relayFailure(error); }
}
