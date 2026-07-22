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

// registerApp uses this application-identity permission only to finish the
// application's own redirect/event configuration. It is not requested from
// the end user during OAuth.
export const FEISHU_APPLICATION_SETUP_SCOPES = [
  'application:application:self_manage',
  // Required by application.v7.applicationConfig.patch to configure the
  // OAuth redirect, refresh-token switch, and WebSocket subscription mode.
  'application:application:patch',
] as const;

export const FEISHU_REQUIRED_USER_SCOPE = FEISHU_REQUIRED_USER_SCOPES.join(' ');
