'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, RefreshCw, Trash2 } from 'lucide-react';
import { FileCleanupStatus } from './FileCleanupStatus';
import { api } from './api';
import { AlertEvidencePlayer, evidenceStatus, type AlertEvidence } from './AlertEvidencePlayer';

interface RecordingItem {
  id: string;
  name: string;
  message: string;
  type: string;
  objectPath: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  evidence?: AlertEvidence;
}

interface RecordingCandidate {
  id: string;
  name: string | null;
  teamName: string | null;
  examNumber: string;
  seatNo: string;
  recordingCount: number;
  recordings: RecordingItem[];
}

interface RecordingRoom {
  id: string;
  name: string;
  recordingCount: number;
  candidates: RecordingCandidate[];
}

interface RecordingExam {
  canDelete: boolean; mediaCount: number; bytes: number; cleanupPending: number; cleanupFailed: number;
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  recordingCount: number;
  rooms: RecordingRoom[];
}

interface RecordingPage {
  items: RecordingItem[];
  total: number;
  page: number;
  pageSize: number;
}

const RECORDING_PAGE_SIZE = 20;

function displayCandidate(candidate: RecordingCandidate) {
  return candidate.teamName || candidate.name || candidate.examNumber;
}

function safeName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '未命名';
}

function fileExt(url: string) {
  const pathname = new URL(url, window.location.href).pathname;
  const match = pathname.match(/\.[a-z0-9]+$/i);
  return match?.[0] || '.webm';
}

