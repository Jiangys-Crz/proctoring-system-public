const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { hydroBrowserScope, hydroBrowserNavigationAllowed } = require('../dist/main/hydro-browser-policy');

const contestId = '6af1ac04ca17daab5e44d1ec';
const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');

function browser(baseUrl = 'http://127.0.0.1:8888') {
  const state = { exam: { platform: 'HYDRO_BROWSER', platformBaseUrl: baseUrl, platformContestId: contestId } };
  const home = `${baseUrl}/contest/${contestId}`;
  const view = Object.assign(new EventTarget(), { dataset: {}, src: home, getURL() { return this.src; }, canGoForward: () => false });
  const nodes = { ojView: view, browserUrl: {}, browserBackBtn: {}, browserForwardBtn: {} };
  const context = vm.createContext({ URL, URLSearchParams, state, $: id => nodes[id], window: { setTimeout: fn => fn() } });
  vm.runInContext(source.slice(source.indexOf('function isNovaJudgeExam()'), source.indexOf('\nasync function api(')), context);
  vm.runInContext(source.slice(source.indexOf('function contestParentUrl()'), source.indexOf('function startClock(')), context);
  return { context, nodes, home, scope: hydroBrowserScope(baseUrl, contestId) };
}

test('Hydro back button stays in the contest from submit, problem, record and scoreboard pages', () => {
  for (const baseUrl of ['http://127.0.0.1:8888', 'https://hydro.example/d/school']) {
    const { context, nodes, home, scope } = browser(baseUrl);
    const cases = [
      [`/p/HL1/submit?tid=${contestId}&lang=cc`, `${baseUrl}/p/HL1?tid=${contestId}`],
      [`/p/HL1?tid=${contestId}#statement`, `${home}/problems`],
      [`/p/4?tid=${contestId}`, `${home}/problems`],
      [`/p/HL1/file/sample.zip?tid=${contestId}`, `${baseUrl}/p/HL1?tid=${contestId}`],
      ['/record/000000000000000000000001', `${home}/problems`],
      [`/record?tid=${contestId}`, `${home}/problems`],
      [`/record?tid=${contestId}&uidOrName=5`, `${home}/problems`],
      [`/contest/${contestId}/`, `${home}/problems`],
      [`/contest/${contestId}/scoreboard?group=all`, `${home}/problems`],
      [`/contest/${contestId}/scoreboard/xcpcio`, `${home}/problems`],
      [`/contest/${contestId}/scoreboard/leagueboard`, `${home}/problems`],
      [`/contest/${contestId}/scoreboard/league-xcpcio`, `${home}/problems`],
      [`/contest/${contestId}/scoreboard/all`, `${home}/scoreboard`],
    ];
    for (const [route, expected] of cases) {
      nodes.ojView.src = baseUrl + route;
      context.updateBrowserHistoryButtons();
      assert.equal(nodes.browserBackBtn.disabled, false, route);
      context.navigateContestHistory('back');
      assert.equal(nodes.ojView.src, expected, route);
      assert.equal(hydroBrowserNavigationAllowed(nodes.ojView.src, scope), true, route);
    }
  }
});

test('repeated Hydro back stops at the problem list', () => {
  const { context, nodes, home } = browser();
  nodes.ojView.src = `http://127.0.0.1:8888/p/HL1/submit?tid=${contestId}`;
  for (const expected of [`http://127.0.0.1:8888/p/HL1?tid=${contestId}`, `${home}/problems`, `${home}/problems`]) {
    context.navigateContestHistory('back');
    assert.equal(nodes.ojView.src, expected);
  }
  assert.equal(nodes.browserBackBtn.disabled, true);
});

test('Back from a DOMjudge or default-domain plugin page returns to the configured contest', () => {
  const { context, nodes, home } = browser();
  const alias = home.replace('/contest/', '/d/system/contest/');
  for (const [url, parent] of [
    [alias + '/scoreboard/xcpcio', home + '/problems'],
    [alias + '/domjudge-ui/runs/-5/1', home + '/scoreboard'],
    [alias + '/domjudge-ui/booklet.pdf?pid=1', home + '/problems'],
  ]) {
    nodes.ojView.src = url;
    context.navigateContestHistory('back');
    assert.equal(nodes.ojView.src, parent);
  }
});

