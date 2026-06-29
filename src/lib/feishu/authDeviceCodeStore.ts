// In-memory storage for device codes from OAuth device flow.
// Ephemeral — on server restart, the user would need to re-initiate.
// Keyed by integrationId.
type DeviceCodeEntry = {
  deviceCode: string;
  expiresAt: number;
  appId: string;
  appSecret: string;
};

const deviceCodeStore = new Map<string, DeviceCodeEntry>();

export function setDeviceCode(
  integrationId: string,
  entry: DeviceCodeEntry
): void {
  deviceCodeStore.set(integrationId, entry);
}

export function getDeviceCode(
  integrationId: string
): DeviceCodeEntry | null {
  const entry = deviceCodeStore.get(integrationId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    deviceCodeStore.delete(integrationId);
    return null;
  }
  return entry;
}

export function deleteDeviceCode(integrationId: string): void {
  deviceCodeStore.delete(integrationId);
}