export function RecordingsPageClient() {
  const [exams, setExams] = useState<RecordingExam[]>([]);
  const [selectedExamId, setSelectedExamId] = useState('');
  const [selectedRoomId, setSelectedRoomId] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [selectedExportKeys, setSelectedExportKeys] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [loadingCandidateId, setLoadingCandidateId] = useState('');
  const [loadedVideoIds, setLoadedVideoIds] = useState<string[]>([]);
  const [recordingPage, setRecordingPage] = useState(1);
  const [deleting, setDeleting] = useState(false);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      setExams(await api<RecordingExam[]>('/api/recordings'));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!exams.some(exam => exam.cleanupPending > 0)) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [exams.some(exam => exam.cleanupPending > 0)]);

  const selectedExam = useMemo(() => exams.find((exam) => exam.id === selectedExamId) || null, [exams, selectedExamId]);
  const selectedRoom = useMemo(() => selectedExam?.rooms.find((room) => room.id === selectedRoomId) || null, [selectedExam, selectedRoomId]);
  const selectedCandidate = useMemo(
    () => selectedRoom?.candidates.find((candidate) => candidate.id === selectedCandidateId) || null,
    [selectedCandidateId, selectedRoom]
  );

  useEffect(() => {
    if (!selectedCandidateId || !selectedCandidate?.recordings.some((item) => item.evidence?.pending)) return;
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy) return;
      busy = true;
      void loadCandidateRecordings(selectedCandidateId, { page: recordingPage })
        .catch((err) => setError(err instanceof Error ? err.message : '录像刷新失败'))
        .finally(() => { busy = false; });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [selectedCandidateId, recordingPage, selectedCandidate?.recordings.some((item) => item.evidence?.pending)]);

  function enterExam(id: string) {
    setSelectedExportKeys([]);
    setLoadedVideoIds([]);
    setSelectedExamId(id);
  }

  function enterRoom(id: string) {
    setSelectedExportKeys([]);
    setLoadedVideoIds([]);
    setSelectedRoomId(id);
  }

  async function loadCandidateRecordings(candidateId: string, options: { loadAll?: boolean; page?: number } = {}) {
    const loadAll = options.loadAll === true;
    const page = options.page || 1;
    setLoadingCandidateId(candidateId);
    try {
      const suffix = loadAll ? '&all=1' : `&page=${page}&pageSize=${RECORDING_PAGE_SIZE}`;
      const result = await api<RecordingPage>(`/api/recordings?candidateId=${encodeURIComponent(candidateId)}${suffix}`);
      if (!loadAll) {
        setExams((items) => items.map((exam) => ({
          ...exam,
          rooms: exam.rooms.map((room) => ({
            ...room,
            candidates: room.candidates.map((candidate) => candidate.id === candidateId ? { ...candidate, recordings: result.items, recordingCount: result.total } : candidate)
          }))
        })));
      }
      return result.items;
    } finally {
      setLoadingCandidateId((currentId) => currentId === candidateId ? '' : currentId);
    }
  }

  function enterCandidate(id: string) {
    setSelectedExportKeys([]);
    setLoadedVideoIds([]);
    setRecordingPage(1);
    setSelectedCandidateId(id);
    void loadCandidateRecordings(id, { page: 1 });
  }

  function goBack() {
    setSelectedExportKeys([]);
    setLoadedVideoIds([]);
    if (selectedCandidateId) {
      setSelectedCandidateId('');
      return;
    }
    if (selectedRoomId) {
      setSelectedRoomId('');
      return;
    }
    setSelectedExamId('');
  }

  function toggleExportKey(key: string, checked: boolean) {
    setSelectedExportKeys((keys) => (checked ? Array.from(new Set([...keys, key])) : keys.filter((item) => item !== key)));
  }

  type CandidateContext = { exam: RecordingExam; room: RecordingRoom; candidate: RecordingCandidate };

  async function entriesForContexts(contexts: CandidateContext[]) {
    const rows = await Promise.all(contexts.map(async ({ exam, room, candidate }) => {
      const recordings = await loadCandidateRecordings(candidate.id, { loadAll: true });
      return recordings.map((recording) => ({ exam, room, candidate: { ...candidate, recordings }, recording }));
    }));
    return rows.flat();
  }

  function contextsForExam(exam: RecordingExam) {
    return exam.rooms.flatMap((room) => room.candidates.map((candidate) => ({ exam, room, candidate })));
  }

  function contextsForRoom(exam: RecordingExam, room: RecordingRoom) {
    return room.candidates.map((candidate) => ({ exam, room, candidate }));
  }

  async function currentSelectedEntries() {
    if (selectedCandidate && selectedRoom && selectedExam) {
      return selectedCandidate.recordings
        .filter((recording) => selectedExportKeys.includes(`recording:${recording.id}`))
        .map((recording) => ({ exam: selectedExam, room: selectedRoom, candidate: selectedCandidate, recording }));
    }
    if (selectedRoom && selectedExam) {
      return entriesForContexts(contextsForRoom(selectedExam, selectedRoom).filter(({ candidate }) => selectedExportKeys.includes(`candidate:${candidate.id}`)));
    }
    if (selectedExam) {
      return entriesForContexts(contextsForExam(selectedExam).filter(({ room }) => selectedExportKeys.includes(`room:${room.id}`)));
    }
    return entriesForContexts(exams.filter((exam) => selectedExportKeys.includes(`exam:${exam.id}`)).flatMap(contextsForExam));
  }

  async function exportEntries(entries?: Array<{ exam: RecordingExam; room: RecordingRoom; candidate: RecordingCandidate; recording: RecordingItem }>) {
    const resolvedEntries = entries || await currentSelectedEntries();
    const validEntries = resolvedEntries.filter((entry) => entry.recording.evidence?.segments.length || entry.recording.objectPath);
    if (!validEntries.length) {
      window.alert('当前选择中没有可导出的视频');
      return;
    }
    setExporting(true);
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      await Promise.all(
        validEntries.map(async ({ exam, room, candidate, recording }) => {
          const folder = `${safeName(exam.name)}/${safeName(room.name)}/${safeName(candidate.examNumber)}-${safeName(displayCandidate(candidate))}/${safeName(recording.name)}-${safeName(recording.id)}`;
          const segments = recording.evidence?.segments.length ? recording.evidence.segments : [
            { id: recording.id, objectPath: recording.objectPath as string, startedAt: recording.createdAt, endedAt: null, channel: '历史录像' }
          ];
          const descriptions = [`异常时间：${recording.createdAt}`, `取证范围：${recording.evidence?.windowStart || '未知'} 至 ${recording.evidence?.windowEnd || '未知'}`, evidenceStatus(recording.evidence), '以下为连续取证所用原始片段，首尾片段可能包含窗口之外的少量画面。', ''];
          for (const [index, segment] of segments.entries()) {
            const response = await fetch(segment.objectPath);
            if (!response.ok) throw new Error('视频下载失败');
            const filename = `${String(index + 1).padStart(2, '0')}-${safeName(segment.channel)}-${safeName(segment.id)}${fileExt(segment.objectPath)}`;
            zip.file(`${folder}/${filename}`, await response.blob());
            descriptions.push(`${filename}：${segment.startedAt} 至 ${segment.endedAt || '未知'}`);
          }
          zip.file(`${folder}/录像说明.txt`, descriptions.join('\n'));
        })
      );
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `历史录像-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }

  async function exportContexts(contexts: CandidateContext[]) {
    await exportEntries(await entriesForContexts(contexts));
  }

  async function removeRecordings(input: { examIds: string[] } | { alertIds: string[] }, description: string) {
    if (!window.confirm(`确认永久删除${description}？将清理监考录像及异常截图，保留考试成绩、考生资料和异常日志。共用片段会保留供其他异常查看。文件清理后无法恢复。`)) return;
    setDeleting(true); setError(''); setMessage('');
    try {
      await api('/api/recordings', { method: 'DELETE', body: JSON.stringify(input) });
      setSelectedExportKeys([]); setLoadedVideoIds([]); setRevision(r => r + 1);
      if ('examIds' in input) { setSelectedCandidateId(''); setSelectedRoomId(''); setSelectedExamId(''); }
      await load();
      if ('alertIds' in input && selectedCandidateId) { setRecordingPage(1); await loadCandidateRecordings(selectedCandidateId, { page: 1 }); }
      setMessage('录像记录已删除，文件正在后台清理。');
    } catch (error) { setError(error instanceof Error ? error.message : '删除失败'); }
    finally { setDeleting(false); }
  }
  const selectedDeletionExams = exams.filter(e => e.canDelete && selectedExportKeys.includes(`exam:${e.id}`));
  const selectedDeletionAlerts = selectedCandidate?.recordings.filter(r => selectedExportKeys.includes(`recording:${r.id}`)) || [];

  async function changeRecordingPage(page: number) {
    if (!selectedCandidate || page < 1 || page > Math.ceil(selectedCandidate.recordingCount / RECORDING_PAGE_SIZE)) return;
    setRecordingPage(page);
    setLoadedVideoIds([]);
    await loadCandidateRecordings(selectedCandidate.id, { page });
  }

  return (
    <div className="grid">
      {selectedExam ? (
        <div className="return-only-row"><button className="button secondary recording-back-button" onClick={goBack}>
          <ArrowLeft size={18} />
          返回上一级
        </button></div>
      ) : null}
      <div className="topbar">
        <div>
          <h1 style={{ margin: 0 }}>历史录像</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {selectedDeletionExams.length > 0 && <button className="button secondary" disabled={deleting || exporting || selectedDeletionExams.length > 20} onClick={() => void removeRecordings({ examIds: selectedDeletionExams.map(e => e.id) }, `所选 ${selectedDeletionExams.length} 场考试的全部录像`)}><Trash2 size={18} />删除所选考试录像</button>}
          {selectedExam?.canDelete && selectedDeletionAlerts.length > 0 && <button className="button secondary" disabled={deleting || exporting} onClick={() => void removeRecordings({ alertIds: selectedDeletionAlerts.map(r => r.id) }, `所选 ${selectedDeletionAlerts.length} 条异常录像`)}>删除所选录像</button>}
          <button className="button" onClick={() => void exportEntries()} disabled={!selectedExportKeys.length || exporting || deleting}>
            <Download size={18} />
            {exporting ? '导出中' : `导出已选${selectedExportKeys.length ? ` ${selectedExportKeys.length}` : ''}`}
          </button>
          <button className="button secondary" onClick={() => void (selectedCandidateId
            ? loadCandidateRecordings(selectedCandidateId, { page: recordingPage }).catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
            : load())}>
            <RefreshCw size={18} />
            刷新
          </button>
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>比赛管理员可删除已结束考试的录像，单次最多选择 20 场考试。整场删除包含完整录像与异常片段，身份照片和环境审核视频会保留。</p>
      {message && <div className="card" role="status">{message}</div>}
      <FileCleanupStatus kind="MEDIA" revision={revision} />
      {error ? <div className="card" style={{ color: 'var(--danger)' }}>{error}</div> : null}

      {!selectedExam ? (
        <section className="recording-list-grid">
          {exams.map((exam) => (
            <article className="card recording-nav-card" key={exam.id}>
              <label className="recording-select">
                <input
                  type="checkbox"
                  checked={selectedExportKeys.includes(`exam:${exam.id}`)}
                  onChange={(event) => toggleExportKey(`exam:${exam.id}`, event.target.checked)}
                />
                选择
              </label>
              <button className="recording-card-main" onClick={() => enterExam(exam.id)}>
                <strong>{exam.name}</strong>
                <span>{new Date(exam.startAt).toLocaleString()} - {new Date(exam.endAt).toLocaleString()}</span>
                <b>{exam.recordingCount} 条异常记录 · {exam.mediaCount} 个视频片段</b><span>{(exam.bytes / 1024 ** 3).toFixed(2)} GiB</span>
              </button>
              <button className="button secondary compact-button" onClick={() => void exportContexts(contextsForExam(exam))} disabled={!exam.recordingCount || exporting}>
                导出考试
              </button>
              {exam.canDelete && <button className="button secondary compact-button" disabled={deleting || exporting || !exam.mediaCount && !exam.recordingCount} onClick={() => void removeRecordings({ examIds: [exam.id] }, `“${exam.name}”的全部录像`)}><Trash2 size={15} />删除整场录像</button>}
              {exam.cleanupPending > 0 && <span className="muted">{exam.cleanupPending} 个文件待清理{exam.cleanupFailed ? `，${exam.cleanupFailed} 个将重试` : ''}</span>}
            </article>
          ))}
          {!exams.length ? <div className="card muted">暂无历史录像</div> : null}
        </section>
      ) : null}

      {selectedExam && !selectedRoom ? (
        <section className="recording-list-grid">
          {selectedExam.canDelete && <div className="card"><button className="button secondary" disabled={deleting || exporting} onClick={() => void removeRecordings({ examIds: [selectedExam.id] }, `“${selectedExam.name}”的全部录像`)}>删除本场全部录像</button><span className="muted"> 包含 {selectedExam.mediaCount} 个视频片段</span></div>}
          {selectedExam.rooms.map((room) => (
            <article className="card recording-nav-card" key={room.id}>
              <label className="recording-select">
                <input
                  type="checkbox"
                  checked={selectedExportKeys.includes(`room:${room.id}`)}
                  onChange={(event) => toggleExportKey(`room:${room.id}`, event.target.checked)}
                />
                选择
              </label>
              <button className="recording-card-main" onClick={() => enterRoom(room.id)}>
                <strong>{room.name}</strong>
                <span>{room.candidates.length} 个考号</span>
                <b>{room.recordingCount} 条录像</b>
              </button>
              <button className="button secondary compact-button" onClick={() => void exportContexts(contextsForRoom(selectedExam, room))} disabled={!room.recordingCount || exporting}>
                导出考室
              </button>
            </article>
          ))}
          {!selectedExam.rooms.length ? <div className="card muted">该考试暂无异常录像</div> : null}
        </section>
      ) : null}

      {selectedRoom && !selectedCandidate ? (
        <section className="recording-list-grid">
          {selectedRoom.candidates.map((candidate) => (
            <article className="card recording-nav-card" key={candidate.id}>
              <label className="recording-select">
                <input
                  type="checkbox"
                  checked={selectedExportKeys.includes(`candidate:${candidate.id}`)}
                  onChange={(event) => toggleExportKey(`candidate:${candidate.id}`, event.target.checked)}
                />
                选择
              </label>
              <button className="recording-card-main" onClick={() => enterCandidate(candidate.id)}>
                <strong>{displayCandidate(candidate)}</strong>
                <span>考号：{candidate.examNumber} / 座位：{candidate.seatNo}</span>
                <b>{candidate.recordingCount} 条录像</b>
              </button>
              <button
                className="button secondary compact-button"
                onClick={() => selectedExam && selectedRoom && void exportContexts([{ exam: selectedExam, room: selectedRoom, candidate }])}
                disabled={!candidate.recordingCount || exporting}
              >
                导出考生
              </button>
            </article>
          ))}
          {!selectedRoom.candidates.length ? <div className="card muted">该考室暂无异常录像</div> : null}
        </section>
      ) : null}

      {selectedCandidate ? (
        <section className="recording-grid">
          {loadingCandidateId === selectedCandidate.id ? <div className="card muted">正在加载该考生的录像…</div> : null}
          {selectedCandidate.recordings.map((recording) => (
            <article className="card grid" key={recording.id}>
              <div>
                <label className="recording-select">
                  <input
                    type="checkbox"
                    checked={selectedExportKeys.includes(`recording:${recording.id}`)}
                    onChange={(event) => toggleExportKey(`recording:${recording.id}`, event.target.checked)}
                  />
                  选择
                </label>
                <strong>{recording.name}</strong>
                <div className="muted">{new Date(recording.createdAt).toLocaleString()}</div>
                <div className="muted">{recording.acknowledgedAt ? '已处理' : '未处理'}</div>
                <div className="muted">{evidenceStatus(recording.evidence)}</div>
                <button
                  className="button secondary compact-button recording-single-export"
                  onClick={() => selectedExam && selectedRoom && void exportEntries([{ exam: selectedExam, room: selectedRoom, candidate: selectedCandidate, recording }])}
                  disabled={(!recording.objectPath && !recording.evidence?.segments.length) || exporting}
                >
                  导出视频
                </button>
                {selectedExam?.canDelete && <button className="button secondary compact-button" disabled={deleting || exporting} onClick={() => void removeRecordings({ alertIds: [recording.id] }, `“${recording.name}”的录像`)}>删除录像</button>}
              </div>
              <div className="recording-media">
                {recording.objectPath || recording.evidence?.segments.length ? (
                  loadedVideoIds.includes(recording.id) ? (
                    <AlertEvidencePlayer key={recording.id} evidence={recording.evidence} fallback={recording.objectPath} />
                  ) : (
                    <button
                      type="button"
                      className="recording-empty recording-load-button"
                      onClick={() => setLoadedVideoIds((ids) => [...ids, recording.id])}
                    >
                      点击加载录像
                    </button>
                  )
                ) : (
                  <div className="recording-empty">暂无视频</div>
                )}
              </div>
            </article>
          ))}
          {!selectedCandidate.recordings.length && loadingCandidateId !== selectedCandidate.id ? <div className="card muted">该考号暂无异常录像</div> : null}
          {selectedCandidate.recordingCount > RECORDING_PAGE_SIZE ? (
            <div className="recording-pagination card">
              <button className="button secondary" onClick={() => void changeRecordingPage(recordingPage - 1)} disabled={recordingPage <= 1 || loadingCandidateId === selectedCandidate.id}>上一页</button>
              <span>第 {recordingPage} / {Math.ceil(selectedCandidate.recordingCount / RECORDING_PAGE_SIZE)} 页</span>
              <button className="button secondary" onClick={() => void changeRecordingPage(recordingPage + 1)} disabled={recordingPage >= Math.ceil(selectedCandidate.recordingCount / RECORDING_PAGE_SIZE) || loadingCandidateId === selectedCandidate.id}>下一页</button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
