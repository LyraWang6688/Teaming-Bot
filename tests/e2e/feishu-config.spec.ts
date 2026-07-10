import { expect, type Page, test } from '@playwright/test';

test.afterEach(async ({ context, page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
  await page.close({ runBeforeUnload: false }).catch(() => undefined);
  await context.close().catch(() => undefined);
});

type MockScenario = {
  user?: boolean;
  integration?: boolean;
  authorized?: boolean;
  selectedOrg?: boolean;
  checksPassed?: boolean;
  createAppFails?: boolean;
};

const now = '2026-07-10T00:00:00.000Z';
const integrationId = 'integration-test';
const orgTargetId = 'org-target-test';

function json(data: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

function buildIntegration(scenario: MockScenario) {
  return {
    id: integrationId,
    userId: 'user-test',
    name: 'Teaming Bot Test',
    status: 'active',
    setupStep: 'created',
    appId: 'cli_test_app',
    oauthScope: 'minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app',
    meetingTableId: null,
    selectedOrgTargetId: scenario.selectedOrg ? orgTargetId : null,
    orgSelectedAt: scenario.selectedOrg ? now : null,
    initializedAt: now,
    createdAt: now,
    updatedAt: now,
    links: {
      baseUrl: null,
    },
    masked: {
      appSecret: '***',
      baseAppToken: null,
    },
  };
}

function buildDetail(scenario: MockScenario) {
  const integration = buildIntegration(scenario);
  return {
    integration,
    authorization: scenario.authorized
      ? {
          integrationId,
          status: 'authorized',
          authorizedOpenId: 'ou_test',
          authorizedUserName: '测试用户',
          scope: integration.oauthScope,
          accessTokenExpiresAt: now,
          refreshTokenExpiresAt: now,
          updatedAt: now,
          masked: {
            accessToken: '***',
            refreshToken: '***',
          },
        }
      : null,
    checks: scenario.checksPassed
      ? {
          appCredentialStatus: 'success',
          permissionStatus: 'success',
          eventSubscriptionStatus: 'success',
          oauthStatus: 'authorized',
          baseStatus: 'success',
          allPassed: true,
          lastCheckedAt: now,
          lastErrorType: null,
          lastErrorMessage: null,
          details: {},
        }
      : {
          appCredentialStatus: scenario.integration ? 'success' : 'pending',
          permissionStatus: 'pending',
          eventSubscriptionStatus: 'pending',
          oauthStatus: scenario.authorized ? 'authorized' : 'pending',
          baseStatus: 'pending',
          allPassed: false,
          lastCheckedAt: null,
          lastErrorType: null,
          lastErrorMessage: null,
          details: {},
        },
    requiredEvents: ['minutes.minute.generated_v1'],
    requiredPermissions: ['bitable:app'],
  };
}

async function mockFeishuConfigApis(page: Page, scenario: MockScenario = {}) {
  const state = {
    ...scenario,
  };

  await page.route('https://api.qrserver.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="116" height="116" />',
    });
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/client-log') {
      await route.fulfill(json({ success: true, data: null }));
      return;
    }

    if (path === '/api/auth/me') {
      await route.fulfill(json({
        success: true,
        data: state.user === false ? null : { id: 'user-test', email: 'test@example.com' },
      }));
      return;
    }

    if (path === '/api/project-org-targets/active') {
      await route.fulfill(json({
        success: true,
        data: {
          project: {
            id: 'project-test',
            projectKey: '2026-07-test',
            name: '2026-07 test',
            status: 'active',
          },
          targets: [
            {
              id: orgTargetId,
              projectId: 'project-test',
              orgKey: 'org_a',
              orgName: 'TEST',
              tableId: 'tbl_test',
              enabled: true,
              fieldCheckStatus: state.checksPassed ? 'success' : 'pending',
              fieldCheckDetails: null,
            },
          ],
        },
      }));
      return;
    }

    if (path === '/api/feishu/integrations' && method === 'GET') {
      await route.fulfill(json({
        success: true,
        data: state.integration ? [buildIntegration(state)] : [],
      }));
      return;
    }

    if (path === '/api/feishu/integrations/create-app' && method === 'POST') {
      if (state.createAppFails) {
        await route.fulfill(json({ success: false, error: '创建应用失败，请稍后重试。' }, 500));
        return;
      }

      await route.fulfill(json({
        success: true,
        data: {
          verificationUrl: 'https://example.feishu.cn/mock-create-app',
          sessionToken: 'session-test',
          profileName: 'profile-test',
        },
      }));
      return;
    }

    if (path === '/api/feishu/integrations/register/poll' && method === 'POST') {
      await route.fulfill(json({ success: true, data: { status: 'pending' } }));
      return;
    }

    if (path === `/api/feishu/integrations/${integrationId}` && method === 'GET') {
      await route.fulfill(json({ success: true, data: buildDetail(state) }));
      return;
    }

    if (path === `/api/feishu/integrations/${integrationId}` && method === 'PATCH') {
      state.selectedOrg = true;
      await route.fulfill(json({ success: true, data: buildIntegration(state) }));
      return;
    }

    if (path === `/api/feishu/integrations/${integrationId}/authorize/start` && method === 'POST') {
      await route.fulfill(json({
        success: true,
        data: {
          verificationUrl: 'https://example.feishu.cn/mock-authorize',
          deviceCode: 'device-test',
        },
      }));
      return;
    }

    if (path === `/api/feishu/integrations/${integrationId}/authorize/poll` && method === 'POST') {
      await route.fulfill(json({ success: true, data: { status: 'pending' } }));
      return;
    }

    if (path === `/api/feishu/integrations/${integrationId}/event-subscription/check` && method === 'POST') {
      await route.fulfill(json({
        success: true,
        data: {
          eventFound: Boolean(state.checksPassed),
        },
      }));
      return;
    }

    if (path === `/api/feishu/integrations/${integrationId}/checks` && method === 'POST') {
      state.checksPassed = true;
      await route.fulfill(json({ success: true, data: { allPassed: true } }));
      return;
    }

    await route.fulfill(json({ success: false, error: `Unhandled mock route: ${method} ${path}` }, 404));
  });
}

