import { cookies } from 'next/headers';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { createOpaqueToken } from '@/lib/security/crypto';
import { findUserById, toSafeUser } from './userStore';

const SESSION_COOKIE_NAME = 'teaming_session';
const SESSION_DURATION_DAYS = 30;

export async function createSession(userId: string): Promise<string> {
  const sessionToken = createOpaqueToken(48);
  const expiresAt = new Date(
    Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000
  );

  const db = getDb();
  await db.insert(sessions).values({
    userId,
    sessionToken,
    expiresAt,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60,
  });

  return sessionToken;
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionToken) {
    return null;
  }

  const db = getDb();
  const result = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.sessionToken, sessionToken),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const [session] = result;
  const user = await findUserById(session.userId);
  if (!user) {
    return null;
  }

  await db
    .update(sessions)
    .set({ lastActiveAt: new Date() })
    .where(eq(sessions.id, session.id));

  return toSafeUser(user);
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (sessionToken) {
    const db = getDb();
    await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken));
  }

  cookieStore.delete(SESSION_COOKIE_NAME);
}

export const SESSION_COOKIE = SESSION_COOKIE_NAME;
