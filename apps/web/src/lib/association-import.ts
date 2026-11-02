/** Preserve leading zeroes; reject malformed lines instead of silently skipping them. */
export function parseAssociationImport(text: string) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const match = line.match(/^(.+?)\s*(?:[+＋,，\t]|\s+)\s*([^\s+＋,，]+)$/);
    if (!match || !match[1].trim()) throw new Error(`第 ${index + 1} 行请填写姓名＋学号`);
    return { realName: match[1].trim(), numberId: match[2].trim() };
  });
}
