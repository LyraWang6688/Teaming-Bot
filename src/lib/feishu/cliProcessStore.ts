/**
 * In-memory store for tracking lark-cli child processes.
 * Uses globalThis to survive Turbopack hot reloads.
 */

import { type ChildProcess } from 'child_process';

interface CliProcessEntry {
  child: ChildProcess;
  profileName: string;
  startedAt: Date;
  integrationId: string | null;
  stdoutBuffer: string;
  stderrBuffer: string;
}

const STORE_KEY = '__cli_process_store';

function getStore(): Map<string, CliProcessEntry> {
  if (!(globalThis as Record<string, unknown>)[STORE_KEY]) {
    (globalThis as Record<string, unknown>)[STORE_KEY] = new Map<string, CliProcessEntry>();
  }
  return (globalThis as Record<string, unknown>)[STORE_KEY] as Map<string, CliProcessEntry>;
}

export function storeProcess(
  sessionToken: string,
  entry: CliProcessEntry
): void {
  getStore().set(sessionToken, entry);
}

export function getProcess(sessionToken: string): CliProcessEntry | null {
  return getStore().get(sessionToken) ?? null;
}

export function deleteProcess(sessionToken: string): void {
  getStore().delete(sessionToken);
}

export function setIntegrationId(
  sessionToken: string,
  integrationId: string
): void {
  const entry = getStore().get(sessionToken);
  if (entry) {
    entry.integrationId = integrationId;
  }
}
