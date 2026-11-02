import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeStatementHtml } from '@cwnupaa/proctor-shared';

test('statements preserve ordinary formatting while removing active HTML and event attributes', () => {
  const safe = sanitizeStatementHtml('<h2>标题</h2><table><tr><td colspan="2">保留</td></tr></table><img src="https://images.example.test/a.png" onerror="alert(1)"><script>alert(2)</script><iframe srcdoc="<script>alert(3)</script>"></iframe><svg><foreignObject>隐藏</foreignObject></svg><div style="position:fixed" id="sessionToken" onclick="alert(4)">文字</div>');
  assert.match(safe, /<h2>标题<\/h2>/);
  assert.match(safe, /colspan="2"/);
  assert.match(safe, /src="https:\/\/images.example.test\/a.png"/);
  assert.doesNotMatch(safe, /onerror|onclick|style=|id=|script|iframe|srcdoc|svg|隐藏|alert\(/i);
});

test('encoded URLs and parser-confusion payloads cannot create executable links', () => {
  const safe = sanitizeStatementHtml('<a href="jav&#x61;script:alert(1)">one</a><a href="java&#10;script:alert(2)">two</a><math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(3)>"></math><a href="https://example.test" target="_self" rel="opener">ok</a>');
  assert.doesNotMatch(safe, /href="javascript|onerror|<math|<style|rel="opener"|target="_self"/i);
  assert.match(safe, /href="https:\/\/example.test" target="_blank" rel="noreferrer noopener"/);
});

test('image rewriting is parsed before URL validation and PDF only permits embedded raster images', () => {
  const seen: string[] = [];
  const safe = sanitizeStatementHtml('<img src="file://photo.png" onload="x()"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="file:///etc/passwd"><iframe src="file:///etc/passwd"></iframe>', {
    embeddedImagesOnly: true,
    rewriteImageUrl: source => { seen.push(source); return source === 'file://photo.png' ? 'data:image/webp;base64,UklGRg==' : source; },
  });
  assert.deepEqual(seen, ['file://photo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'file:///etc/passwd']);
  assert.match(safe, /^<img src="data:image\/webp;base64,UklGRg==" \/>$/);
  assert.doesNotMatch(safe, /file:|svg|iframe|onload/);
});
