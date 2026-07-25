import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { userFeedbacks } from '@/lib/db/schema';

type CreateUserFeedbackInput = {
  userId: string;
  integrationId?: string | null;
  orgTargetId?: string | null;
  sourcePage: string;
  currentStep?: string | null;
  setupTraceId?: string | null;
  taskId?: string | null;
  recordId?: string | null;
  feedbackText: string;
  metadata?: Record<string, unknown>;
};

export async function createUserFeedback(input: CreateUserFeedbackInput) {
  const db = getDb();
  const [feedback] = await db
    .insert(userFeedbacks)
    .values({
      userId: input.userId,
      integrationId: input.integrationId || null,
      orgTargetId: input.orgTargetId || null,
      sourcePage: input.sourcePage,
      currentStep: input.currentStep || null,
      setupTraceId: input.setupTraceId || null,
      taskId: input.taskId || null,
      recordId: input.recordId || null,
      feedbackText: input.feedbackText,
      metadata: input.metadata || {},
      updatedAt: new Date(),
    })
    .returning();

  return feedback;
}

export async function listUserFeedbacksByUser(userId: string) {
  const db = getDb();
  return db
    .select()
    .from(userFeedbacks)
    .where(eq(userFeedbacks.userId, userId))
    .orderBy(desc(userFeedbacks.createdAt));
}
