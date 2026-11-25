const fs = require('node:fs');
const [, , input, output] = process.argv;
const header = fs.readFileSync(input, 'utf8');
const lines = ['#pragma once', '// Materialize MinGW UUID traits from the pinned SDK IDL header.'];
for (const match of header.matchAll(/MIDL_INTERFACE\("([0-9a-f-]+)"\)\s+(\w+)\s*:/gi)) {
  const [, guid, type] = match;
  const [a, b, c, d, e] = guid.split('-');
  const parts = [a, b, c, ...(d + e).match(/../g)].map(value => '0x' + value);
  lines.push('__CRT_UUID_DECL(' + type + ', ' + parts.join(', ') + ')');
}
if (lines.length < 100) throw new Error('Expected WebView2 109 SDK interface GUIDs');
fs.writeFileSync(output, lines.join('\n') + '\n');
