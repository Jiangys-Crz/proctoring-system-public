import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { claimPdfAsset, normalizePdfRaster, PDF_ASSET_MAX_BYTES, PDF_IMAGE_MAX_BYTES, PdfAssetLimitError, readPdfAsset } from '../src/lib/pdf-assets';
import { pdfChromePath, renderIsolatedPdf } from '../src/lib/isolated-pdf';

test('PDF assets reject SVG/document inputs before decoding and embed actual normalized raster images', async () => {
  await assert.rejects(normalizePdfRaster(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="http://localhost:4031/"/></svg>')), /只支持/);
  await assert.rejects(normalizePdfRaster(Buffer.from('%PDF-1.7')), /只支持/);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const normalized = await normalizePdfRaster(png);
  assert.match(normalized, /^data:image\/webp;base64,/);
  const metadata = await sharp(Buffer.from(normalized.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 2);
});

test('PDF attachment readers enforce actual streamed bytes and aggregate budgets', async () => {
  await assert.rejects(readPdfAsset(new Response('tiny', { headers: { 'content-length': String(PDF_IMAGE_MAX_BYTES + 1) } }), { bytes: 0, count: 0 }), /10 MB/);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(PDF_IMAGE_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  await assert.rejects(readPdfAsset(new Response(oversized), { bytes: 0, count: 0 }), /10 MB/);
  await assert.rejects(readPdfAsset(new Response('x'), { bytes: PDF_ASSET_MAX_BYTES, count: 0 }), PdfAssetLimitError);
  assert.throws(() => claimPdfAsset({ bytes: 0, count: 200 }), PdfAssetLimitError);
});

test('the sandboxed PDF browser produces a valid paper while blocking HTTP, frames, script and local files', { timeout: 60_000 }, async t => {
  let executable: string;
  try { executable = await pdfChromePath(); } catch { t.skip('Chrome/Chromium not installed'); return; }
  if (process.platform === 'linux' && process.getuid?.() === 0) { t.skip('PDF browser deliberately refuses root; run container test as node'); return; }
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('unexpected'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const temporary = await mkdtemp(join(tmpdir(), 'proctor-pdf-test-'));
  try {
    const localPath = join(temporary, 'fixture.html');
    await writeFile(localPath, '<h1>LOCAL_FILE_MUST_NOT_APPEAR</h1>');
    const localUrl = pathToFileURL(localPath).href;
    const pdfPath = join(temporary, 'safe.pdf');
    await renderIsolatedPdf(`<html><head><style>@import url(http://127.0.0.1:${port}/style);body{font-size:18px}</style></head><body><h1>SAFE_PAPER</h1><img src="http://127.0.0.1:${port}/image"><img src="${localUrl}"><iframe src="${localUrl}"></iframe><iframe src="http://127.0.0.1:${port}/frame"></iframe><iframe srcdoc="<script>fetch('http://127.0.0.1:${port}/script')</script>"></iframe><script>fetch('http://127.0.0.1:${port}/script')</script></body></html>`, pdfPath, executable);
    const pdf = await readFile(pdfPath);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 1000);
    assert.equal(requests, 0);
    assert.doesNotMatch(pdf.toString('latin1'), /LOCAL_FILE_MUST_NOT_APPEAR/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