async function gotoSetupWizard(page: Page) {
  await page.goto('/feishu-config', { waitUntil: 'domcontentloaded' });
}

async function assertNoAboveFoldScroll(page: Page) {
  const result = await page.evaluate(() => {
    const stepIds = ['step-create-app', 'step-authorize', 'step-organization'];
    return {
      pageNeedsScroll: document.documentElement.scrollHeight > window.innerHeight + 1,
      bodyNeedsScroll: document.body.scrollHeight > window.innerHeight + 1,
      hasInternalScroll: Array.from(document.querySelectorAll('body *')).some(
        (el) => el.scrollHeight > el.clientHeight + 1
      ),
      cards: stepIds.map((id) => {
        const el = document.getElementById(id);
        if (!el) return { id, found: false, inViewport: false };
        const rect = el.getBoundingClientRect();
        return {
          id,
          found: true,
          inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
        };
      }),
    };
  });

  expect(result.pageNeedsScroll).toBe(false);
  expect(result.bodyNeedsScroll).toBe(false);
  expect(result.hasInternalScroll).toBe(false);
  expect(result.cards.every((card) => card.found && card.inViewport)).toBe(true);
}

test.describe('Feishu setup wizard', () => {
  test('keeps the core setup information above the fold at desktop viewports', async ({ page }) => {
    await mockFeishuConfigApis(page, { user: false, integration: false });
    await page.setViewportSize({ width: 1366, height: 768 });

    await gotoSetupWizard(page);

    await expect(page.getByText('配置进度')).toBeVisible();
    await expect(page.getByText('系统校验结果')).toBeVisible();
    await expect(page.locator('#step-create-app')).toBeVisible();
    await expect(page.locator('#step-authorize')).toBeVisible();
    await expect(page.locator('#step-organization')).toBeVisible();
    await expect(page.locator('#step-create-app')).toContainText('创建飞书应用');
    await expect(page.locator('#step-authorize')).toContainText('用户授权');
    await expect(page.locator('#step-organization')).toContainText('选择组织');

    await assertNoAboveFoldScroll(page);
  });

  test('shows a blocking dialog when app creation fails', async ({ page }) => {
    await mockFeishuConfigApis(page, { user: false, integration: false, createAppFails: true });
    await page.setViewportSize({ width: 1366, height: 768 });

    await gotoSetupWizard(page);
    await page.getByRole('button', { name: '创建应用' }).click();

    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByText('操作未完成')).toBeVisible();
    await expect(page.getByText('创建应用失败，请稍后重试。')).toBeVisible();
  });

  test('shows authorization QR content without requiring real Feishu authorization', async ({ page }) => {
    await mockFeishuConfigApis(page, { user: true, integration: true, authorized: false });
    await page.setViewportSize({ width: 1366, height: 768 });

    await gotoSetupWizard(page);
    await page.getByRole('button', { name: '开始授权' }).click();

    await expect(page.getByText('扫码完成用户授权')).toBeVisible();
    await expect(page.getByRole('link', { name: '打开链接' })).toHaveAttribute(
      'href',
      'https://example.feishu.cn/mock-authorize'
    );
  });

  test('shows celebration when the system checks are all passed', async ({ page }) => {
    await mockFeishuConfigApis(page, {
      user: true,
      integration: true,
      authorized: true,
      selectedOrg: true,
      checksPassed: true,
    });
    await page.setViewportSize({ width: 1366, height: 768 });

    await gotoSetupWizard(page);

    await expect(page.getByText('全部通过')).toBeVisible();
    await expect(page.getByText('配置完成', { exact: true })).toBeVisible();
    await expect(page.getByText('系统校验已通过，后续可以自动监听并分析飞书会议。')).toBeVisible();
  });
});
