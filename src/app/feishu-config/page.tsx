'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Layout from '@/components/Layout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  LogOut,
  PlusCircle,
  RefreshCw,
} from 'lucide-react';

const REQUIRED_PERMISSIONS = [
  'vc:meeting.meetingevent:read',
  'vc:record:readonly',
  'minutes:minutes.transcript:export',
  'bitable:app:read',
  'bitable:table:read',
  'bitable:record:read',
  'bitable:record:write',
] as const;

const REQUIRED_EVENTS = [
  {
    id: 'vc.meeting.participant_meeting_ended_v1',
    name: '参与会议结束',
    desc: '会议结束后触发，作为会议分析自动化链路的事件入口。',
  },
] as const;

type AuthUser = {
  id: string;
  email: string | null;
};

type IntegrationView = {
  id: string;
  userId: string;
  name: string;
  status: string;
  setupStep: string;
  appId: string;
  oauthScope: string;
  meetingTableId: string | null;
  initializedAt: string | null;
  lastWebhookReceivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  masked: {
    appSecret: string | null;
    webhookVerificationToken: string | null;
    baseAppToken: string | null;
  };
};

type IntegrationDetail = IntegrationView & {
  requiredEvents: string[];
  requiredPermissions: string[];
};

type AuthorizationView = {
  integrationId: string;
  status: string;
  authorizedOpenId: string | null;
  authorizedUserName: string | null;
  scope: string | null;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string | null;
  updatedAt: string;
  masked: {
    accessToken: string | null;
    refreshToken: string | null;
  };
};

type CheckStatusView = {
  appCredentialStatus: string;
  permissionStatus: string;
  eventSubscriptionStatus: string;
  webhookStatus: string;
  oauthStatus: string;
  baseStatus: string;
  lastCheckedAt: string | null;
  lastErrorType: string | null;
  lastErrorMessage: string | null;
  details: Record<string, unknown>;
};

type IntegrationDetailResponse = {
  integration: IntegrationDetail;
  authorization: AuthorizationView | null;
  checks: CheckStatusView | null;
};

type FormState = {
  name: string;
  appId: string;
  appSecret: string;
  webhookVerificationToken: string;
  baseAppToken: string;
  meetingTableId: string;
  oauthScope: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  appId: '',
  appSecret: '',
  webhookVerificationToken: '',
  baseAppToken: '',
  meetingTableId: '',
  oauthScope: '',
};

function formatDateTime(value: string | null) {
  if (!value) {
    return '未设置';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function getStatusLabel(status: string | null | undefined) {
  switch (status) {
    case 'authorized':
      return '已授权';
    case 'oauth_authorized':
      return 'OAuth 已完成';
    case 'passed':
      return '已通过';
    case 'success':
      return '正常';
    case 'pending':
      return '待完成';
    case 'draft':
      return '草稿';
    case 'failed':
      return '失败';
    default:
      return status || '未设置';
  }
}

function getStatusBadgeClass(status: string | null | undefined) {
  switch (status) {
    case 'authorized':
    case 'oauth_authorized':
    case 'passed':
    case 'success':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'draft':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700';
  }
}

function mapIntegrationToForm(integration: IntegrationView | null): FormState {
  if (!integration) {
    return EMPTY_FORM;
  }

  return {
    name: integration.name,
    appId: integration.appId,
    appSecret: '',
    webhookVerificationToken: '',
    baseAppToken: '',
    meetingTableId: integration.meetingTableId || '',
    oauthScope: integration.oauthScope || '',
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: T; error?: string }
    | null;

  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error || '请求失败，请稍后重试。');
  }

  return payload.data as T;
}

