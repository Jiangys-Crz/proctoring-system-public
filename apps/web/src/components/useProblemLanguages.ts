'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { allowedProblemLanguages, type HydroLanguage } from '@/lib/exam-languages';

export function useProblemLanguages(problem: { config: Record<string, unknown> } | null, lang: string, setLang: (value: string) => void) {
  const [available, setAvailable] = useState<HydroLanguage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const type = String(problem?.config?.type || 'default');
  const objective = ['objective', 'submit_answer'].includes(type);
  useEffect(() => {
    if (!problem || objective) return;
    let mounted = true;
    setLoading(true); setError('');
    api<HydroLanguage[]>('/api/hydro/languages').then(rows => { if (mounted) setAvailable(rows); })
      .catch(error => { if (mounted) setError(error instanceof Error ? error.message : '语言列表读取失败，请刷新重试'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [problem, objective]);
  const languages = useMemo(() => problem ? allowedProblemLanguages({ problemType: type, languages: problem.config.langs }, [], available) : [], [problem, type, available]);
  useEffect(() => { if (languages.length && !languages.includes(lang)) setLang(languages[0]); }, [languages, lang, setLang]);
  return { languages, languageNames: Object.fromEntries(available.map(item => [item.id, item.name])), loading,
    error: error || (problem && !objective && !loading && !languages.length ? '评测服务没有启用本题支持的语言，请联系管理员' : '') };
}
