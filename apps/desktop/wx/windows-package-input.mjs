import path from 'node:path';
export function windowsPackageInput(args, defaultPayload, defaultOutput) {
  if (![0, 3, 4].includes(args.length) || args.some(value => value.startsWith('--'))) {
    throw new Error('Windows 只生成 x86+x64+ARM64 合并安装包。用法：pnpm dist:desktop:win [<x64 目录> <x86 目录> <ARM64 目录> [输出目录]]');
  }
  const names = ['x64', 'x86', 'arm64'];
  return { names, directories: names.map((name, index) => args.length ? path.resolve(args[index]) : path.join(defaultPayload, name)),
    target: path.resolve(args[3] || defaultOutput) };
}
