import { readFileSync } from 'node:fs';

export function checkWindowsVersion(filename, expected) {
  try {
    const bytes = readFileSync(filename);
    if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('DOS 标头无效');
    const pe = bytes.readUInt32LE(60);
    if (bytes.readUInt32LE(pe) !== 0x4550) throw new Error('PE 标头无效');
    const count = bytes.readUInt16LE(pe + 6);
    const optional = pe + 24;
    const table = optional + bytes.readUInt16LE(pe + 20);
    const magic = bytes.readUInt16LE(optional);
    if (magic !== 0x10b && magic !== 0x20b) throw new Error('PE 可选标头无效');
    const directory = optional + (magic === 0x20b ? 112 : 96) + 16;
    if (directory + 8 > table || table + count * 40 > bytes.length) throw new Error('PE 标头不完整');

    function fileOffset(rva, size) {
      for (let i = 0; i < count; i++) {
        const section = table + i * 40;
        const start = bytes.readUInt32LE(section + 12);
        const length = bytes.readUInt32LE(section + 16);
        const raw = bytes.readUInt32LE(section + 20);
        if (rva >= start && rva + size <= start + length && raw + rva - start + size <= bytes.length) {
          return raw + rva - start;
        }
      }
      throw new Error('资源地址超出文件范围');
    }

    const rva = bytes.readUInt32LE(directory);
    const size = bytes.readUInt32LE(directory + 4);
    const offset = fileOffset(rva, size);
    const resources = bytes.subarray(offset, offset + size);
    function children(target) {
      if (!(target & 0x80000000)) throw new Error('资源目录无效');
      const start = target & 0x7fffffff;
      const entries = resources.readUInt16LE(start + 12) + resources.readUInt16LE(start + 14);
      if (start + 16 + entries * 8 > resources.length) throw new Error('资源目录不完整');
      return Array.from({ length: entries }, (_, i) => ({
        id: resources.readUInt32LE(start + 16 + i * 8),
        target: resources.readUInt32LE(start + 20 + i * 8),
      }));
    }

    const version = children(0x80000000).find(entry => entry.id === 16);
    if (!version) throw new Error('缺少版本资源');
    let checked = 0;
    for (const entry of children(version.target)) {
      for (const language of children(entry.target)) {
        if ((language.target & 0x80000000) || language.target + 16 > resources.length) throw new Error('版本资源层级无效');
        const dataRva = resources.readUInt32LE(language.target);
        const dataSize = resources.readUInt32LE(language.target + 4);
        const position = fileOffset(dataRva, dataSize);
        const data = bytes.subarray(position, position + dataSize);
        const key = Buffer.from('VS_VERSION_INFO\0', 'utf16le');
        const fixed = (6 + key.length + 3) & ~3;
        if (data.length < fixed + 52 || data.readUInt16LE(0) < fixed + 52 || data.readUInt16LE(0) > data.length ||
            data.readUInt16LE(2) !== 52 || data.readUInt16LE(4) !== 0 ||
            !data.subarray(6, 6 + key.length).equals(key) || data.readUInt32LE(fixed) !== 0xfeef04bd) {
          throw new Error('版本信息无效');
        }
        for (const field of [8, 16]) {
          const high = data.readUInt32LE(fixed + field);
          const low = data.readUInt32LE(fixed + field + 4);
          const actual = [high >>> 16, high & 65535, low >>> 16, low & 65535].join('.');
          if (actual !== expected) throw new Error('版本不一致，预期 ' + expected + '，实际 ' + actual);
        }
        checked++;
      }
    }
    if (!checked) throw new Error('版本资源为空');
  } catch (cause) {
    throw new Error('Windows 文件版本校验失败：' + filename, { cause });
  }
}