test('XCPCIO iframe navigation keeps the main scoreboard address and Back returns to the problem list', () => {
  const origin = 'http://127.0.0.1:8888';
  const { context, nodes, home } = browser(origin + '/d/system');
  const view = nodes.ojView;
  const scoreboard = `${origin}/contest/${contestId}/scoreboard/xcpcio`;
  context.installWebviewGuards();

  view.src = scoreboard + '?scope=LEAGUE';
  view.dispatchEvent(Object.assign(new Event('did-navigate'), { url: view.src }));
  assert.equal(nodes.browserUrl.textContent, scoreboard);
  const source = `${home}/scoreboard/xcpcio?json=true&scope=LEAGUE`;
  const frame = `${origin}/hydro-league-xcpcio/index-20261117logo.html?${new URLSearchParams({ source })}#/rank`;
  view.dispatchEvent(Object.assign(new Event('did-navigate-in-page'), { url: frame, isMainFrame: false }));
  assert.equal(nodes.browserUrl.textContent, scoreboard);
  assert.equal(nodes.browserUrl.title, scoreboard);
  assert.equal(nodes.browserBackBtn.disabled, false);

  context.navigateContestHistory('back');
  assert.equal(view.src, home + '/problems');
  view.dispatchEvent(Object.assign(new Event('did-navigate-in-page'), { url: view.src + '#problems', isMainFrame: true }));
  assert.equal(nodes.browserUrl.textContent, home + '/problems');
  assert.equal(nodes.browserBackBtn.disabled, true);
  context.navigateContestHistory('back');
  assert.equal(view.src, home + '/problems');
});

test('Hydro back is disabled for blank, login, other contest, domain and origin pages', () => {
  const baseUrl = 'https://hydro.example/d/school';
  const { context, nodes, home } = browser(baseUrl);
  for (const url of ['about:blank', `${home}/problems`, `${baseUrl}/login`, `${baseUrl}/p/HL1`, `${baseUrl}/record`,
    `${baseUrl}/p/HL1?tid=000000000000000000000001`, `${baseUrl}/p/HL1?tid=${contestId}&tid=other`,
    `${baseUrl}/contest/000000000000000000000001/problems`,
    `https://hydro.example/d/other/p/HL1?tid=${contestId}`, `https://outside.example/p/HL1?tid=${contestId}`]) {
    nodes.ojView.src = url;
    context.updateBrowserHistoryButtons();
    assert.equal(nodes.browserBackBtn.disabled, true, url);
    context.navigateContestHistory('back');
    assert.equal(nodes.ojView.src, url);
  }
});

test('NovaJudge and built-in contest parent navigation retain their existing behavior', () => {
  const { context, nodes, home } = browser();
  context.state.exam.platform = 'NOVAJUDGE';
  nodes.ojView.src = `${home}/problems/A`;
  context.navigateContestHistory('back');
  assert.equal(nodes.ojView.src, `${home}/problems`);
  context.state.exam.platform = 'HYDRO';
  context.contestWebsiteOrigin = () => 'https://student.example';
  nodes.ojView.src = 'https://student.example/contest/problem/A?sessionId=fixture';
  context.navigateContestHistory('back');
  assert.equal(nodes.ojView.src, 'https://student.example/contest/problem?sessionId=fixture');
});

test('NovaJudge previews only the current contest editorial and goes back to its parent page', () => {
  const { novaJudgeRequestAllowed, novaJudgeFileUrl, novaJudgeInlinePdf } = require('../dist/main/novajudge-policy');
  const { context, nodes } = browser();
  const scope = { origin: 'http://127.0.0.1:8888', contestId: '16' };
  Object.assign(context.state.exam, { platform: 'NOVAJUDGE', platformContestId: '16' });
  const editorial = scope.origin + '/api/contests/16/editorial';
  assert.ok(novaJudgeInlinePdf(editorial, scope));
  for (const type of ['mainFrame', 'subFrame']) {
    assert.ok(novaJudgeRequestAllowed(editorial, type, scope));
    for (const url of [editorial.replace('/16/', '/17/'), editorial + '/meta', editorial.replace('8888', '8889')]) {
      assert.equal(novaJudgeRequestAllowed(url, type, scope), false);
    }
  }
  const booklet = scope.origin + '/api/contests/16/problemset/statement.pdf';
  assert.ok(novaJudgeFileUrl(booklet, scope));
  assert.equal(novaJudgeInlinePdf(booklet, scope), false);
  nodes.ojView.src = editorial;
  context.navigateContestHistory('back');
  assert.equal(nodes.ojView.src, scope.origin + '/contest/16/editorial');
});
