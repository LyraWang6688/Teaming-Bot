export const FEISHU_REQUIRED_USER_SCOPES = [
  'auth:user.id:read',
  'minutes:minutes.basic:read',
  'minutes:minutes.transcript:export',
  'offline_access',
  'bitable:app',
] as const;

export const FEISHU_REQUIRED_USER_EVENTS = [
  'minutes.minute.generated_v1',
] as const;

// registerApp uses these application-identity permissions during app creation.
// They are not requested from the end user during OAuth.
export const FEISHU_APPLICATION_SETUP_SCOPES = [
  'application:application:self_manage',
  // Required by application.v7.applicationConfig.patch to configure the
  // OAuth redirect, refresh-token switch, and WebSocket subscription mode.
  'application:application:patch',
  // Required for the bot to proactively send the meeting report card to the
  // authorized user after the pipeline completes.
  'im:message:send_as_bot',
] as const;

export const FEISHU_REQUIRED_USER_SCOPE = FEISHU_REQUIRED_USER_SCOPES.join(' ');
