const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DomainWindow } = require('../dist/main/network-domain-data');
const { contestPageRequestAllowed } = require('../dist/main/contest-page-policy');

const renderer = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(require.resolve('../src/main/main.ts'), 'utf8');

function routing(serverUrl) {
  const state = { serverUrl, exam: { platformBaseUrl: 'https://oj.example.test' }, session: { id: 'fixture' }, sessionToken: 'private-test-token' };
  const context = vm.createContext({ URL, URLSearchParams, state, window: {} });
  vm.runInContext(renderer.slice(renderer.indexOf('function currentServerHosts()'), renderer.indexOf('function mediaRtmpBase()')), context);
  vm.runInContext(renderer.slice(renderer.indexOf('function isNovaJudgeExam()'), renderer.indexOf('function contestWebsiteUrl()')), context);
  vm.runInContext(renderer.slice(renderer.indexOf('function contestWebsiteUrl()'), renderer.indexOf('function browserNavigationAllowed(')), context);
  return context;
}

test('public contest URLs carry backend identity and keep credentials out of query strings', () => {
  const context = routing('https://proctoring.example.org');
  const url = new URL(context.contestWebsiteUrl());
  assert.equal(url.origin, 'https://proctorstu.example.org');
  assert.equal(url.pathname, '/contest');
  assert.equal(url.searchParams.get('apiBase'), 'https://proctoring.example.org');
  assert.equal(url.searchParams.has('sessionToken'), false);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('sessionToken'), 'private-test-token');
});

test('selected backend permits its student and media domains without permitting the other network', () => {
  for (const suffix of ['example.test', 'example.org']) {
    const context = routing(`https://proctoring.${suffix}`);
    assert.equal(context.contestWebsiteOrigin(), `https://proctorstu.${suffix}`);
    const hosts = Array.from(context.currentServerHosts());
    const observations = new DomainWindow();
    observations.add([`proctorstu.${suffix}`, `proctorstream.${suffix}`, `proctorrtc.${suffix}`, 'outside.example.test'].map(domain => ({ domain, source: 'DNS 查询' })));
    assert.deepEqual(observations.snapshot(hosts), ['outside.example.test（DNS 查询）']);
    assert.equal(hosts.includes(`proctorrtc.${suffix === 'example.test' ? 'example.org' : 'example.test'}`), false);
  }
});

test('intranet contest URLs keep the internal student page and backend paired', () => {
  const url = new URL(routing('https://proctoring.example.test').contestWebsiteUrl());
  assert.equal(url.origin, 'https://proctorstu.example.test');
  assert.equal(url.pathname, '/contest');
  assert.equal(url.searchParams.get('apiBase'), 'https://proctoring.example.test');
  assert.equal(url.searchParams.has('sessionToken'), false);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('sessionToken'), 'private-test-token');
});

test('embedded student page may call backend client APIs without opening backend pages', () => {
  // Exercise the main-process request gate with the production host allowlist.
  const start = main.indexOf('function isAllowedUrl(');
  const end = main.indexOf('function buildServerUrl(', start);
  const source = main.slice(start, end).replace(/url: string/g, 'url').replace(/let parsed: URL;/g, 'let parsed;');
  const context = vm.createContext({ URL, process, contestPageRequestAllowed,
    allowedHosts: new Set(['proctoring.example.org', 'proctorstu.example.org', 'oj.example.test']),
    contestClientScope: { host: 'proctorstu.example.org', origin: 'https://proctorstu.example.org' },
    contestScope: { host: 'oj.example.test', contestId: 'fixture' },
    novaJudgeScope: null,
  });
  vm.runInContext(source, context);
  assert.equal(context.isAllowedUrl('https://proctorstu.example.org/contest', 'mainFrame'), true);
  assert.equal(context.isAllowedUrl('https://proctorstu.example.org/candidate-assets/_next/static/chunk.js', 'script'), true);
  assert.equal(context.isAllowedUrl('https://proctoring.example.org/api/client/contest', 'xhr'), true);
  assert.equal(context.isAllowedUrl('https://proctoring.example.org/dashboard', 'mainFrame'), false);
  assert.equal(context.isAllowedUrl('https://proctoring.example.org/api/settings/storage', 'xhr'), false);
  assert.equal(context.isAllowedUrl('https://outside.example.test/contest', 'mainFrame'), false);
});
