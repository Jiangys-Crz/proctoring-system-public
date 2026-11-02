import { getPublishedArtifact } from '@/lib/desktop-releases';
import { desktopDownload } from '@/lib/desktop-download';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const asset = await getPublishedArtifact((await params).filename);
  if (!asset) return new Response('Not found', { status: 404 });
  return desktopDownload(request, asset);
}
