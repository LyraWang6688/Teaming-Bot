import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  reporter: [['list']],
  use: {
    ...baseConfig.use,
    trace: 'off',
  },
  webServer: undefined,
});
