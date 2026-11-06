import type { ReactionExportSummary, ReactionItemView } from './reaction-types';

type GenerationItem = Pick<ReactionItemView, 'status' | 'generationStatus' | 'cameraPath' | 'desktopPath'>;

export function canGenerateReaction(item: GenerationItem): boolean {
  return ['COMPLETE', 'COMPLETED', 'PARTIAL'].includes(item.status)
    && Boolean(item.desktopPath && (item.status === 'PARTIAL' || item.cameraPath))
    && !['QUEUED', 'RUNNING', 'GENERATING'].includes(item.generationStatus);
}

export function reactionSubmissionLabel(item: Pick<ReactionItemView, 'submissionId'>): string {
  return item.submissionId;
}

export function reactionExportBlockReason(summary?: ReactionExportSummary): string | null {
  if (!summary) return '正在读取本场导出信息';
  if (!summary.generatedCount) return '本场暂无已生成的竖屏视频';
  if (summary.invalidSubmissionIds) return `有 ${summary.invalidSubmissionIds} 个已生成视频的 Submission UUID 无效，无法导出，请检查原始提交记录`;
  return null;
}
