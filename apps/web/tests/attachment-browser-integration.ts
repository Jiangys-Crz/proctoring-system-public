// A disposable loopback server and browser prove that hostile upstream SVG/HTML
// cannot act with the admin origin. No real application or database is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { chromium } from 'playwright-core';
import { attachmentResponse } from '../src/lib/attachment-response';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/><script>window.attachmentScriptRan = true; fetch('/mutation', {method:'POST'});</script></svg>`;
let mutations = 0;
const server = createServer(async (request, response) => {
  if (request.url === '/mutation') { mutations++; response.writeHead(204).end(); return; }
  if (request.url === '/page') { response.writeHead(200, { 'content-type': 'text/html' }).end('<img id="figure" src="/safe.svg">'); return; }
  const upstream = new Response(request.url === '/file.html' ? '<script>window.attachmentScriptRan=true;fetch("/mutation",{method:"POST"})</script>' : svg, {
    headers: { 'content-type': request.url === '/file.html' ? 'text/html' : 'image/svg+xml' },
  });
  const served = request.url === '/baseline.svg' ? upstream : attachmentResponse(upstream, request.url === '/file.html' ? 'file.html' : 'figure.svg');
  response.writeHead(served.status, Object.fromEntries(served.headers));
  Readable.fromWeb(served.body as import('node:stream/web').ReadableStream).pipe(response);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage();
  const baselineMutation = page.waitForResponse(response => response.url() === `${base}/mutation`);
  await page.goto(`${base}/baseline.svg`);
  await baselineMutation;
  assert.equal(await page.evaluate(() => (window as unknown as { attachmentScriptRan?: boolean }).attachmentScriptRan), true, 'unprotected upstream SVG executes same-origin code');
  assert.equal(mutations, 1);
  await page.goto(`${base}/safe.svg`);
  assert.equal(await page.evaluate(() => (window as unknown as { attachmentScriptRan?: boolean }).attachmentScriptRan), undefined);
  assert.equal(await page.evaluate(() => { try { void localStorage.length; return true; } catch { return false; } }), false, 'sandbox removes the admin origin');
  await page.goto(`${base}/page`);
  await page.waitForFunction(() => (document.getElementById('figure') as HTMLImageElement)?.naturalWidth === 20);
  const download = page.waitForEvent('download');
  await page.goto(`${base}/file.html`).catch(error => { assert.match(String(error), /download/i); });
  assert.equal((await download).suggestedFilename(), 'file.html');
  assert.equal(mutations, 1, 'protected attachments made no authenticated mutation');
  console.log('PASS: baseline SVG executes; protected SVG has opaque origin and blocked scripts, image preview works, HTML downloads without execution.');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
