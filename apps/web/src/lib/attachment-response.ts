import { attachmentDisposition } from './statement-download';

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml']);

/** Attachments come from a separate trust domain, even when the problem is authorized. */
export function attachmentResponse(upstream: Response, filename: string, forceDownload = false) {
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  const headers = new Headers({
    'content-type': contentType,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Disposition, Content-Length, Content-Range',
    // SVG illustrations remain displayable, but opening any attachment as a
    // document cannot execute scripts, submit forms, or inherit admin origin.
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
  });
  if (forceDownload || !INLINE_IMAGES.has(mime)) headers.set('content-disposition', attachmentDisposition(filename));
  // fetch decodes compressed upstream bodies. Forwarding their original length
  // would truncate the decoded stream or leave the browser waiting for bytes.
  if (!upstream.headers.get('content-encoding')) {
    const length = upstream.headers.get('content-length');
    if (length && /^\d+$/.test(length)) headers.set('content-length', length);
  }
  const range = upstream.headers.get('content-range');
  if (upstream.status === 206 && range) headers.set('content-range', range);
  // Preserve backpressure and cancellation; never allocate the whole attachment.
  return new Response(upstream.body, { status: upstream.status, headers });
}
