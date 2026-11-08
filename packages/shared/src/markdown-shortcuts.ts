import type { KeyboardEvent } from 'react';

type Edit = { from: number; to: number; text: string; selectFrom: number; selectTo: number };
const headings = [1, 2, 3, 4, 5, 6] as const;
type Heading = (typeof headings)[number];

export const markdownToolbarActions = [
  { format: 2, label: '标题', keys: 'Ctrl/⌘ + Alt + 2' },
  { format: 'bold', label: '加粗', keys: 'Ctrl/⌘ + B' },
  { format: 'italic', label: '斜体', keys: 'Ctrl/⌘ + I' },
  { format: 'ordered', label: '有序列表', keys: 'Ctrl/⌘ + Shift + 7' },
  { format: 'unordered', label: '无序列表', keys: 'Ctrl/⌘ + Shift + 8' },
  { format: 'quote', label: '引用', keys: 'Ctrl/⌘ + Shift + 9' },
  { format: 'code', label: '行内代码', keys: 'Ctrl/⌘ + E' },
  { format: 'link', label: '链接', keys: 'Ctrl/⌘ + K' },
] as const;
type MarkdownFormat = Heading | (typeof markdownToolbarActions)[number]['format'];

function wrap(value: string, from: number, to: number, marker: string): Edit {
  const selected = value.slice(from, to);
  const start = from - marker.length;
  if (start >= 0 && value.slice(start, from) === marker && value.startsWith(marker, to)) {
    return { from: start, to: to + marker.length, text: selected, selectFrom: start, selectTo: start + selected.length };
  }
  return { from, to, text: marker + selected + marker, selectFrom: from + marker.length, selectTo: to + marker.length };
}

function link(value: string, from: number, to: number): Edit {
  const selected = value.slice(from, to);
  const label = selected || '链接文字';
  const url = 'https://';
  const selectFrom = selected ? from + label.length + 3 : from + 1;
  return { from, to, text: `[${label}](${url})`, selectFrom, selectTo: selectFrom + (selected ? url.length : label.length) };
}

function prefixLines(value: string, from: number, to: number, marker: (index: number) => string): Edit {
  const start = from === 0 ? 0 : value.lastIndexOf('\n', from - 1) + 1;
  const lastSelected = to > from && value[to - 1] === '\n' ? to - 1 : to;
  const nextLine = value.indexOf('\n', lastSelected);
  const end = nextLine === -1 ? value.length : nextLine;
  const lines = value.slice(start, end).split('\n');
  const remove = lines.every((line, index) => line.startsWith(marker(index)));
  const text = lines.map((line, index) => {
    const prefix = marker(index);
    if (remove) return line.slice(prefix.length);
    // Replace a Markdown block marker when switching between block formats.
    return prefix + line.replace(/^(?:#{1,6}|\d+\.|[-+*]|>) /, '');
  }).join('\n');
  const selectFrom = from === to ? Math.max(start, from + text.length - (end - start)) : start;
  return { from: start, to: end, text, selectFrom, selectTo: from === to ? selectFrom : start + text.length };
}

function shortcut(event: KeyboardEvent<HTMLTextAreaElement>): MarkdownFormat | undefined {
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
  if (event.altKey) {
    if (!event.shiftKey && digit) return headings[Number(digit) - 1];
    return;
  }
  if (event.shiftKey) {
    if (digit === '7') return 'ordered';
    if (digit === '8') return 'unordered';
    if (digit === '9') return 'quote';
    return;
  }
  switch (event.key.toLowerCase()) {
    case 'b': return 'bold';
    case 'i': return 'italic';
    case 'e': return 'code';
    case 'k': return 'link';
  }
}

function formatEdit(field: HTMLTextAreaElement, format: MarkdownFormat): Edit {
  const { value, selectionStart: from, selectionEnd: to } = field;
  if (typeof format === 'number') return prefixLines(value, from, to, () => '#'.repeat(format) + ' ');
  switch (format) {
    case 'bold': return wrap(value, from, to, '**');
    case 'italic': return wrap(value, from, to, '*');
    case 'code': return wrap(value, from, to, '`');
    case 'link': return link(value, from, to);
    case 'ordered': return prefixLines(value, from, to, index => `${index + 1}. `);
    case 'unordered': return prefixLines(value, from, to, () => '- ');
    case 'quote': return prefixLines(value, from, to, () => '> ');
  }
}

export function applyMarkdownFormat(field: HTMLTextAreaElement | null, format: MarkdownFormat, onChange: (value: string) => void) {
  if (!field || field.disabled || field.readOnly) return;
  const edit = formatEdit(field, format);
  if (field.maxLength >= 0 && field.value.length - (edit.to - edit.from) + edit.text.length > field.maxLength) return;
  if (field.ownerDocument.activeElement !== field) field.focus();
  field.setSelectionRange(edit.from, edit.to);
  // Native insertion participates in the browser's undo history.
  if (!field.ownerDocument.execCommand?.('insertText', false, edit.text)) {
    field.setRangeText(edit.text, edit.from, edit.to, 'end');
    onChange(field.value);
  }
  field.setSelectionRange(edit.selectFrom, edit.selectTo);
}

export function applyMarkdownShortcut(event: KeyboardEvent<HTMLTextAreaElement>, onChange: (value: string) => void) {
  const field = event.currentTarget;
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey === event.metaKey
    || event.getModifierState('AltGraph') || field.disabled || field.readOnly) return;
  const format = shortcut(event);
  if (format === undefined) return;
  event.preventDefault();
  applyMarkdownFormat(field, format, onChange);
}

export const markdownShortcutHelp = 'Ctrl/⌘ + B 加粗，I 斜体，K 链接，E 行内代码；Ctrl/⌘ + Alt + 1–6 标题；Ctrl/⌘ + Shift + 7 有序列表，8 无序列表，9 引用';
