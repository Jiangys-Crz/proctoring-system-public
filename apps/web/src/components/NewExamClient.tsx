'use client';

import { useState } from 'react';
import { ExamEditor } from './ExamEditor';
import { ImportPublicExam } from './ImportPublicExam';
export function NewExamClient() {
  const [importing, setImporting] = useState(false);
  return <div className="grid new-exam-page">
    {importing ? <ImportPublicExam onPublish={() => setImporting(false)} /> : <ExamEditor onImport={() => setImporting(true)} />}
  </div>;
}
