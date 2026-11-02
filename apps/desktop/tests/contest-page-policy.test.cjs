const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contestPageRequestAllowed } = require('../dist/main/contest-page-policy');
const origin = 'https://legacy-proctor.example.test';
const allowed = (path, type) => contestPageRequestAllowed(new URL(path, origin).toString(), type, origin);

test('contest documents and framework route fetches remain inside the selected origin', () => {
  for (const type of ['mainFrame', 'subFrame', 'xhr', 'fetch']) {
    assert.equal(allowed('/contest?sessionId=test', type), true);
    assert.equal(allowed('/contest/overview?_rsc=fixture', type), true);
    assert.equal(allowed('/dashboard', type), false);
    assert.equal(allowed('/contestant', type), false);
  }
  assert.equal(contestPageRequestAllowed('https://proctoring.example.org/contest', 'mainFrame', origin), false);
  assert.equal(contestPageRequestAllowed('http://legacy-proctor.example.test/contest', 'xhr', origin), false);
});
test('student scripts, styles, fonts and logos load without allowing asset frame navigation', () => {
  for (const path of ['/_next/static/chunks/page.js', '/candidate-assets/_next/static/chunks/page.js', '/candidate-assets/_next/static/media/font.woff2']) {
    for (const type of ['script', 'stylesheet', 'font', 'xhr']) assert.equal(allowed(path, type), true);
    assert.equal(allowed(path, 'mainFrame'), false);
    assert.equal(allowed(path, 'subFrame'), false);
  }
  assert.equal(allowed('/candidate-assets/brand/logo.png', 'image'), true);
  assert.equal(allowed('/candidate-assets/brand/logo.png', 'mainFrame'), false);
  assert.equal(allowed('/_next/server/app/page.js', 'script'), false);
  assert.equal(allowed('/candidate-assets/_next/server/app/page.js', 'script'), false);
});
test('only client API requests are available to the contest page', () => {
  assert.equal(allowed('/api/client/contest?sessionId=fixture', 'xhr'), true);
  assert.equal(allowed('/api/client/contest/submissions', 'fetch'), true);
  assert.equal(allowed('/api/settings/desktop-releases', 'xhr'), false);
  assert.equal(allowed('/api/client-admin', 'xhr'), false);
  assert.equal(allowed('/api/client/contest', 'mainFrame'), false);
  assert.equal(allowed('/candidate', 'mainFrame'), false);
});
