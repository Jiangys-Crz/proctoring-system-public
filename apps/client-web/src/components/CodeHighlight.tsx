'use client';

import { useRef, useState } from 'react';

function escapeHtml(value: string) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const keywordGroups: Record<string, string> = {
  c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define',
  cpp: 'alignas alignof auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern float for friend if inline int long namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while include define',
  cc: 'alignas alignof auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern float for friend if inline int long namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while include define',
  python: 'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield True False None',
  py: 'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield True False None',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null',
  js: 'as async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof var void while with yield',
  ts: 'as async await break case catch class const continue debugger default delete do else export extends false finally for from function if implements import in instanceof interface let namespace new null of private protected public readonly return static super switch this throw true try type typeof var void while yield',
  go: 'break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var',
  rs: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
};
function languageKey(language: string) {
  const value = language.toLowerCase().trim();
  const key = value.split('.')[0];
  if (key === 'c++' || key === 'cpp' || key === 'cxx' || key.startsWith('cpp')) return 'cpp';
  if (key === 'c#' || key === 'cs' || key === 'csharp') return 'java';
  if (key === 'py' || key.startsWith('python')) return 'python';
  if (key === 'js' || key.startsWith('javascript')) return 'js';
  if (key === 'ts' || key.startsWith('typescript')) return 'ts';
  return key;
}
export function highlightCode(source: string, language = '') {
  const keywords = new Set((keywordGroups[languageKey(language)] || '').split(/\s+/)); const token = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g; let html = ''; let cursor = 0; let match: RegExpExecArray | null;
  while ((match = token.exec(source))) { html += escapeHtml(source.slice(cursor, match.index)); const value = match[0]; const escaped = escapeHtml(value); let cls = ''; if (/^(\/\/|#|\/\*)/.test(value)) cls = 'code-token-comment'; else if (/^["'`]/.test(value)) cls = 'code-token-string'; else if (/^\d/.test(value)) cls = 'code-token-number'; else if (keywords.has(value)) cls = 'code-token-keyword'; else if (/^[A-Z][A-Za-z0-9_$]*$/.test(value)) cls = 'code-token-type'; html += cls ? `<span class="${cls}">${escaped}</span>` : escaped; cursor = match.index + value.length; }
  return html + escapeHtml(source.slice(cursor));
}

export function CodePreview({ code, language, className = '', copyable = false, toolbarLabel, languageLabel, showLineNumbers = false }: { code: string; language?: string; className?: string; copyable?: boolean; toolbarLabel?: string; languageLabel?: string; showLineNumbers?: boolean }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  function legacyCopy() {
    const textarea = document.createElement('textarea');
    textarea.value = code;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const succeeded = document.execCommand('copy');
    textarea.remove();
    return succeeded;
  }
  async function copy() {
    let succeeded = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        succeeded = true;
      }
    } catch { /* Electron or an insecure local origin may reject Clipboard API. */ }
    if (!succeeded) {
      try { succeeded = legacyCopy(); } catch { succeeded = false; }
    }
    setCopyState(succeeded ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1600);
  }
  const hasToolbar = Boolean(toolbarLabel || languageLabel);
  const lines = code.split('\n');
  const copyLabel = copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制';
  const copyButton = copyable ? <button type="button" className={`code-copy-button ${copyState}`} onClick={event => { event.preventDefault(); event.stopPropagation(); void copy(); }}>{copyLabel}</button> : null;
  return <div className={`code-preview-shell${copyable ? ' code-preview-shell-copyable' : ' code-copy-protected'}${hasToolbar ? ' code-preview-shell-toolbar' : ''} ${className}`} onCopy={copyable ? undefined : event => event.preventDefault()} onCut={copyable ? undefined : event => event.preventDefault()} onDragStart={copyable ? undefined : event => event.preventDefault()} onContextMenu={copyable ? undefined : event => event.preventDefault()}>{hasToolbar ? <div className="code-preview-toolbar">{toolbarLabel ? <span className="code-preview-toolbar-label">{toolbarLabel}</span> : <span />}{languageLabel ? <span className="code-preview-toolbar-language">{languageLabel}</span> : null}{copyButton}</div> : null}<pre className={`code-preview${showLineNumbers ? ' code-preview-with-lines' : ''}`}>{showLineNumbers ? <span className="code-line-numbers" aria-hidden="true">{lines.map((_, index) => <span key={index}>{index + 1}</span>)}</span> : null}<code dangerouslySetInnerHTML={{ __html: highlightCode(code, language) || '&nbsp;' }} /></pre>{copyable && !hasToolbar ? copyButton : null}</div>;
}

export function CodeEditor({ value, onChange, language, placeholder, rows = 18, className = '' }: { value: string; onChange: (value: string) => void; language?: string; placeholder?: string; rows?: number; className?: string }) {
  const previewRef = useRef<HTMLPreElement>(null);
  function syncScroll(event: React.UIEvent<HTMLTextAreaElement>) { if (previewRef.current) { previewRef.current.scrollTop = event.currentTarget.scrollTop; previewRef.current.scrollLeft = event.currentTarget.scrollLeft; } }
  return <div className={`highlight-code-editor code-copy-protected ${className}`} style={{ minHeight: `${Math.max(12, rows) * 1.65}em` }}><pre ref={previewRef} className="highlight-code-editor-preview" aria-hidden="true"><code dangerouslySetInnerHTML={{ __html: highlightCode(value, language) || '&nbsp;' }} /></pre><textarea value={value} onChange={event => onChange(event.target.value)} onScroll={syncScroll} onCopy={event => event.preventDefault()} onCut={event => event.preventDefault()} onDragStart={event => event.preventDefault()} onContextMenu={event => event.preventDefault()} placeholder={placeholder} spellCheck={false} aria-label="代码编辑器" /></div>;
}
