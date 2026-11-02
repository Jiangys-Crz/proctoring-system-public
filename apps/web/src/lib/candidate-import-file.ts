import { parseCandidateCsv, parseCsvRecords } from './candidate-import';

/** Read the same CSV representation used by candidate imports, preserving displayed IDs. */
export async function readCandidateImportFile(file: Pick<File, 'name' | 'text' | 'arrayBuffer'>) {
  let text: string;
  if (/\.csv$/i.test(file.name)) {
    text = await file.text();
  } else {
    const XLSX = await import('xlsx');
    const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = book.Sheets[book.SheetNames[0]];
    if (!sheet) throw new Error('文件中没有工作表，请使用考生导入模板');
    // Formatted text preserves exam/student numbers such as 0001.
    text = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
  }
  text = text.replace(/^\uFEFF/, '');
  const headers = parseCsvRecords(text)[0] || [];
  const required = [
    ['考号', '比赛账号', 'examNumber'],
    ['密码', '比赛密码', 'password'],
    ['座位号', 'seatNo']
  ];
  const missing = required.filter(names => !names.some(name => headers.includes(name)));
  if (missing.length) throw new Error(`表头缺少${missing.map(names => `“${names[0]}”`).join('、')}，请使用考生导入模板`);
  const rows = parseCandidateCsv(text);
  if (!rows.length) throw new Error('文件中没有考生数据，请在模板表头下填写考生信息');
  return { text, rows };
}
