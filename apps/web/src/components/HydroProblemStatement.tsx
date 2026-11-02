'use client';

import { ExternalLink } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CodePreview } from './CodeHighlight';
import { sanitizeStatementHtml, statementAttachmentHref } from '@cwnupaa/proctor-shared';

function localizedContent(content: string) {
  const source = content.trim();
  if (!source.startsWith('{') && !source.startsWith('[') && !source.startsWith('"')) return content;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const translations = parsed as Record<string, unknown>;
      for (const key of ['zh-CN', 'zh_CN', 'zh', 'cn', 'default', 'en']) {
        if (typeof translations[key] === 'string') return translations[key] as string;
      }
      const first = Object.values(translations).find((value): value is string => typeof value === 'string');
      if (first) return first;
    }
  } catch { /* Plain Hydro statement. */ }
  return content;
}

function parseSamples(content: string) {
  const samples: Record<string, { input?: string; output?: string }> = {};
  const emitted = new Set<string>();
  const markdown = content.replace(/```(input|output)(\d*)\s*\n([\s\S]*?)```/gi, (_all, kind: string, index: string, value: string) => {
    const key = index || '1';
    samples[key] ||= {};
    samples[key][kind.toLowerCase() as 'input' | 'output'] = value.trimEnd();
    if (emitted.has(key)) return '';
    emitted.add(key);
    return `\n\n[[HYDRO_SAMPLE_${key}]]\n\n`;
  });
  return { markdown, samples };
}

function attachmentUrl(source: string, problemId: string) {
  if (!source || /^(https?:|data:|blob:|\/api\/problems\/)/i.test(source)) return source;
  let name = source.replace(/^file:\/\//i, '').split(/[?#]/, 1)[0].split('/').filter(Boolean).at(-1) || '';
  try { name = decodeURIComponent(name); } catch { /* Keep the source file name. */ }
  return name ? `/api/problems/${encodeURIComponent(problemId)}/file/${encodeURIComponent(name)}` : source;
}

function normalizeHtmlImages(html: string, problemId: string) {
  return sanitizeStatementHtml(html, { rewriteImageUrl: source => attachmentUrl(source, problemId), rewriteLinkUrl: source => statementAttachmentHref(source, problemId) });
}

function MarkdownSegment({ content, problemId }: { content: string; problemId: string }) {
  const parsed = parseSamples(content);
  return <>{parsed.markdown.split(/(\[\[HYDRO_SAMPLE_[^\]]+\]\])/g).map((chunk, index) => {
    const token = chunk.match(/^\[\[HYDRO_SAMPLE_(.+)\]\]$/);
    if (token) {
      const sample = parsed.samples[token[1]] || {};
      return <section className="hydro-sample" key={`sample-${token[1]}-${index}`}><div className="hydro-sample-title">样例 {token[1]}</div><div className="hydro-sample-grid">{sample.input !== undefined ? <div><span>输入</span><CodePreview code={sample.input} language="text" copyable /></div> : null}{sample.output !== undefined ? <div><span>输出</span><CodePreview code={sample.output} language="text" copyable /></div> : null}</div></section>;
    }
    if (!chunk) return null;
    return <div className="hydro-markdown ks-grading-hydro-markdown" key={`markdown-${index}`}><ReactMarkdown
      urlTransform={(url, key, node) => defaultUrlTransform(key === 'src' && node.tagName === 'img' ? attachmentUrl(url, problemId) : key === 'href' ? statementAttachmentHref(url, problemId) : url)}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}<ExternalLink size={12} /></a>,
        img: ({ src, alt }) => <img src={String(src || '')} alt={alt || ''} loading="lazy" />,
        code: ({ className, children }: any) => {
          const source = String(children).replace(/\n$/, '');
          const language = className?.match(/language-([\w.+-]+)/)?.[1] || 'text';
          return className || String(children).includes('\n')
            ? <CodePreview code={source} language={language} showLineNumbers />
            : <code className="hydro-inline-code">{children}</code>;
        },
        pre: ({ children }) => <>{children}</>,
      }}
    >{chunk}</ReactMarkdown></div>;
  })}</>;
}

export function HydroProblemStatement({ content, html, problemId }: { content: string; html: boolean; problemId: string }) {
  const localized = localizedContent(content).replace(/\r\n?/g, '\n');
  if (!localized.trim()) return <div className="exam-overview-empty">暂无题面内容</div>;
  if (html) return <div className="statement-html ks-grading-hydro-html" dangerouslySetInnerHTML={{ __html: normalizeHtmlImages(localized, problemId) }} />;
  return <MarkdownSegment content={localized} problemId={problemId} />;
}
