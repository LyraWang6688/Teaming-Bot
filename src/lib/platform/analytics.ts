import { logClientMonitor } from './clientMonitor';

type AnalyticsContext = Record<string, unknown>;

export type AnalyticsStatus = 'started' | 'succeeded' | 'failed' | 'shown' | 'dismissed';

export function trackSetupWizardEvent(
  event: string,
  context: AnalyticsContext = {}
) {
  logClientMonitor('info', 'setup_wizard_analytics', event, {
    source: 'setup_wizard',
    ...context,
  });
}

export function createStepTimer() {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
}
