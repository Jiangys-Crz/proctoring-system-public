'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Download } from 'lucide-react';

export interface ProctorRecordExam {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  contestType: 'INDIVIDUAL' | 'TEAM';
}

export interface ProctorRecordRow {
  id: string;
  examId: string;
  examName: string;
  createdAt: string;
  isTeam: boolean;
  school: string;
  college: string;
  name: string;
  studentId: string;
  teamName: string;
  memberName: string;
  memberStudentId: string;
  examNumber: string;
  action: '标记作弊' | '取消作弊';
  reason: string;
  operator: string;
}

function csvEscape(value: unknown) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportRows(rows: ProctorRecordRow[], examName?: string) {
  const hasTeam = rows.some((row) => row.isTeam);
  const headers = hasTeam
    ? ['学校', '学院', '队伍名称', '成员姓名', '成员学号', '考号', '操作', '原因', '操作人', '操作时间']
    : ['学校', '学院', '姓名', '学号', '考号', '操作', '原因', '操作人', '操作时间'];
  const csv = [
    headers.join(','),
    ...rows.map((row) =>
      (hasTeam
        ? [
            row.school,
            row.college,
            row.teamName,
            row.memberName,
            row.memberStudentId,
            row.examNumber,
            row.action,
            row.reason,
            row.operator,
            new Date(row.createdAt).toLocaleString()
          ]
        : [
            row.school,
            row.college,
            row.name,
            row.studentId,
            row.examNumber,
            row.action,
            row.reason,
            row.operator,
            new Date(row.createdAt).toLocaleString()
          ])
        .map(csvEscape)
        .join(',')
    )
  ].join('\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `监考记录-${examName || '全部'}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}

export function ProctorRecordsPageClient({ exams, rows }: { exams: ProctorRecordExam[]; rows: ProctorRecordRow[] }) {
  const [selectedExamId, setSelectedExamId] = useState('');
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row) => map.set(row.examId, (map.get(row.examId) || 0) + 1));
    return map;
  }, [rows]);
  const selectedExam = exams.find((exam) => exam.id === selectedExamId) || null;
  const selectedRows = selectedExamId ? rows.filter((row) => row.examId === selectedExamId) : [];
  const hasTeam = selectedRows.some((row) => row.isTeam);

  return (
    <div className="grid">
      <div className="topbar">
        <div>
          <h1 style={{ margin: 0 }}>监考记录</h1>
        </div>
        {selectedExam ? (
          <button className="button" onClick={() => exportRows(selectedRows, selectedExam.name)} disabled={!selectedRows.length}>
            <Download size={18} />
            导出本场
          </button>
        ) : null}
      </div>

      {!selectedExam ? (
        <section className="grid">
          <div className="recording-list-grid">
            {exams.map((exam) => {
              const count = counts.get(exam.id) || 0;
              return (
                <button key={exam.id} className="card proctor-record-exam-card" onClick={() => setSelectedExamId(exam.id)}>
                  <span className="proctor-record-exam-main">
                    <strong>{exam.name}</strong>
                    <span>
                      {formatDateTime(exam.startAt)} - {formatDateTime(exam.endAt)}
                    </span>
                    <b>{count} 条监考记录</b>
                  </span>
                  <ChevronRight size={18} />
                </button>
              );
            })}
          </div>
          {!exams.length ? <div className="card muted">暂无考试</div> : null}
        </section>
      ) : (
        <>
          <div className="return-only-row page-back-row"><button className="button secondary recording-back-button" onClick={() => setSelectedExamId('')}>
            <ArrowLeft size={16} />
            返回考试列表
          </button></div>
        <section className="card">
          <div className="proctor-record-detail-head">
            <div>
              <h2>{selectedExam.name}</h2>
              <div className="muted">
                {formatDateTime(selectedExam.startAt)} - {formatDateTime(selectedExam.endAt)}
              </div>
            </div>
            <div className="proctor-record-count">{selectedRows.length} 条</div>
          </div>
          <div className="table-scroll">
            <table className="table candidate-table">
              <thead>
                <tr>
                  <th>学校</th>
                  <th>学院</th>
                  {hasTeam ? (
                    <>
                      <th>队伍名称</th>
                      <th>成员姓名</th>
                      <th>成员学号</th>
                    </>
                  ) : (
                    <>
                      <th>姓名</th>
                      <th>学号</th>
                    </>
                  )}
                  <th>考号</th>
                  <th>操作</th>
                  <th>原因</th>
                  <th>操作人</th>
                  <th>操作时间</th>
                </tr>
              </thead>
              <tbody>
                {selectedRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.school}</td>
                    <td>{row.college}</td>
                    {hasTeam ? (
                      <>
                        <td>{row.teamName}</td>
                        <td>{row.memberName}</td>
                        <td>{row.memberStudentId}</td>
                      </>
                    ) : (
                      <>
                        <td>{row.name}</td>
                        <td>{row.studentId}</td>
                      </>
                    )}
                    <td>{row.examNumber}</td>
                    <td>{row.action}</td>
                    <td>{row.reason}</td>
                    <td>{row.operator}</td>
                    <td>{formatDateTime(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!selectedRows.length ? <div className="muted">该考试暂无监考记录</div> : null}
        </section></>
      )}
    </div>
  );
}
