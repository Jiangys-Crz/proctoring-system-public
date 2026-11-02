import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultApiBase, trustedApiBase } from '../src/lib/api';

function atPage(url: string | null, run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    if (url) Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: new URL(url) } });
    else Reflect.deleteProperty(globalThis, 'window');
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('student website defaults to backend port 4031 on the current host', () => {
  atPage('http://localhost:4032/', () => {
    assert.equal(defaultApiBase(''), 'http://localhost:4031');
  });
  atPage('http://192.168.50.30:4032/', () => {
    assert.equal(defaultApiBase(''), 'http://192.168.50.30:4031');
  });
  atPage(null, () => assert.equal(defaultApiBase(''), 'http://localhost:4031'));
});

test('explicit deployment URLs and HTTPS proxy entrances keep their configured routing', () => {
  atPage('http://localhost:4032/', () => {
    assert.equal(defaultApiBase('https://api.example.test/'), 'https://api.example.test');
    assert.equal(defaultApiBase('http://127.0.0.1:5000/'), 'http://localhost:5000');
  });
  atPage('https://192.168.50.30:3443/', () => {
    assert.equal(defaultApiBase(''), 'https://192.168.50.30:3443');
    assert.equal(defaultApiBase('http://localhost:4031'), 'https://192.168.50.30:3443');
  });
});

test('public student pages and QR codes use the backend API, never an arbitrary service', () => {
  atPage('https://proctorstu.example.org/contest', () => {
    assert.equal(defaultApiBase(''), 'https://proctoring.example.org');
    assert.equal(trustedApiBase('', 'https://proctoring.example.org/'), 'https://proctoring.example.org');
    assert.throws(() => trustedApiBase('', 'https://attacker.example.test'), /平台/);
    assert.equal(defaultApiBase('https://custom-api.example.test'), 'https://custom-api.example.test');
  });
});
