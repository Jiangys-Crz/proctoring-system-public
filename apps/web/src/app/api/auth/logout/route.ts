import { fail, options } from '@/lib/http';
import { NextResponse } from 'next/server';
import { AuthError, clearSessionCookie, requireTrustedMutation } from '@/lib/auth';

export async function POST(request: Request) {
  try { requireTrustedMutation(request); }
  catch (error) { if (error instanceof AuthError) return fail(error.message, error.status); throw error; }
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}

export const OPTIONS = options;
