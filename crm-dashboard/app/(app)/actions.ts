'use server';

import { cookies } from 'next/headers';
import { WORKSPACE_COOKIE } from '@/lib/env';

/** Remember which workspace the user is looking at (validated again on every request). */
export async function switchWorkspace(workspaceId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return;
  const store = await cookies();
  store.set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
}
