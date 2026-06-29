/**
 * In-memory storage for device codes from OAuth device flow.
 * Uses globalThis to survive Turbopack hot reloads.
 */

const STORE_KEY = '__auth_device_code_store';

type DeviceCodeEntry = {
  deviceCode: string;
  expiresAt: number;
  appId: string;
  appSecret: string;
};

function getStore(): Map<string, DeviceCodeEntry> {
  if (!(globalThis as Record<string, unknown>)[STORE_KEY]) {
    (globalThis as Record<string, unknown>)[STORE_KEY] = new Map<string, DeviceCodeEntry>();
  }
  return (globalThis as Record<string, unknown>)[STORE_KEY] as Map<string, DeviceCodeEntry>;
}

export function setDeviceCode(
  integrationId: string,
  entry: DeviceCodeEntry
): void {
  getStore().set(integrationId, entry);
}

export function getDeviceCode(
  integrationId: string
): DeviceCodeEntry | null {
  const entry = getStore().get(integrationId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    getStore().delete(integrationId);
    return null;
  }
  return entry;
}

export function deleteDeviceCode(integrationId: string): void {
  getStore().delete(integrationId);
}
