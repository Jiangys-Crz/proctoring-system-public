import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { sanitizeStatementHtml } from '@cwnupaa/proctor-shared';
import { fetchHydroFile } from './hydro-file-url';

export function statementContainsLink(content: string, href: string): boolean {
  let found = false;
  const sources = [content];
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'string') sources.push(parsed);
    else if (parsed && typeof parsed === 'object') sources.push(...Object.values(parsed).filter((item): item is string => typeof item === 'string'));
  } catch { /* Plain Markdown or HTML. */ }
  for (const source of sources) {
    const tree = unified().use(remarkParse).parse(source);
    function visit(node: { type: string; url?: string; children?: unknown[] }) {
      if (['link', 'definition'].includes(node.type) && node.url === href) found = true;
      for (const child of node.children || []) visit(child as typeof node);
    }
    visit(tree);
    sanitizeStatementHtml(source, { rewriteLinkUrl: url => { if (url === href) found = true; return ''; } });
  }
  return found;
}

export async function fetchStatementDownload(content: string, url: string, baseUrl: string) {
  if (!statementContainsLink(content, url)) throw new Error('下载链接不属于当前题目');
  const response = await fetchHydroFile(url, baseUrl);
  if (!response.ok) throw new Error(`题目文件下载失败（${response.status}）`);
  return response;
}

export function attachmentDisposition(name: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
