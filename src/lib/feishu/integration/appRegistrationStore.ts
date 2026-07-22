import { randomUUID } from 'crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  FEISHU_APPLICATION_SETUP_SCOPES,
  FEISHU_REQUIRED_USER_EVENTS,
  FEISHU_REQUIRED_USER_SCOPES,
} from './integrationConstants';

export type AppRegistrationStatus =
  | 'starting'
  | 'pending'
  | 'completed'
  | 'finalizing'
  | 'finalized'
  | 'failed'
  | 'expired';

export type AppRegistrationTask = {
  sessionToken: string;
  userId: string;
  status: AppRegistrationStatus;
  verificationUrl: string | null;
  expiresAt: number;
  result: {
    appId: string;
    appSecret: string;
    creatorOpenId: string | null;
  } | null;
  integrationId: string | null;
  error: string | null;
  startedAt: Date;
};

const STORE_KEY = '__feishu_sdk_app_registration_store';

function getStore(): Map<string, AppRegistrationTask> {
  const globalStore = globalThis as Record<string, unknown>;
  if (!globalStore[STORE_KEY]) {
    globalStore[STORE_KEY] = new Map<string, AppRegistrationTask>();
  }
  return globalStore[STORE_KEY] as Map<string, AppRegistrationTask>;
}

function toSafeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const sdkError = error as {
      code?: unknown;
      description?: unknown;
      response?: {
        data?: {
          code?: unknown;
          msg?: unknown;
        };
      };
    };
    if (typeof sdkError.description === 'string' && sdkError.description) {
      return sdkError.code === 'access_denied'
        ? '用户取消了应用创建，请重新发起。'
        : sdkError.description;
    }
    if (sdkError.response?.data?.code === 99991672) {
      return '飞书应用自动配置权限未生效，请删除未完成应用后重新创建。';
    }
    if (typeof sdkError.response?.data?.msg === 'string') {
      return '飞书应用自动配置失败，请重新创建；若仍失败，请联系管理员查看服务日志。';
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return message || '飞书应用创建失败，请重新发起。';
}

export async function startAppRegistration(
  userId: string,
  onCompleted?: (sessionToken: string) => Promise<void>
): Promise<AppRegistrationTask> {
  const sessionToken = randomUUID();
  const task: AppRegistrationTask = {
    sessionToken,
    userId,
    status: 'starting',
    verificationUrl: null,
    expiresAt: Date.now() + 10 * 60_000,
    result: null,
    integrationId: null,
    error: null,
    startedAt: new Date(),
  };
  getStore().set(sessionToken, task);

  let resolveQr: ((task: AppRegistrationTask) => void) | null = null;
  const qrReady = new Promise<AppRegistrationTask>((resolve) => {
    resolveQr = resolve;
  });

  void lark
    .registerApp({
      createOnly: true,
      appPreset: {
        name: 'Teaming 会议分析-{user}',
        desc: '自动监听飞书妙记生成事件，并将会议分析结果关联到组织多维表格。',
      },
      addons: {
        preset: false,
        scopes: {
          tenant: [...FEISHU_APPLICATION_SETUP_SCOPES],
          user: [...FEISHU_REQUIRED_USER_SCOPES],
        },
        events: {
          items: {
            user: [...FEISHU_REQUIRED_USER_EVENTS],
          },
        },
      },
      onQRCodeReady: (info) => {
        task.status = 'pending';
        task.verificationUrl = info.url;
        task.expiresAt = Date.now() + Math.max(info.expireIn, 60) * 1000;
        resolveQr?.(task);
        resolveQr = null;
      },
    })
    .then(async (result) => {
      task.status = 'completed';
      task.result = {
        appId: result.client_id,
        appSecret: result.client_secret,
        creatorOpenId: result.user_info?.open_id || null,
      };
      if (onCompleted) {
        try {
          await onCompleted(sessionToken);
        } catch (error) {
          // The finalizer has failed terminally. Do not put the task back into
          // `completed`, otherwise the next frontend poll claims and repeats
          // the same application configuration/publish request.
          task.status = 'failed';
          task.error = toSafeError(error);
        }
      }
    })
    .catch((error) => {
      task.status = Date.now() > task.expiresAt ? 'expired' : 'failed';
      task.error = toSafeError(error);
      resolveQr?.(task);
      resolveQr = null;
    });

  const timeout = new Promise<AppRegistrationTask>((resolve) => {
    setTimeout(() => resolve(task), 8_000);
  });
  const readyTask = await Promise.race([qrReady, timeout]);
  if (!readyTask.verificationUrl) {
    throw new Error(readyTask.error || '未能获取飞书应用创建链接，请重新发起。');
  }
  return readyTask;
}

export function getAppRegistrationTask(sessionToken: string): AppRegistrationTask | null {
  const task = getStore().get(sessionToken) || null;
  if (!task) return null;
  if (task.status === 'pending' && Date.now() > task.expiresAt) {
    task.status = 'expired';
    task.error = '创建应用会话已过期，请重新发起。';
  }
  return task;
}

export function claimAppRegistrationFinalization(sessionToken: string): AppRegistrationTask | null {
  const task = getAppRegistrationTask(sessionToken);
  if (!task || task.status !== 'completed' || !task.result) {
    return null;
  }
  task.status = 'finalizing';
  return task;
}

export function finishAppRegistrationFinalization(
  sessionToken: string,
  integrationId: string
): void {
  const task = getStore().get(sessionToken);
  if (!task) return;
  task.integrationId = integrationId;
  task.status = 'finalized';
  task.result = null;
  task.error = null;
}

export function recordAppRegistrationIntegration(
  sessionToken: string,
  integrationId: string
): void {
  const task = getStore().get(sessionToken);
  if (!task) return;
  task.integrationId = integrationId;
}

export function failAppRegistrationFinalization(sessionToken: string, error: unknown): void {
  const task = getStore().get(sessionToken);
  if (!task) return;
  // Finalization failures are terminal for this registration task. Keeping
  // the task as `completed` causes every frontend poll to retry the same
  // application configuration request and flood production logs.
  task.status = 'failed';
  task.error = toSafeError(error);
}
