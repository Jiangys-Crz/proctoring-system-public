import { z } from 'zod';
import { requireContestSession } from '@/lib/client-contest';
import { isLocalContest } from '@/lib/local-contest';
import { readClientSubmissionHistory } from '@/lib/client-submission-history';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const SubmissionQuerySchema = z.object({
  sessionId: z.string().min(1),
  summaryOnly: z.boolean().optional(),
  submissionId: z.string().min(1).max(191).optional(),
});

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, SubmissionQuerySchema);
    const authorized = await requireContestSession(request, input.sessionId, true);
    if (!authorized.ok) return fail(authorized.message, authorized.status);
    if (isLocalContest(authorized.session.exam)) {
      // The background judge owns Hydro synchronization. Candidate polls read
      // the durable result once and remain responsive when Hydro is slow/down.
      const submissions = await readClientSubmissionHistory(authorized.session, input.summaryOnly, input.submissionId);
      if (input.submissionId) return submissions[0] ? ok(submissions[0]) : fail('提交记录不存在或无权访问', 404);
      return ok(submissions);
    }
    // Submission history is owned by the proctoring database. Never expose
    // Hydro's shared-account history to a candidate, even for legacy exams.
    return input.submissionId ? fail('提交记录不存在或无权访问', 404) : ok([]);
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
