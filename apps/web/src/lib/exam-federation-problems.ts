import { z } from 'zod';
import { FederationError } from './exam-federation-protocol';

export const PROBLEM_MAPPING_CAPABILITY = 'problem-mapping';
const mappingSchema = z.array(z.object({
  order: z.number().int().min(0), localNumber: z.string().min(1).max(191), remoteNumber: z.string().min(1).max(191),
}).strict()).max(10000);
export type ProblemMapping = z.infer<typeof mappingSchema>;
type Problem = { order: number; hydroProblemId: string };

/** The hub's Hydro number is the stable wire identity. Only the edge translates
 * it; all local judging continues to use ExamProblem.hydroProblemId. Legacy
 * connections without a mapping retain their original equal-number behavior. */
export function syncProblemNumber(config: { role: string; problemMapping: unknown }) {
  if (config.problemMapping == null) return (problem: Problem) => problem.hydroProblemId;
  const parsed = mappingSchema.safeParse(config.problemMapping);
  if (config.role !== 'EDGE' || !parsed.success || new Set(parsed.data.map(p => p.order)).size !== parsed.data.length) {
    throw new FederationError('跨网题号映射无效，请重新核对同步设置');
  }
  const byOrder = new Map(parsed.data.map(p => [p.order, p]));
  return (problem: Problem) => {
    const mapping = byOrder.get(problem.order);
    if (!mapping || mapping.localNumber !== problem.hydroProblemId) throw new FederationError('本地题目与已绑定的跨网题号映射不一致');
    return mapping.remoteNumber;
  };
}
