import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PDF_CSP = "default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-src 'none'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";

export async function pdfChromePath() {
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new Error('未找到 PDF 浏览器，请安装 Chrome/Chromium 或设置 CHROME_PATH');
}

/** Untrusted statements never receive a file origin, JavaScript, network access or server environment secrets. */
export async function renderIsolatedPdf(html: string, pdfPath: string, executablePath?: string) {
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    throw new Error('PDF 浏览器需要在专用非 root 用户和启用沙箱的环境运行，请使用项目提供的容器配置');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'proctor-pdf-browser-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // Do not inherit database passwords, signing secrets or application tokens into the renderer process.
    browser = await chromium.launch({
      executablePath: executablePath || await pdfChromePath(),
      headless: true, chromiumSandbox: true, timeout: 30_000,
      args: ['--disable-dev-shm-usage'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin', HOME: temporary, TMPDIR: temporary,
        LANG: process.env.LANG || 'C.UTF-8', TZ: 'Asia/Shanghai',
      },
    });
    const context = await browser.newContext({ javaScriptEnabled: false, acceptDownloads: false, serviceWorkers: 'block', offline: true });
    await context.route('**/*', route => route.abort('blockedbyclient'));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const policy = `<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">`;
    const protectedHtml = /<head\b[^>]*>/i.test(html)
      ? html.replace(/<head\b[^>]*>/i, match => `${match}${policy}`)
      : `<!doctype html><html><head>${policy}</head><body>${html}</body></html>`;
    // setContent uses about:blank; there is never a file:// document with filesystem privileges.
    await page.setContent(protectedHtml, { waitUntil: 'load', timeout: 15_000 });
    let printTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true }),
        new Promise<never>((_, reject) => { printTimeout = setTimeout(() => reject(new Error('PDF 导出超时，请减少试卷内容后重试')), 30_000); }),
      ]);
    } finally {
      if (printTimeout) clearTimeout(printTimeout);
    }
    await context.close();
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