export default function FeishuConfigPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [origin, setOrigin] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationView[]>([]);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IntegrationDetailResponse | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isLoadingIntegrations, setIsLoadingIntegrations] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [isInitializingBase, setIsInitializingBase] = useState(false);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const webhookUrl = `${origin || 'https://your-domain.com'}/api/feishu/webhook`;
  const oauthCallbackUrl = `${origin || 'https://your-domain.com'}/api/feishu/oauth/callback`;
  const loginHref = `/login?next=${encodeURIComponent('/feishu-config')}`;
  const oauthAuthorizeUrl = selectedIntegrationId
    ? `/api/feishu/oauth/start?${new URLSearchParams({
        integrationId: selectedIntegrationId,
        redirectTo: '/feishu-config',
      }).toString()}`
    : null;

  const selectedIntegration =
    integrations.find((integration) => integration.id === selectedIntegrationId) || null;

  const copyToClipboard = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 2000);
    } catch {
      setPageError('复制失败，请手动复制当前地址。');
    }
  };

  const loadIntegrationDetail = useCallback(async (integrationId: string) => {
    setIsLoadingDetail(true);
    setPageError(null);

    try {
      const data = await parseJsonResponse<IntegrationDetailResponse>(
        await fetch(`/api/feishu/integrations/${integrationId}`, {
          method: 'GET',
          cache: 'no-store',
        })
      );
      setDetail(data);
      setForm(mapIntegrationToForm(data.integration));
    } catch (error) {
      setDetail(null);
      setPageError(error instanceof Error ? error.message : '读取集成详情失败。');
    } finally {
      setIsLoadingDetail(false);
    }
  }, []);

  const loadIntegrations = useCallback(async (preferredIntegrationId?: string | null) => {
    setIsLoadingIntegrations(true);

    try {
      const list = await parseJsonResponse<IntegrationView[]>(
        await fetch('/api/feishu/integrations', {
          method: 'GET',
          cache: 'no-store',
        })
      );

      setIntegrations(list);

      const nextIntegrationId =
        preferredIntegrationId && list.some((item) => item.id === preferredIntegrationId)
          ? preferredIntegrationId
          : list[0]?.id || null;

      setSelectedIntegrationId(nextIntegrationId);

      if (nextIntegrationId) {
        await loadIntegrationDetail(nextIntegrationId);
      } else {
        setDetail(null);
        setForm(EMPTY_FORM);
      }
    } catch (error) {
      setIntegrations([]);
      setSelectedIntegrationId(null);
      setDetail(null);
      setForm(EMPTY_FORM);
      setPageError(error instanceof Error ? error.message : '读取飞书集成列表失败。');
    } finally {
      setIsLoadingIntegrations(false);
    }
  }, [loadIntegrationDetail]);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      setAuthLoading(true);
      setPageError(null);

      try {
        const currentUser = await parseJsonResponse<AuthUser | null>(
          await fetch('/api/auth/me', {
            method: 'GET',
            cache: 'no-store',
          })
        );

        if (cancelled) {
          return;
        }

        setUser(currentUser);
        if (currentUser) {
          await loadIntegrations();
        } else {
          setIntegrations([]);
          setSelectedIntegrationId(null);
          setDetail(null);
          setForm(EMPTY_FORM);
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : '初始化页面失败。');
        }
      } finally {
        if (!cancelled) {
          setAuthLoading(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [loadIntegrations]);

  const handleCreateNew = () => {
    setSelectedIntegrationId(null);
    setDetail(null);
    setForm(EMPTY_FORM);
    setPageMessage(null);
    setPageError(null);
  };

  const handleSelectIntegration = async (integrationId: string) => {
    setSelectedIntegrationId(integrationId);
    setPageMessage(null);
    await loadIntegrationDetail(integrationId);
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    setPageError(null);

    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        throw error;
      }

      setUser(null);
      setIntegrations([]);
      setSelectedIntegrationId(null);
      setDetail(null);
      setForm(EMPTY_FORM);
      router.push(loginHref);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '退出登录失败，请稍后重试。');
    } finally {
      setIsSigningOut(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPageMessage(null);
    setPageError(null);

    if (!form.name.trim() || !form.appId.trim()) {
      setPageError('请先填写集成名称和 App ID。');
      return;
    }

    if (!selectedIntegrationId) {
      if (!form.appSecret.trim() || !form.webhookVerificationToken.trim()) {
        setPageError('首次创建集成时，App Secret 和 Webhook Verification Token 必填。');
        return;
      }
    }

    const payload: Record<string, string | null> = {
      name: form.name.trim(),
      appId: form.appId.trim(),
      meetingTableId: form.meetingTableId.trim() || null,
    };

    if (form.oauthScope.trim()) {
      payload.oauthScope = form.oauthScope.trim();
    }

    if (selectedIntegrationId) {
      if (form.appSecret.trim()) {
        payload.appSecret = form.appSecret.trim();
      }
      if (form.webhookVerificationToken.trim()) {
        payload.webhookVerificationToken = form.webhookVerificationToken.trim();
      }
      if (form.baseAppToken.trim()) {
        payload.baseAppToken = form.baseAppToken.trim();
      }
    } else {
      payload.appSecret = form.appSecret.trim();
      payload.webhookVerificationToken = form.webhookVerificationToken.trim();
      payload.baseAppToken = form.baseAppToken.trim() || null;
    }

    setIsSaving(true);

    try {
      const method = selectedIntegrationId ? 'PATCH' : 'POST';
      const url = selectedIntegrationId
        ? `/api/feishu/integrations/${selectedIntegrationId}`
        : '/api/feishu/integrations';

      const savedIntegration = await parseJsonResponse<IntegrationView>(
        await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
      );

      await loadIntegrations(savedIntegration.id);
      setPageMessage(selectedIntegrationId ? '飞书集成配置已更新。' : '飞书集成配置已创建。');
      setForm((current) => ({
        ...current,
        appSecret: '',
        webhookVerificationToken: '',
        baseAppToken: '',
      }));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '保存飞书集成配置失败。');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRunChecks = async () => {
    if (!selectedIntegrationId) {
      return;
    }

    setIsRunningChecks(true);
    setPageMessage(null);
    setPageError(null);

    try {
      const result = await parseJsonResponse<{
        allPassed: boolean;
      }>(
        await fetch(`/api/feishu/integrations/${selectedIntegrationId}/checks`, {
          method: 'POST',
        })
      );

      await loadIntegrations(selectedIntegrationId);
      setPageMessage(
        result.allPassed
          ? '真实检查已完成，当前集成已通过全部校验。'
          : '真实检查已完成，状态面板已刷新，请根据结果继续处理。'
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '执行真实检查失败。');
    } finally {
      setIsRunningChecks(false);
    }
  };

  const handleInitializeBase = async () => {
    if (!selectedIntegrationId) {
      return;
    }

    setIsInitializingBase(true);
    setPageMessage(null);
    setPageError(null);

    try {
      const result = await parseJsonResponse<{
        appToken: string;
        tableId: string;
        createdApp: boolean;
        createdTable: boolean;
        createdFields: string[];
      }>(
        await fetch(`/api/feishu/integrations/${selectedIntegrationId}/base/initialize`, {
          method: 'POST',
        })
      );

      await loadIntegrations(selectedIntegrationId);
      setPageMessage(
        `Base 初始化完成，已绑定 ${result.appToken} / ${result.tableId}，新增字段 ${result.createdFields.length} 个。`
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '初始化 Base 失败。');
    } finally {
      setIsInitializingBase(false);
    }
  };

  return (
    <Layout>
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-slate-900">飞书集成配置</h1>
              <p className="max-w-3xl text-slate-600">
                首次完成初始化后，系统会在你作为会议 owner 的会议结束时，自动收到 Webhook、
                获取录制与文字稿、生成分析并写回你的多维表格。
              </p>
            </div>

            {authLoading ? (
              <div className="flex gap-2">
                <Skeleton className="h-10 w-32" />
                <Skeleton className="h-10 w-24" />
              </div>
            ) : user ? (
              <div className="flex flex-col items-start gap-2 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
                <div className="text-slate-500">当前账号</div>
                <div className="font-medium text-slate-900">{user.email || user.id}</div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadIntegrations(selectedIntegrationId)}
                    disabled={isLoadingIntegrations || isLoadingDetail}
                  >
                    <RefreshCw className="w-4 h-4" />
                    刷新
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleSignOut}
                    disabled={isSigningOut}
                  >
                    <LogOut className="w-4 h-4" />
                    {isSigningOut ? '退出中...' : '退出登录'}
                  </Button>
                </div>
              </div>
            ) : (
              <Button asChild>
                <a href={loginHref}>登录后配置</a>
              </Button>
            )}
          </div>

          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>单域名多租户模式</AlertTitle>
            <AlertDescription>
              平台级环境变量只保留域名、大模型、数据库、加密主密钥和登录体系。每个登录账号会单独保存自己的飞书应用配置、Base 配置、OAuth
              授权和检查状态。
            </AlertDescription>
          </Alert>

          {pageMessage ? (
            <Alert className="border-emerald-200 bg-emerald-50">
              <Check className="h-4 w-4 text-emerald-700" />
              <AlertTitle className="text-emerald-900">操作成功</AlertTitle>
              <AlertDescription className="text-emerald-800">{pageMessage}</AlertDescription>
            </Alert>
          ) : null}

          {pageError ? (
            <Alert className="border-red-200 bg-red-50">
              <AlertCircle className="h-4 w-4 text-red-700" />
              <AlertTitle className="text-red-900">操作失败</AlertTitle>
              <AlertDescription className="text-red-800">{pageError}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        {!authLoading && !user ? (
          <Card>
            <CardHeader>
              <CardTitle>先登录，再保存你的飞书配置</CardTitle>
              <CardDescription>
                这里登录的是产品账号，不是 Supabase 后台账号。登录后，每个用户会拥有自己独立的飞书集成配置与 OAuth 授权记录。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 text-sm text-slate-600 md:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  - 保存自己的 App ID / App Secret / Webhook Token
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  - 绑定自己的 Base 与会议信息表
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  - 发起自己的 OAuth 授权并自动落库
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  - 查看自己的权限、Webhook、OAuth、Base 检查状态
                </div>
              </div>
              <div className="flex gap-3">
                <Button asChild>
                  <a href={loginHref}>前往登录</a>
                </Button>
                <Button variant="outline" asChild>
                  <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-4 h-4" />
                    打开飞书开放平台
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {authLoading ? (
          <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
            <Skeleton className="h-[420px] w-full" />
            <Skeleton className="h-[720px] w-full" />
          </div>
        ) : null}

        {!authLoading && user ? (
          <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>我的集成</CardTitle>
                  <CardDescription>
                    每个账号可管理多套飞书集成。当前页面已接入真实数据库读写。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Button type="button" variant="outline" className="w-full" onClick={handleCreateNew}>
                    <PlusCircle className="w-4 h-4" />
                    新建集成
                  </Button>

                  <div className="space-y-3">
                    {isLoadingIntegrations ? (
                      <>
                        <Skeleton className="h-24 w-full" />
                        <Skeleton className="h-24 w-full" />
                      </>
                    ) : integrations.length ? (
                      integrations.map((integration) => {
                        const isActive = integration.id === selectedIntegrationId;
                        return (
                          <button
                            key={integration.id}
                            type="button"
                            onClick={() => void handleSelectIntegration(integration.id)}
                            className={`w-full rounded-lg border p-4 text-left transition-colors ${
                              isActive
                                ? 'border-indigo-300 bg-indigo-50'
                                : 'border-slate-200 bg-white hover:border-slate-300'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="font-medium text-slate-900">{integration.name}</div>
                              <Badge
                                variant="outline"
                                className={getStatusBadgeClass(integration.status)}
                              >
                                {getStatusLabel(integration.status)}
                              </Badge>
                            </div>
                            <div className="mt-2 text-xs text-slate-500">App ID: {integration.appId}</div>
                            <div className="mt-2 text-xs text-slate-500">
                              最近更新：{formatDateTime(integration.updatedAt)}
                            </div>
                          </button>
                        );
                      })
                    ) : (
                      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
                        还没有保存任何飞书集成，先新建一套配置即可开始。
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>第 2 步指引</CardTitle>
                  <CardDescription>保存基础配置后，在飞书开放平台完成权限、事件和回调地址配置。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="mb-2 text-sm font-medium text-slate-900">Webhook 回调地址</div>
                    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <code className="break-all text-xs text-slate-700">{webhookUrl}</code>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void copyToClipboard('webhook', webhookUrl)}
                      >
                        {copiedKey === 'webhook' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {copiedKey === 'webhook' ? '已复制' : '复制地址'}
                      </Button>
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-sm font-medium text-slate-900">建议权限</div>
                    <div className="space-y-2">
                      {REQUIRED_PERMISSIONS.map((permission) => (
                        <div
                          key={permission}
                          className="rounded border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700"
                        >
                          {permission}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-sm font-medium text-slate-900">必需事件</div>
                    <div className="space-y-2">
                      {REQUIRED_EVENTS.map((event) => (
                        <div key={event.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <div className="text-sm font-medium text-slate-900">{event.name}</div>
                          <div className="mt-1 font-mono text-xs text-slate-500">{event.id}</div>
                          <div className="mt-1 text-xs text-slate-500">{event.desc}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>
                    {selectedIntegrationId ? '第 1 步：编辑基础配置' : '第 1 步：创建基础配置'}
                  </CardTitle>
                  <CardDescription>
                    敏感字段只会在服务端加密保存，页面只展示脱敏结果。编辑已存在的集成时，密钥类输入框留空表示保持原值。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form className="space-y-6" onSubmit={handleSubmit}>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="integration-name">集成名称</Label>
                        <Input
                          id="integration-name"
                          value={form.name}
                          onChange={(event) =>
                            setForm((current) => ({ ...current, name: event.target.value }))
                          }
                          placeholder="例如：我的飞书会议分析"
                          required
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="integration-app-id">App ID</Label>
                        <Input
                          id="integration-app-id"
                          value={form.appId}
                          onChange={(event) =>
                            setForm((current) => ({ ...current, appId: event.target.value }))
                          }
                          placeholder="cli_xxx"
                          required
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="integration-app-secret">App Secret</Label>
                        <Input
                          id="integration-app-secret"
                          type="password"
                          value={form.appSecret}
                          onChange={(event) =>
                            setForm((current) => ({ ...current, appSecret: event.target.value }))
                          }
                          placeholder={selectedIntegrationId ? '如需替换请输入新值' : '请输入 App Secret'}
                        />
                        {selectedIntegration?.masked.appSecret ? (
                          <div className="text-xs text-slate-500">
                            已保存：{selectedIntegration.masked.appSecret}
                          </div>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="integration-webhook-token">Webhook Verification Token</Label>
                        <Input
                          id="integration-webhook-token"
                          type="password"
                          value={form.webhookVerificationToken}
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              webhookVerificationToken: event.target.value,
                            }))
                          }
                          placeholder={
                            selectedIntegrationId ? '如需替换请输入新值' : '请输入 Webhook Token'
                          }
                        />
                        {selectedIntegration?.masked.webhookVerificationToken ? (
                          <div className="text-xs text-slate-500">
                            已保存：{selectedIntegration.masked.webhookVerificationToken}
                          </div>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="integration-base-app-token">Base App Token</Label>
                        <Input
                          id="integration-base-app-token"
                          type="password"
                          value={form.baseAppToken}
                          onChange={(event) =>
                            setForm((current) => ({ ...current, baseAppToken: event.target.value }))
                          }
                          placeholder="appcnxxxx，可后补"
                        />
                        {selectedIntegration?.masked.baseAppToken ? (
                          <div className="text-xs text-slate-500">
                            已保存：{selectedIntegration.masked.baseAppToken}
                          </div>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="integration-table-id">会议信息表 Table ID</Label>
                        <Input
                          id="integration-table-id"
                          value={form.meetingTableId}
                          onChange={(event) =>
                            setForm((current) => ({ ...current, meetingTableId: event.target.value }))
                          }
                          placeholder="tblxxxx，可后补"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="integration-oauth-scope">OAuth Scope</Label>
                      <Input
                        id="integration-oauth-scope"
                        value={form.oauthScope}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, oauthScope: event.target.value }))
                        }
                        placeholder="留空则使用平台默认 scope"
                      />
                      <div className="text-xs text-slate-500">
                        常用值：`vc:record:readonly minutes:minutes.transcript:export offline_access`
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <Button type="submit" disabled={isSaving}>
                        {isSaving
                          ? '保存中...'
                          : selectedIntegrationId
                            ? '保存当前集成'
                            : '创建集成'}
                      </Button>
                      <Button type="button" variant="outline" onClick={handleCreateNew}>
                        重新填写一套新集成
                      </Button>
                      <Button variant="outline" asChild>
                        <a
                          href="https://open.feishu.cn/app"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="w-4 h-4" />
                          打开飞书开放平台
                        </a>
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>第 3 步与第 4 步：Base 与 OAuth</CardTitle>
                  <CardDescription>
                    先保存集成，再在飞书后台补 OAuth 回调地址并发起授权。授权成功后，令牌只在服务端保存和使用。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="text-sm font-medium text-slate-900">OAuth 回调地址</div>
                    <div className="mt-3 flex flex-col gap-2">
                      <code className="break-all text-xs text-slate-700">{oauthCallbackUrl}</code>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void copyToClipboard('oauth', oauthCallbackUrl)}
                        className="w-fit"
                      >
                        {copiedKey === 'oauth' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {copiedKey === 'oauth' ? '已复制' : '复制地址'}
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="text-sm font-medium text-slate-900">Base 配置状态</div>
                      <div className="mt-3 space-y-2 text-sm text-slate-600">
                        <div>Base App Token：{selectedIntegration?.masked.baseAppToken || '未保存'}</div>
                        <div>Meeting Table ID：{selectedIntegration?.meetingTableId || '未保存'}</div>
                        <div>初始化时间：{formatDateTime(selectedIntegration?.initializedAt || null)}</div>
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="text-sm font-medium text-slate-900">OAuth 授权状态</div>
                      <div className="mt-3 space-y-2 text-sm text-slate-600">
                        <div>
                          当前状态：
                          <span className="ml-2">
                            <Badge
                              variant="outline"
                              className={getStatusBadgeClass(
                                detail?.authorization?.status || detail?.checks?.oauthStatus
                              )}
                            >
                              {getStatusLabel(
                                detail?.authorization?.status || detail?.checks?.oauthStatus
                              )}
                            </Badge>
                          </span>
                        </div>
                        <div>
                          授权用户：{detail?.authorization?.authorizedUserName || '暂未记录'}
                        </div>
                        <div>
                          Access Token：{detail?.authorization?.masked.accessToken || '未授权'}
                        </div>
                        <div>
                          到期时间：
                          {detail?.authorization
                            ? formatDateTime(detail.authorization.accessTokenExpiresAt)
                            : ' 未授权'}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    {oauthAuthorizeUrl ? (
                      <Button asChild>
                        <a
                          href={oauthAuthorizeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="w-4 h-4" />
                          授权当前集成
                        </a>
                      </Button>
                    ) : (
                      <Button type="button" disabled>
                        <ExternalLink className="w-4 h-4" />
                        授权当前集成
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleInitializeBase()}
                      disabled={!selectedIntegrationId || isInitializingBase || isLoadingDetail}
                    >
                      {isInitializingBase ? '初始化中...' : '一键初始化 Base'}
                    </Button>
                    <div className="flex items-center text-xs text-slate-500">
                      已保存基础配置后，可直接初始化 Base；成功后会自动刷新状态面板。
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>第 5 步：检查结果</CardTitle>
                  <CardDescription>
                    点击“执行真实检查”后，系统会在线校验应用凭证、OAuth、Webhook/Base 联通情况，并把结果写回内部状态模型。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {isLoadingDetail ? (
                    <Skeleton className="h-40 w-full" />
                  ) : selectedIntegrationId ? (
                    <>
                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void handleRunChecks()}
                          disabled={!selectedIntegrationId || isRunningChecks || isLoadingDetail}
                        >
                          {isRunningChecks ? '检查中...' : '执行真实检查'}
                        </Button>
                        <div className="flex items-center text-xs text-slate-500">
                          事件订阅当前通过是否收到 Webhook 回调间接判断；会议录制与妙记资源权限会在真实链路中继续验证。
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-3">
                        {[
                          ['应用凭证', detail?.checks?.appCredentialStatus],
                          ['权限', detail?.checks?.permissionStatus],
                          ['事件订阅', detail?.checks?.eventSubscriptionStatus],
                          ['Webhook', detail?.checks?.webhookStatus],
                          ['OAuth', detail?.checks?.oauthStatus],
                          ['Base', detail?.checks?.baseStatus],
                        ].map(([label, status]) => (
                          <div key={label} className="rounded-lg border border-slate-200 p-4">
                            <div className="text-sm text-slate-500">{label}</div>
                            <div className="mt-2">
                              <Badge
                                variant="outline"
                                className={getStatusBadgeClass(status)}
                              >
                                {getStatusLabel(status)}
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>

                      <Separator />

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-3">
                          <div className="text-sm font-medium text-slate-900">当前要求的权限</div>
                          <div className="space-y-2">
                            {(detail?.integration.requiredPermissions || REQUIRED_PERMISSIONS).map(
                              (permission) => (
                                <div
                                  key={permission}
                                  className="rounded border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700"
                                >
                                  {permission}
                                </div>
                              )
                            )}
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="text-sm font-medium text-slate-900">当前要求的事件</div>
                          <div className="space-y-2">
                            {(detail?.integration.requiredEvents || REQUIRED_EVENTS.map((event) => event.id)).map(
                              (eventId) => (
                                <div
                                  key={eventId}
                                  className="rounded border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700"
                                >
                                  {eventId}
                                </div>
                              )
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                        <div>最近检查时间：{formatDateTime(detail?.checks?.lastCheckedAt || null)}</div>
                        <div className="mt-2">
                          最近收到 Webhook：{formatDateTime(detail?.integration.lastWebhookReceivedAt || null)}
                        </div>
                        <div className="mt-2">
                          最近错误：
                          {detail?.checks?.lastErrorMessage
                            ? ` ${detail.checks.lastErrorMessage}`
                            : ' 暂无'}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
                      先创建或选择一套飞书集成，下面的 OAuth 状态、检查状态和 Base 状态才会出现。
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        ) : null}
      </div>
    </Layout>
  );
}
