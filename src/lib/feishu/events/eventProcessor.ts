import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { enqueueFeishuEvent } from '../pipeline/meetingPipelineProcessor';
import { getFeishuIntegrationContextById, type FeishuIntegrationContext } from '../integration/integrationStore';

export interface FeishuEvent {
  schema?: string;
  type?: string;
  event_id?: string;
  event_type?: string;
  create_time?: string | number;
  token?: string;
  event?: Record<string, unknown>;
}

export interface FeishuEventEnvelope {
  schema?: string;
  type?: string;
  challenge?: string;
  token?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
    token?: string;
  };
  event?: Record<string, unknown>;
}

export type EventHandleResult = {
  accepted: boolean;
  processed: boolean;
  eventId?: string;
  eventType?: string;
  error?: string;
};

const SUPPORTED_EVENT_TYPES = [
  'minutes.minute.generated_v1',
  'vc.note.generated_v1',
];

function createEnvelope(event: FeishuEvent): FeishuEventEnvelope {
  return {
    schema: event.schema,
    type: event.type || event.event_type,
    token: event.token,
    header: {
      event_id: event.event_id,
      event_type: event.event_type || event.type,
      create_time: typeof event.create_time === 'number' 
        ? String(event.create_time) 
        : event.create_time,
      token: event.token,
    },
    event: event.event || (event as Record<string, unknown>),
  };
}

export async function handleFeishuEvent(
  event: FeishuEvent,
  integration: FeishuIntegrationContext
): Promise<EventHandleResult> {
  const eventId = event.event_id;
  const eventType = event.event_type || event.type;

  if (!eventId) {
    return {
      accepted: false,
      processed: false,
      eventType,
      error: '事件缺少 event_id',
    };
  }

  if (!SUPPORTED_EVENT_TYPES.includes(eventType || '')) {
    logFeishuMonitor('info', 'event_ignored_unsupported_type', {
      integrationId: integration.id,
      eventId,
      eventType,
    });
    return {
      accepted: true,
      processed: false,
      eventId,
      eventType,
    };
  }

  try {
    const envelope = createEnvelope(event);
    const result = await enqueueFeishuEvent(envelope, integration);

    return {
      accepted: result.accepted,
      processed: true,
      eventId,
      eventType,
    };
  } catch (error) {
    logFeishuMonitor('error', 'event_handle_failed', {
      integrationId: integration.id,
      eventId,
      eventType,
      ...toErrorContext(error),
    });

    return {
      accepted: true,
      processed: false,
      eventId,
      eventType,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleFeishuEventById(
  event: FeishuEvent,
  integrationId: string
): Promise<EventHandleResult> {
  try {
    const integration = await getFeishuIntegrationContextById(integrationId);
    if (!integration) {
      return {
        accepted: false,
        processed: false,
        eventType: event.event_type || event.type,
        error: `未找到集成 ${integrationId}`,
      };
    }

    return handleFeishuEvent(event, integration);
  } catch (error) {
    return {
      accepted: false,
      processed: false,
      eventType: event.event_type || event.type,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isSupportedEventType(eventType: string): boolean {
  return SUPPORTED_EVENT_TYPES.includes(eventType);
}

export function getSupportedEventTypes(): string[] {
  return [...SUPPORTED_EVENT_TYPES];
}
