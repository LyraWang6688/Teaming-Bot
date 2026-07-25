import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { createUserFeedback } from '@/lib/feedback/feedbackStore';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

const submitFeedbackSchema = z.object({
  sourcePage: z.string().trim().min(1, '缺少页面信息').max(512, '页面信息过长'),
  currentStep: z.string().trim().max(120, '步骤信息过长').optional(),
  integrationId: z.uuid('integrationId 格式不正确').optional().nullable(),
  orgTargetId: z.uuid('orgTargetId 格式不正确').optional().nullable(),
  taskId: z.string().trim().max(120, 'taskId 过长').optional().nullable(),
  recordId: z.string().trim().max(120, 'recordId 过长').optional().nullable(),
  feedbackText: z.string().trim().min(1, '请先填写问题描述').max(4000, '问题描述过长'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    logRuntimeMonitor('warn', 'feedback_api', 'feedback_submit_rejected_unauthenticated');
    return NextResponse.json(
      { success: false, error: '请先登录后再提交反馈。' },
      { status: 401 }
    );
  }

  const parsed = submitFeedbackSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    logRuntimeMonitor('warn', 'feedback_api', 'feedback_submit_validation_failed', {
      userId: user.id,
      issueCount: parsed.error.issues.length,
      firstIssue: parsed.error.issues[0]?.message,
    });
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || '反馈内容不完整。' },
      { status: 400 }
    );
  }

  const trace = getRequestTraceContext(request);

  try {
    const feedback = await createUserFeedback({
      userId: user.id,
      integrationId: parsed.data.integrationId || null,
      orgTargetId: parsed.data.orgTargetId || null,
      sourcePage: parsed.data.sourcePage,
      currentStep: parsed.data.currentStep || null,
      setupTraceId: trace.setupTraceId || null,
      taskId: parsed.data.taskId || null,
      recordId: parsed.data.recordId || null,
      feedbackText: parsed.data.feedbackText,
      metadata: {
        ...(parsed.data.metadata || {}),
        requestSetupTraceId: trace.setupTraceId || null,
        userAgent: request.headers.get('user-agent') || null,
      },
    });

    logRuntimeMonitor('info', 'feedback_api', 'feedback_submit_succeeded', {
      feedbackId: feedback.id,
      userId: user.id,
      integrationId: feedback.integrationId,
      orgTargetId: feedback.orgTargetId,
      sourcePage: feedback.sourcePage,
      currentStep: feedback.currentStep,
      setupTraceId: feedback.setupTraceId,
      taskId: feedback.taskId,
      recordId: feedback.recordId,
    });

    return NextResponse.json({
      success: true,
      data: {
        id: feedback.id,
        createdAt: feedback.createdAt,
      },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'feedback_api', 'feedback_submit_failed', {
      userId: user.id,
      integrationId: parsed.data.integrationId || null,
      orgTargetId: parsed.data.orgTargetId || null,
      sourcePage: parsed.data.sourcePage,
      currentStep: parsed.data.currentStep || null,
      setupTraceId: trace.setupTraceId,
      taskId: parsed.data.taskId || null,
      recordId: parsed.data.recordId || null,
      ...toRuntimeErrorContext(error),
    });
    throw error;
  }
}
