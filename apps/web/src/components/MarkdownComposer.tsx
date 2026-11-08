'use client';

import { memo, useRef, useState, type RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { applyMarkdownFormat, applyMarkdownShortcut, markdownShortcutHelp, markdownToolbarActions } from '@cwnupaa/proctor-shared/markdown-shortcuts';
import { Bold, Code2, Heading2, ImagePlus, Italic, Link2, List, ListOrdered, Quote } from 'lucide-react';

const formatIcons = { 2: Heading2, bold: Bold, italic: Italic, ordered: ListOrdered, unordered: List, quote: Quote, code: Code2, link: Link2 };

export function MarkdownFormatButtons({ editor, onChange, disabled }: {
  editor: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return markdownToolbarActions.map(({ format, label, keys }) => {
    const Icon = formatIcons[format];
    return <button key={format} type="button" aria-label={label} title={`${label}（${keys}）`} disabled={disabled}
      onMouseDown={event => event.preventDefault()} onClick={() => applyMarkdownFormat(editor.current, format, onChange)}>
      <Icon size={15} aria-hidden="true" />
    </button>;
  });
}

export const MarkdownContent = memo(function MarkdownContent({ content, className = '' }: { content: string; className?: string }) {
  return <div className={`qa-markdown ${className}`}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ a: ({ children, node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>, img: ({ src, alt }) => <img src={String(src || '')} alt={alt || '答疑图片'} loading="lazy" /> }}>{content}</ReactMarkdown></div>;
});

export function MarkdownComposer({ value, onChange, onUploadImage, placeholder, disabled = false, maxLength = 10000, rows = 7 }: {
  value: string; onChange: (value: string) => void; onUploadImage?: (file: File) => Promise<string>;
  placeholder?: string; disabled?: boolean; maxLength?: number; rows?: number;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  async function upload(files: File[]) {
    if (!onUploadImage || disabled) return;
    const images = files.filter(file => file.type.startsWith('image/')); if (!images.length || uploading) return;
    const start = editor.current?.selectionStart ?? value.length; const end = editor.current?.selectionEnd ?? start;
    setUploading(true); setError('');
    try { const markdown: string[] = []; for (const file of images) markdown.push(`![${file.name || '图片'}](${await onUploadImage(file)})`); const current = editor.current?.value ?? value; const insertion = `\n${markdown.join('\n\n')}\n`; onChange(`${current.slice(0, start)}${insertion}${current.slice(end)}`.slice(0, maxLength)); requestAnimationFrame(() => editor.current?.focus()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '图片上传失败'); }
    finally { setUploading(false); }
  }
  return <div className="qa-markdown-composer">
    <div className="qa-markdown-toolbar">
      <strong title={markdownShortcutHelp}>Markdown</strong>
      <div role="group" aria-label="Markdown 格式">
        <MarkdownFormatButtons editor={editor} onChange={onChange} disabled={disabled || uploading} />
        {onUploadImage ? <button type="button" title="上传图片" onClick={() => fileInput.current?.click()} disabled={disabled || uploading}><ImagePlus size={15} />{uploading ? '上传中' : '图片'}</button> : null}
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} />
      </div>
    </div>
    <div className="qa-markdown-live"><textarea ref={editor} rows={rows} maxLength={maxLength} value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (!uploading) applyMarkdownShortcut(event, onChange); }} onPaste={event => { const files = Array.from(event.clipboardData.files); if (onUploadImage && !disabled && files.some(file => file.type.startsWith('image/'))) { event.preventDefault(); void upload(files); } }} placeholder={placeholder} disabled={disabled} /><div className="qa-markdown-preview" aria-label="内容预览"><MarkdownContent content={value} /></div></div>
    <div className="qa-markdown-status"><span>{value.length}/{maxLength}</span>{error ? <b>{error}</b> : null}</div>
  </div>;
}
