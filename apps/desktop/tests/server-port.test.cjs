const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const start = source.indexOf('function contestWebsiteOrigin()');
const end = source.indexOf('function mobileWebsiteOrigin()', start);
const originFunction = source.slice(start, end);

function candidateOrigin(serverUrl, configured = '') {
  const context = vm.createContext({
    URL,
    state: { serverUrl },
    window: { PROCTOR_CLIENT_WEB_URL: configured },
  });
  vm.runInContext(originFunction, context);
  return context.contestWebsiteOrigin();
}

test('desktop clients derive student port 4032 from backend port 4031', () => {
  assert.equal(candidateOrigin('http://localhost:4031'), 'http://localhost:4032');
  assert.equal(candidateOrigin('https://exam.example.test:4031'), 'https://exam.example.test:4032');
});

test('public and intranet contest websites use the corresponding student domains', () => {
  assert.equal(candidateOrigin('https://proctoring.example.org'), 'https://proctorstu.example.org');
  assert.equal(candidateOrigin('https://proctoring.example.test'), 'https://proctorstu.example.test');
  assert.equal(candidateOrigin('https://legacy-proctor.example.test'), 'https://legacy-proctor.example.test');
});

test('explicit student websites and existing deployment addresses remain usable', () => {
  assert.equal(candidateOrigin('http://localhost:4031', 'https://candidate.example.test/contest'), 'https://candidate.example.test');
  assert.equal(candidateOrigin('http://localhost:3100'), 'http://localhost:3200');
  assert.equal(candidateOrigin('http://localhost:3310'), 'http://localhost:3320');
  assert.equal(candidateOrigin('https://exam.example.test'), 'https://exam.example.test');
});
