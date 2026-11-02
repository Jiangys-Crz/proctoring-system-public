'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Search, X } from 'lucide-react';

export type SearchOption = { id: string; label: string; description?: string };
export function ExamSearchSelect({ label, placeholder, value, onChange, search }: {
  label: string; placeholder: string; value: SearchOption[];
  onChange: (items: SearchOption[]) => void;
  search: (query: string, signal: AbortSignal) => Promise<SearchOption[]>;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SearchOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const options = items.filter(item => !value.some(selected => selected.id === item.id));
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setItems([]); setActive(0);
    const timer = window.setTimeout(async () => {
      try {
        const result = await search(query, controller.signal);
        if (!controller.signal.aborted) setItems(result);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '搜索失败，请重试');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, open, search]);
  function select(item: SearchOption) {
    onChange([...value, item]); setQuery(''); setActive(0); input.current?.focus();
  }
  return <div className="exam-select" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <label htmlFor={id}>{label}</label>
    <div className="exam-select-input" onClick={() => input.current?.focus()}>
      {value.map(item => <span className="exam-selected-tag" key={item.id}>{item.label}<button type="button" aria-label={`移除${item.label}`} onClick={() => onChange(value.filter(option => option.id !== item.id))}><X size={13} /></button></span>)}
      <div className="exam-select-query"><Search size={16} /><input ref={input} id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-results`} aria-autocomplete="list" aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined} autoComplete="off" placeholder={placeholder} value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(index => Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
        if (event.key === 'Enter') { event.preventDefault(); if (open && options[active]) select(options[active]); }
      }} /></div>
    </div>
    {open ? <div className="exam-select-dropdown" id={`${id}-results`} role="listbox" aria-label={label}>
      {loading ? <div className="exam-select-message"><LoaderCircle className="spin" size={16} /> 正在搜索…</div> : error ? <div className="exam-select-message exam-error" role="alert">{error}</div> : options.length ? options.map((item, index) => <button type="button" role="option" aria-selected={index === active} id={`${id}-${index}`} className={index === active ? 'is-active' : ''} key={item.id} onMouseDown={event => event.preventDefault()} onClick={() => select(item)}><strong>{item.label}</strong>{item.description ? <small>{item.description}</small> : null}</button>) : <div className="exam-select-message">没有匹配结果，请尝试其他关键词</div>}
    </div> : null}
    <small className="exam-field-help">已选择 {value.length} 项，可继续搜索添加</small>
  </div>;
}
