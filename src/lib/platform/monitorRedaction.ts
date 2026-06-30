type MonitorContext = Record<string, unknown>;

const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_NAMES = new Set([
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'app_secret',
  'appsecret',
  'client_secret',
  'clientsecret',
  'device_code',
  'devicecode',
  'verification_url',
  'verificationurl',
  'database_url',
  'databaseurl',
  'app_encryption_key',
  'appencryptionkey',
  'authorization',
  'cookie',
  'set-cookie',
  'setcookie',
  'password',
  'secret',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
  return (
    SENSITIVE_KEY_NAMES.has(normalized) ||
    normalized.endsWith('secret') ||
    normalized.endsWith('appsecret') ||
    normalized.endsWith('token') && normalized !== 'sessiontoken'
  );
}

function redactString(value: string): string {
  return value
    .replace(/(access_token|refresh_token|device_code|app_secret|client_secret)=([^&\s]+)/gi, `$1=${REDACTED}`)
    .replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/(APP_ENCRYPTION_KEY=)[^\s]+/g, `$1${REDACTED}`);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  return Object.fromEntries(
    Object.entries(value as MonitorContext).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactValue(item, seen),
    ])
  );
}

export function sanitizeMonitorContext<T extends MonitorContext>(context: T): MonitorContext {
  return redactValue(context, new WeakSet<object>()) as MonitorContext;
}
