import { ok, options } from '@/lib/http';
import { prepareReactionExport } from '@/lib/reaction-export';
import { streamReactionZip } from '@/lib/reaction-export-zip';
import { reactionRouteError, requireReactionAdmin } from '../_shared';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireReactionAdmin(id);
    const entries = await prepareReactionExport(id, request.signal);
    if (new URL(request.url).searchParams.get('check') === '1') return ok({ generatedCount: entries.length, invalidSubmissionIds: 0 }, { headers: { 'cache-control': 'private, no-store' } });
    return new Response(streamReactionZip(entries, request.signal), { headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="reactions-${new Date().toISOString().slice(0, 10)}.zip"`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'
    } });
  } catch (error) { return reactionRouteError(error); }
}

export const OPTIONS = options;
