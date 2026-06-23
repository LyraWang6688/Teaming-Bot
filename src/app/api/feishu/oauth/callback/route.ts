import { NextRequest, NextResponse } from 'next/server';
import {
  getFeishuAppCredentials,
  getFeishuUserOauthRedirectUri,
  getProjectPublicUrl,
} from '@/lib/feishu/config';
import {
  consumeOauthState,
  getUserFeishuIntegrationContext,
  upsertFeishuAuthorization,
  upsertFeishuIntegrationCheckStatus,
  updateUserFeishuIntegration,
  writeAuditLog,
} from '@/lib/feishu/integrationStore';

type OauthTokenResponse = {
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHtml(title: string, description: string, body: string) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 32px 16px; }
      .container { max-width: 860px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.08); }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { line-height: 1.7; color: #475569; }
      .panel { margin-top: 20px; padding: 16px; border-radius: 12px; background: #f8fafc; border: 1px solid #cbd5e1; }
      pre { white-space: pre-wrap; word-break: break-all; background: #0f172a; color: #e2e8f0; padding: 16px; border-radius: 12px; overflow: auto; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .actions { margin-top: 16px; }
      a { color: #2563eb; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .warn { color: #92400e; }
    </style>
  </head>
  <body>
    <main class="container">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      ${body}
    </main>
  </body>
</html>`;
}

function renderErrorPage(message: string) {
  const html = renderHtml(
    '飞书用户授权失败',
    '当前无法拿到 user_access_token。tenant 主链路不依赖它，但若你正在做排障或补充 user 身份调用，请检查应用配置、回调地址和权限范围。',
    `<div class="panel"><p class="warn">${escapeHtml(message)}</p><div class="actions"><a href="${escapeHtml(
      `${getProjectPublicUrl()}/feishu-config`
    )}">返回飞书配置页</a></div></div>`
  );

  return new NextResponse(html, {
    status: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function renderManagedSuccessPage(options: {
  integrationName: string;
  redirectUri: string;
  state: string;
}) {
  const html = renderHtml(
    '飞书用户授权成功',
    '当前授权结果已直接写入数据库，后续会由服务端自动刷新和使用，无需手工复制环境变量。',
    `<div class="panel">
      <p><strong>集成名称:</strong> <code>${escapeHtml(options.integrationName)}</code></p>
      <p><strong>state:</strong> <code>${escapeHtml(options.state)}</code></p>
      <p><strong>redirect_uri:</strong> <code>${escapeHtml(options.redirectUri)}</code></p>
    </div>
    <div class="panel">
      <p>这次授权已经自动保存到当前账号的飞书集成配置中。</p>
      <p>下一步建议返回配置页，继续完成权限检查、多维表格初始化和联通性验证。</p>
    </div>
    <div class="actions">
      <a href="${escapeHtml(`${getProjectPublicUrl()}/feishu-config`)}">返回飞书配置页</a>
    </div>`
  );

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function exchangeOauthCode(options: {
  code: string;
  appId: string;
  appSecret: string;
  redirectUri: string;
}): Promise<OauthTokenResponse> {
  const response = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: options.code,
      client_id: options.appId,
      client_secret: options.appSecret,
      redirect_uri: options.redirectUri,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as OauthTokenResponse;
  if (!response.ok || payload.code !== 0 || !payload.access_token) {
    throw new Error(
      payload.error_description ||
        payload.msg ||
        payload.error ||
        `换取 token 失败：HTTP ${response.status}`
    );
  }

  return payload;
}

export async function GET(request: NextRequest) {
  try {
    const code = request.nextUrl.searchParams.get('code');
    const state = request.nextUrl.searchParams.get('state');
    const callbackError =
      request.nextUrl.searchParams.get('error') ||
      request.nextUrl.searchParams.get('error_description');

    if (callbackError) {
      return renderErrorPage(`飞书授权页返回错误：${callbackError}`);
    }

    if (!code) {
      return renderErrorPage('回调地址中缺少 code，未能完成授权换 token。');
    }

    const redirectUri = getFeishuUserOauthRedirectUri();
    if (state) {
      const oauthState = await consumeOauthState(state);
      if (oauthState) {
        const integration = await getUserFeishuIntegrationContext(
          oauthState.userId,
          oauthState.integrationId
        );

        if (!integration) {
          return renderErrorPage('已找到 OAuth 状态，但对应的飞书集成配置不存在。');
        }

        const payload = await exchangeOauthCode({
          code,
          appId: integration.appId,
          appSecret: integration.secrets.appSecret,
          redirectUri,
        });
        const accessToken = payload.access_token;
        if (!accessToken) {
          return renderErrorPage('飞书 OAuth 返回成功，但缺少 access_token。');
        }

        const accessTokenExpiresAt = new Date(
          Date.now() + Math.max(payload.expires_in || 7200, 60) * 1000
        );
        const refreshTokenExpiresAt = payload.refresh_token_expires_in
          ? new Date(Date.now() + Math.max(payload.refresh_token_expires_in, 60) * 1000)
          : null;

        await upsertFeishuAuthorization({
          integrationId: integration.id,
          accessToken,
          refreshToken: payload.refresh_token || null,
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
          scope: integration.oauthScope,
          status: 'authorized',
        });

        await upsertFeishuIntegrationCheckStatus({
          integrationId: integration.id,
          oauthStatus: 'authorized',
          lastCheckedAt: new Date(),
          lastErrorType: null,
          lastErrorMessage: null,
          details: {
            authorizedAt: new Date().toISOString(),
            accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
          },
        });

        await updateUserFeishuIntegration(oauthState.userId, integration.id, {
          status: 'oauth_authorized',
          setupStep: 'oauth',
        });

        await writeAuditLog({
          userId: oauthState.userId,
          integrationId: integration.id,
          action: 'oauth.authorized',
          result: 'success',
          summary: '飞书 OAuth 授权成功并写入数据库',
          metadata: {
            redirectUri,
            hasRefreshToken: Boolean(payload.refresh_token),
          },
        });

        return renderManagedSuccessPage({
          integrationName: integration.name,
          redirectUri,
          state,
        });
      }
    }

    const { appId, appSecret } = getFeishuAppCredentials();

    const payload = await exchangeOauthCode({
      code,
      appId,
      appSecret,
      redirectUri,
    });

    const expiresAt = Math.floor(Date.now() / 1000) + Math.max(payload.expires_in || 7200, 60);
    const envSnippet = [
      `FEISHU_USER_ACCESS_TOKEN=${payload.access_token}`,
      `FEISHU_USER_REFRESH_TOKEN=${payload.refresh_token || ''}`,
      `FEISHU_USER_ACCESS_TOKEN_EXPIRES_AT=${expiresAt}`,
    ].join('\n');

    const html = renderHtml(
      '飞书用户授权成功',
      '下面这 3 行是可选的用户 Token 环境变量。tenant 主链路并不依赖它们；只有在排障或临时补充 user 身份调用时才需要写入服务器配置。',
      `<div class="panel">
        <p><strong>state:</strong> <code>${escapeHtml(state || '(none)')}</code></p>
        <p><strong>redirect_uri:</strong> <code>${escapeHtml(redirectUri)}</code></p>
      </div>
      <div class="panel">
        <p>请把以下内容完整复制到服务器 <code>.env.production</code>：</p>
        <pre>${escapeHtml(envSnippet)}</pre>
      </div>
      <div class="panel">
        <p>完成后在服务器执行：</p>
        <pre>cd /home/ubuntu/meeting-analysis
sudo docker compose up -d --force-recreate</pre>
      </div>
      <div class="actions">
        <a href="${escapeHtml(`${getProjectPublicUrl()}/feishu-config`)}">返回飞书配置页</a>
      </div>`
    );

    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (error) {
    return renderErrorPage(error instanceof Error ? error.message : '处理飞书 OAuth 回调失败');
  }
}
