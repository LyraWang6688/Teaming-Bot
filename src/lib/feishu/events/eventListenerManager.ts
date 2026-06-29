import { spawn, ChildProcess } from 'child_process';
import { logFeishuMonitor } from '../common/monitor';
import { getFeishuIntegrationContextById } from '../integration/integrationStore';
import { enqueueFeishuEvent } from '../pipeline/meetingPipelineProcessor';
import { getDb } from '@/lib/db/client';
import { feishuIntegrations } from '@/lib/db/schema';
import { eq, and, isNull, not } from 'drizzle-orm';

type ListenerState = 'stopped' | 'starting' | 'running' | 'error';

interface ListenerInfo {
  integrationId: string;
  profileName: string;
  process: ChildProcess | null;
  state: ListenerState;
  lastError: string | null;
  startedAt: Date | null;
}

const listeners = new Map<string, ListenerInfo>();
const EVENT_TYPE = 'minutes.minute.generated_v1';
const MAX_RESTART_DELAY_MS = 60_000;
const RESTART_BASE_DELAY_MS = 5_000;

function parseNdjson(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function createEnvelopeFromEvent(event: Record<string, unknown>) {
  return {
    schema: event.schema as string | undefined,
    type: event.type as string | undefined,
    challenge: undefined,
    token: event.token as string | undefined,
    header: {
      event_id: event.event_id as string | undefined,
      event_type: event.event_type as string | undefined,
      create_time: event.create_time as string | undefined,
      token: event.token as string | undefined,
    },
    event: event.event as Record<string, unknown> | undefined,
  };
}

async function handleEventLine(line: string, integrationId: string) {
  const event = parseNdjson(line);
  if (!event) {
    return;
  }

  try {
    const integration = await getFeishuIntegrationContextById(integrationId);
    if (!integration) {
      logFeishuMonitor('warn', 'event_listener_integration_not_found', {
        integrationId,
      });
      return;
    }

    const envelope = createEnvelopeFromEvent(event);
    await enqueueFeishuEvent(envelope, integration);
  } catch (error) {
    logFeishuMonitor('error', 'event_listener_handle_event_failed', {
      integrationId,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }
}

function startListenerForIntegration(integrationId: string, profileName: string) {
  const existing = listeners.get(integrationId);
  if (existing && existing.state === 'running') {
    return;
  }

  listeners.set(integrationId, {
    integrationId,
    profileName,
    process: null,
    state: 'starting',
    lastError: null,
    startedAt: new Date(),
  });

  const cliProcess = spawn('lark-cli', [
    'event',
    'consume',
    EVENT_TYPE,
    '--as',
    'user',
    '--profile',
    profileName,
  ], {
    env: {
      ...global.process.env,
      LARKSUITE_CLI_CONFIG_DIR: global.process.env.LARKSUITE_CLI_CONFIG_DIR || '/app/.lark-cli',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  listeners.get(integrationId)!.process = cliProcess;
  listeners.get(integrationId)!.state = 'running';

  logFeishuMonitor('info', 'event_listener_started', {
    integrationId,
    profileName,
    eventType: EVENT_TYPE,
  });

  cliProcess.stdout.on('data', (data: Buffer) => {
    const lines = data.toString('utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      handleEventLine(line, integrationId);
    }
  });

  cliProcess.stderr.on('data', (data: Buffer) => {
    const errorMessage = data.toString('utf-8').trim();
    logFeishuMonitor('warn', 'event_listener_stderr', {
      integrationId,
      message: errorMessage,
    });

    const listener = listeners.get(integrationId);
    if (listener) {
      listener.lastError = errorMessage;
    }
  });

  cliProcess.on('close', (code: number | null, signal: string | null) => {
    logFeishuMonitor('info', 'event_listener_closed', {
      integrationId,
      code,
      signal,
    });

    const listener = listeners.get(integrationId);
    if (!listener) {
      return;
    }

    listener.state = 'stopped';
    listener.process = null;

    if (code !== 0) {
      scheduleRestart(integrationId, profileName);
    }
  });

  cliProcess.on('error', (error: Error) => {
    logFeishuMonitor('error', 'event_listener_error', {
      integrationId,
      message: error.message,
    });

    const listener = listeners.get(integrationId);
    if (listener) {
      listener.state = 'error';
      listener.lastError = error.message;
      listener.process = null;
    }

    scheduleRestart(integrationId, profileName);
  });
}

let restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRestart(integrationId: string, profileName: string) {
  if (restartTimers.has(integrationId)) {
    return;
  }

  const listener = listeners.get(integrationId);
  const restartCount = listener?.startedAt ? 1 : 0;
  const delayMs = Math.min(
    RESTART_BASE_DELAY_MS * Math.pow(2, restartCount),
    MAX_RESTART_DELAY_MS
  );

  logFeishuMonitor('info', 'event_listener_scheduled_restart', {
    integrationId,
    delayMs,
  });

  const timer = setTimeout(() => {
    restartTimers.delete(integrationId);
    startListenerForIntegration(integrationId, profileName);
  }, delayMs);

  restartTimers.set(integrationId, timer);
}

export function stopListener(integrationId: string) {
  const listener = listeners.get(integrationId);
  if (!listener) {
    return;
  }

  if (restartTimers.has(integrationId)) {
    clearTimeout(restartTimers.get(integrationId)!);
    restartTimers.delete(integrationId);
  }

  if (listener.process) {
    listener.process.kill();
    listener.process = null;
  }

  listener.state = 'stopped';

  logFeishuMonitor('info', 'event_listener_stopped', {
    integrationId,
  });
}

export function startListener(integrationId: string) {
  stopListener(integrationId);

  getDb()
    .select({ profileName: feishuIntegrations.profileName })
    .from(feishuIntegrations)
    .where(and(eq(feishuIntegrations.id, integrationId), isNull(feishuIntegrations.deletedAt)))
    .limit(1)
    .then((result) => {
      const profileName = result[0]?.profileName;
      if (!profileName) {
        logFeishuMonitor('warn', 'event_listener_no_profile', {
          integrationId,
        });
        return;
      }

      startListenerForIntegration(integrationId, profileName);
    })
    .catch((error) => {
      logFeishuMonitor('error', 'event_listener_start_failed', {
        integrationId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
}

export async function startAllListeners() {
  try {
    const db = getDb();
    const integrations = await db
      .select({ id: feishuIntegrations.id, profileName: feishuIntegrations.profileName })
      .from(feishuIntegrations)
      .where(and(isNull(feishuIntegrations.deletedAt), not(isNull(feishuIntegrations.profileName))));

    logFeishuMonitor('info', 'event_listener_start_all', {
      count: integrations.length,
    });

    for (const integration of integrations) {
      startListenerForIntegration(integration.id, integration.profileName!);
    }
  } catch (error) {
    logFeishuMonitor('error', 'event_listener_start_all_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function getListenerStatus(integrationId: string): ListenerInfo | undefined {
  return listeners.get(integrationId);
}

export function getAllListenersStatus(): ListenerInfo[] {
  return Array.from(listeners.values());
}
