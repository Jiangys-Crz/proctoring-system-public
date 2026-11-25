const assert = require('node:assert/strict');
const { test } = require('node:test');
const { hydroBrowserScope, hydroBrowserRequestAllowed, hydroBrowserNavigationAllowed, hydroBrowserInlinePdf,
  hydroBrowserDownloadAllowed, hydroBrowserRecordId } = require('../dist/main/hydro-browser-policy');
const { chromiumPdfViewerResource } = require('../dist/main/contest-page-policy');

const contestId = '6af1ac04ca17daab5e44d1ec';
const scope = hydroBrowserScope('http://127.0.0.1:8888', contestId);

test('Hydro service-worker fetches can load same-origin static assets', () => {
  for (const type of ['script', 'stylesheet', 'font', 'xhr', 'fetch', 'other']) {
    for (const file of ['/theme-4.59.1.css?84a664', '/n.react-dom.8b62dd.chunk.js', '/hydro-icons.woff2?8f76ce']) {
      assert.equal(hydroBrowserRequestAllowed(`${scope.origin}${file}`, type, scope), true, `${type} ${file}`);
    }
  }
});

test('service-worker compatibility preserves contest and origin restrictions', () => {
  for (const type of ['xhr', 'other']) {
    for (const route of ['/manage', '/home/messages', '/api/users', '/p/1', '/contest/000000000000000000000001']) {
      assert.equal(hydroBrowserRequestAllowed(`${scope.origin}${route}`, type, scope), false, `${type} ${route}`);
    }
    assert.equal(hydroBrowserRequestAllowed('https://outside.example/theme.css', type, scope), false);
  }
  for (const type of ['mainFrame', 'subFrame']) {
    assert.equal(hydroBrowserRequestAllowed(`${scope.origin}/n.react-dom.8b62dd.chunk.js`, type, scope), false);
  }
  assert.equal(hydroBrowserRequestAllowed(`${scope.origin}/contest/${contestId}`, 'mainFrame', scope), true);
});

test('XCPCIO embeds and service-worker re-fetches stay bound to the selected scoreboard', () => {
  const origin = scope.origin;
  const frame = source => origin + '/hydro-league-xcpcio/index-20261117logo.html?' + new URLSearchParams({ source });
  for (const base of ['', '/d/system', '/d/school']) {
    const scoped = hydroBrowserScope(origin + base, contestId);
    const prefix = (base || '/d/system') + '/contest/' + contestId + '/scoreboard/';
    const source = prefix + 'xcpcio?json=true&scope=LEAGUE';
    for (const type of ['subFrame', 'xhr', 'other']) assert.ok(hydroBrowserRequestAllowed(frame(source), type, scoped));
    assert.ok(hydroBrowserRequestAllowed(origin + source, 'xhr', scoped));
    assert.ok(hydroBrowserRequestAllowed(origin + '/hydro-league-xcpcio/asset-manifest-20261116e.json', 'xhr', scoped));
    assert.equal(hydroBrowserRequestAllowed(frame(source), 'mainFrame', scoped), false);
    for (const invalid of [source.replace(contestId, '000000000000000000000001'), source.replace(base || '/d/system', '/d/other'),
      'https://outside.example' + source, '/api/v1/scoreboard/xcpcio.json', source + '&all=1', source + '&json=false',
      prefix + 'xcpcio/other?json=true', prefix + 'xcpcio', '/manage']) {
      for (const type of ['subFrame', 'xhr']) assert.equal(hydroBrowserRequestAllowed(frame(invalid), type, scoped), false, invalid);
    }
    assert.equal(hydroBrowserRequestAllowed(frame(source) + '&source=other', 'subFrame', scoped), false);
  }
});

test('DOMjudge mode, previews, runs and downloads use participant routes in this contest', () => {
  const home = scope.origin + '/contest/' + contestId;
  const ui = home + '/domjudge-ui';
  assert.ok(hydroBrowserRequestAllowed(ui, 'mainFrame', scope, 'POST'));
  assert.equal(hydroBrowserRequestAllowed(ui, 'mainFrame', scope, 'GET'), false);
  for (const suffix of ['/booklet.pdf?pid=1', '/samples?pid=2', '/runs/-5/1', '/school-logos/' + 'a'.repeat(64) + '.png']) {
    assert.ok(hydroBrowserRequestAllowed(ui + suffix, 'subFrame', scope, 'GET'));
    assert.equal(hydroBrowserRequestAllowed(ui + suffix, 'xhr', scope, 'POST'), false);
    assert.equal(hydroBrowserRequestAllowed(ui.replace(contestId, '000000000000000000000001') + suffix, 'image', scope), false);
  }
  for (const suffix of ['/settings', '/runs/-1/0', '/runs/team/1', '/samples?tid=other']) {
    assert.equal(hydroBrowserRequestAllowed(ui + suffix, 'xhr', scope), false);
  }
  const attachment = scope.origin + '/p/A/file/statement.PDF?tid=' + contestId;
  assert.ok(hydroBrowserInlinePdf(attachment + '&noDisposition=1', scope));
  assert.ok(hydroBrowserInlinePdf(ui + '/booklet.pdf?pid=1', scope));
  assert.equal(hydroBrowserInlinePdf(attachment, scope), false);
  assert.equal(hydroBrowserInlinePdf(ui + '/samples', scope), false);
  assert.equal(hydroBrowserNavigationAllowed(scope.origin + '/fs/document', scope), false);
  assert.ok(hydroBrowserDownloadAllowed(home, [ui + '/samples'], scope, true));
  assert.ok(hydroBrowserDownloadAllowed(home, [attachment, scope.origin + '/fs/document'], scope, true));
});

test('record ownership checks use the same domain aliases as navigation', () => {
  const rid = '000000000000000000000001';
  for (const base of ['', '/d/system', '/d/school']) {
    const scoped = hydroBrowserScope(scope.origin + base, contestId);
    for (const path of ['', '/d/system', '/d/school', '/d/other']) {
      const url = scope.origin + path + '/record/' + rid;
      const allowed = base === '/d/school' ? path === base : path === '' || path === '/d/system';
      assert.equal(hydroBrowserNavigationAllowed(url, scoped), allowed);
      assert.equal(hydroBrowserRecordId(url, scoped), allowed ? rid : null);
    }
  }
});

test('Chromium PDF component resources are private to its MIME viewer', () => {
  const ext = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
  const viewer = ext + 'index.html';
  assert.ok(chromiumPdfViewerResource(viewer, 'mainFrame', ''));
  for (const resource of [ext + 'main.js', 'chrome://resources/css/roboto.css']) {
    assert.ok(chromiumPdfViewerResource(resource, 'script', viewer));
    assert.equal(chromiumPdfViewerResource(resource, 'script', undefined), false);
    assert.equal(chromiumPdfViewerResource(resource, 'subFrame', viewer), false);
  }
  assert.equal(chromiumPdfViewerResource(viewer, 'mainFrame', undefined), false);
  for (const url of ['chrome://settings/', 'chrome-extension://other/index.html', 'https://outside.example/']) {
    assert.equal(chromiumPdfViewerResource(url, 'script', viewer), false);
  }
});
