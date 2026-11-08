import crypto from 'node:crypto';
import { z } from 'zod';
import { requiredEnv } from './env';
import { LoginFlowError } from './room-login-policy';

const TicketSchema = z.object({
  purpose: z.literal('desktop-login-materials'),
  pairCode: z.string().regex(/^\d{6}$/), examId: z.string().min(1), candidateId: z.string().min(1),
  memberStudentId: z.string().nullable(), memberName: z.string().nullable(), expiresAt: z.number().int()
});
export type CredentialTicket = z.infer<typeof TicketSchema>;

export function signCredentialTicket(ticket: CredentialTicket) {
  const payload = Buffer.from(JSON.stringify(TicketSchema.parse(ticket))).toString('base64url');
  const signature = crypto.createHmac('sha256', requiredEnv('SESSION_SECRET')).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readCredentialTicket(value: string, now = Date.now()) {
  const parts = value.split('.');
  if (parts.length !== 2 || value.length > 4096) throw new LoginFlowError('第二机位登录凭证无效，请在电脑重新登录', 401);
  const [payload, signature] = parts;
  const expected = crypto.createHmac('sha256', requiredEnv('SESSION_SECRET')).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new LoginFlowError('第二机位登录凭证无效，请在电脑重新登录', 401);
  let ticket: CredentialTicket;
  try { ticket = TicketSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString())); }
  catch { throw new LoginFlowError('第二机位登录凭证无效，请在电脑重新登录', 401); }
  if (ticket.expiresAt <= now) throw new LoginFlowError('第二机位登录凭证已过期，请在电脑重新登录', 401);
  return ticket;
}

export function credentialMember(candidate: {
  name: string | null; studentId: string | null; teamMembers: string | null; teamMemberStudentIds: string | null;
}, name: string, team: boolean) {
  return { memberName: candidate.name || (candidate.teamMembers || '').split(/[、,，;；\s]+/).filter(Boolean)[0] || '',
    memberStudentId: candidate.studentId || (candidate.teamMemberStudentIds || '').split(/[、,，;；\s]+/).filter(Boolean)[0] || null };
}
