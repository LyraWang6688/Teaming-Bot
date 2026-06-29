/**
 * In-memory store for tracking lark-cli child processes.
 * Used by create-app flow to track `lark-cli config init --new` processes.
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

const processMap = new Map<string, CliProcessEntry>();

export function storeProcess(
  sessionToken: string,
  entry: CliProcessEntry
): void {
  processMap.set(sessionToken, entry);
}

export function getProcess(sessionToken: string): CliProcessEntry | null {
  return processMap.get(sessionToken) ?? null;
}

export function deleteProcess(sessionToken: string): void {
  processMap.delete(sessionToken);
}

export function setIntegrationId(
  sessionToken: string,
  integrationId: string
): void {
  const entry = processMap.get(sessionToken);
  if (entry) {
    entry.integrationId = integrationId;
  }
}
