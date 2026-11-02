'use client';

import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Bold, Code2, Heading2, ImagePlus, Link2, List } from 'lucide-react';

export function MarkdownContent({ content, className = '' }: { content: string; className?: string }) {
  return <div className={`qa-markdown ${className}`}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ a: ({ children, node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>, img: ({ src, alt }) => <img src={String(src || '')} alt={alt || '答疑图片'} loading="lazy" /> }}>{content}</ReactMarkdown></div>;
}

export function MarkdownComposer({ value, onChange, onUploadImage, placeholder, disabled = false, maxLength = 10000, rows = 7 }: {
  value: string; onChange: (value: string) => void; onUploadImage: (file: File) => Promise<string>;
  placeholder?: string; disabled?: boolean; maxLength?: number; rows?: number;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  function insert(before: string, after = '', fallback = '') {
    const element = editor.current; if (!element) return;
    const start = element.selectionStart; const end = element.selectionEnd; const selected = value.slice(start, end) || fallback;
    onChange(`${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`.slice(0, maxLength));
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }
  async function upload(files: File[]) {
    const images = files.filter(file => file.type.startsWith('image/')); if (!images.length || uploading) return;
    const start = editor.current?.selectionStart ?? value.length; const end = editor.current?.selectionEnd ?? start;
    setUploading(true); setError('');
    try { const markdown: string[] = []; for (const file of images) markdown.push(`![${file.name || '图片'}](${await onUploadImage(file)})`); const current = editor.current?.value ?? value; const insertion = `\n${markdown.join('\n\n')}\n`; onChange(`${current.slice(0, start)}${insertion}${current.slice(end)}`.slice(0, maxLength)); requestAnimationFrame(() => editor.current?.focus()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '图片上传失败'); }
    finally { setUploading(false); }
  }
  return <div className="qa-markdown-composer"><div className="qa-markdown-toolbar"><strong>Markdown</strong><div><button type="button" title="标题" onClick={() => insert('## ', '', '标题')}><Heading2 size={15} /></button><button type="button" title="粗体" onClick={() => insert('**', '**', '文字')}><Bold size={15} /></button><button type="button" title="列表" onClick={() => insert('- ', '', '列表项')}><List size={15} /></button><button type="button" title="代码" onClick={() => insert('`', '`', 'code')}><Code2 size={15} /></button><button type="button" title="链接" onClick={() => insert('[', '](https://)', '链接文字')}><Link2 size={15} /></button><button type="button" title="上传图片" onClick={() => fileInput.current?.click()} disabled={uploading}><ImagePlus size={15} />{uploading ? '上传中' : '图片'}</button><input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} /></div></div><div className="qa-markdown-live"><textarea ref={editor} rows={rows} maxLength={maxLength} value={value} onChange={event => onChange(event.target.value)} onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.some(file => file.type.startsWith('image/'))) { event.preventDefault(); void upload(files); } }} placeholder={placeholder} disabled={disabled} /><div className="qa-markdown-preview" aria-label="内容预览"><MarkdownContent content={value} /></div></div><div className="qa-markdown-status"><span>{value.length}/{maxLength}</span>{error ? <b>{error}</b> : null}</div></div>;
}
