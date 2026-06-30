import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function findUserById(userId: string) {
  const db = getDb();
  const result = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return result[0] || null;
}

export async function findUserByFeishuOpenId(openId: string) {
  const db = getDb();
  const result = await db
    .select()
    .from(users)
    .where(eq(users.feishuOpenId, openId))
    .limit(1);

  return result[0] || null;
}

export async function createUserFromFeishu(feishuUser: {
  openId: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  unionId?: string;
}) {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({
      feishuOpenId: feishuUser.openId,
      feishuUnionId: feishuUser.unionId,
      feishuName: feishuUser.name,
      feishuEmail: feishuUser.email,
      feishuAvatarUrl: feishuUser.avatarUrl,
    })
    .returning();

  return user;
}

export async function updateUserFromFeishu(
  userId: string,
  feishuUser: {
    name: string;
    email?: string;
    avatarUrl?: string;
    unionId?: string;
  }
) {
  const db = getDb();
  const [user] = await db
    .update(users)
    .set({
      feishuName: feishuUser.name,
      feishuEmail: feishuUser.email,
      feishuAvatarUrl: feishuUser.avatarUrl,
      feishuUnionId: feishuUser.unionId,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  return user;
}

export async function updateUserIdentityFromFeishu(
  userId: string,
  feishuUser: {
    openId: string;
    name: string;
    email?: string;
    avatarUrl?: string;
    unionId?: string;
  }
) {
  const db = getDb();
  const [user] = await db
    .update(users)
    .set({
      feishuOpenId: feishuUser.openId,
      feishuName: feishuUser.name,
      feishuEmail: feishuUser.email,
      feishuAvatarUrl: feishuUser.avatarUrl,
      feishuUnionId: feishuUser.unionId,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  return user;
}

export async function findOrCreateUserByFeishu(feishuUser: {
  openId: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  unionId?: string;
}) {
  const existing = await findUserByFeishuOpenId(feishuUser.openId);
  if (existing) {
    const updated = await updateUserFromFeishu(existing.id, feishuUser);
    return { user: updated, isNew: false };
  }

  const created = await createUserFromFeishu(feishuUser);
  return { user: created, isNew: true };
}

export function toSafeUser(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    feishuOpenId: user.feishuOpenId,
    name: user.feishuName,
    email: user.feishuEmail,
    avatarUrl: user.feishuAvatarUrl,
  };
}
