'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Layout from '@/components/Layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  AlertCircle,
  Check,
  ExternalLink,
  LogOut,
  RefreshCw,
  User,
} from 'lucide-react';

// ============ 常量定义 ============
const APP_PERMISSION_ITEMS = [
  {
    id: 'bitable:app',
    description: '多维表格（查看、评论、编辑）',
  },
] as const;

const DEFAULT_USER_OAUTH_SCOPE =
  'vc:meeting.meetingevent:read vc:record:readonly minutes:minutes.transcript:export offline_access';

const OAUTH_SCOPE_DESCRIPTIONS: Record<string, string> = {
  'vc:meeting.meetingevent:read': '获取会议信息',
  'vc:record:readonly': '获取会议录制',
  'minutes:minutes.transcript:export': '导出妙记转写文字',
  offline_access: '持续访问已授权数据',
};

const REQUIRED_EVENTS = [
  {
    id: 'vc.meeting.participant_meeting_ended_v1',
    name: '参与会议结束',
    desc: '会议结束后自动开始分析',
  },
] as const;

// ============ 类型定义 ============
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
  links: {
    baseUrl: string | null;
  };
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
  allPassed?: boolean;
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

// ============ 辅助函数 ============
function formatDateTime(value: string | null) {
  if (!value) return '未设置';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function getStatusLabel(status: string | null | undefined) {
  switch (status) {
    case 'authorized':
    case 'oauth_authorized':
      return '已授权';
    case 'passed':
    case 'success':
      return '正常';
    case 'pending':
      return '待完成';
    case 'draft':
      return '未完成';
    case 'failed':
      return '有问题';
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
    case 'pending':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700';
  }
}

function getStatusColor(status: string | null | undefined) {
  switch (status) {
    case 'authorized':
    case 'oauth_authorized':
    case 'passed':
    case 'success':
      return 'bg-emerald-500';
    case 'failed':
      return 'bg-red-500';
    case 'draft':
    case 'pending':
      return 'bg-amber-500';
    default:
      return 'bg-slate-300';
  }
}

function mapIntegrationToForm(integration: IntegrationView | null): FormState {
  if (!integration) return EMPTY_FORM;
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

// ============ 步骤状态计算 ============
function calculateStepStatus(
  step: number,
  integration: IntegrationView | null,
  checks: CheckStatusView | null | undefined,
  authorization: AuthorizationView | null | undefined,
  hasSavedCredentials: boolean,
  hasTechConfigCompleted: boolean
) {
  switch (step) {
    case 1: // 登录
      return 'completed';
    case 2: // 配置飞书应用
      return hasTechConfigCompleted ? 'completed' : 'current';
    case 3: // OAuth 授权
      if (!hasSavedCredentials || !hasTechConfigCompleted) return 'pending';
      return authorization?.status === 'authorized' ? 'completed' : 'current';
    case 4: // 初始化
      if (authorization?.status !== 'authorized') return 'pending';
      return integration?.initializedAt ? 'completed' : 'current';
    case 5: // 检查
      if (!integration?.initializedAt) return 'pending';
      return checks?.allPassed ? 'completed' : 'current';
    default:
      return 'pending';
  }
}

function getStepTitle(step: number) {
  switch (step) {
    case 1: return '登录账号';
    case 2: return '配置飞书应用';
    case 3: return '授权飞书账号';
    case 4: return '初始化数据库';
    case 5: return '检查配置状态';
    default: return '';
  }
}

// ============ 主组件 ============
export default function FeishuConfigPage() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [origin, setOrigin] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // 登录相关
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginMessage, setLoginMessage] = useState<string | null>(null);

  // 集成相关
  const [integration, setIntegration] = useState<IntegrationView | null>(null);
  const [detail, setDetail] = useState<IntegrationDetailResponse | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const [isSubmittingCredentials, setIsSubmittingCredentials] = useState(false);
  const [isSubmittingAdvanced, setIsSubmittingAdvanced] = useState(false);

  // 操作状态
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
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
  const oauthAuthorizeUrl = integration?.id
    ? `/api/feishu/oauth/start?${new URLSearchParams({
        integrationId: integration.id,
        redirectTo: '/feishu-config',
      }).toString()}`
    : null;

  const hasSavedCredentials = Boolean(
    integration?.appId && integration?.masked.appSecret && integration?.masked.webhookVerificationToken
  );
  const hasWebhookConnected = Boolean(
    integration?.lastWebhookReceivedAt ||
      detail?.checks?.webhookStatus === 'success' ||
      detail?.checks?.eventSubscriptionStatus === 'success'
  );
  const hasTechConfigCompleted = Boolean(
    hasWebhookConnected || detail?.authorization?.status === 'authorized' || integration?.initializedAt
  );
  const effectiveOauthScopes = useMemo(() => {
    const rawScope = integration?.oauthScope || DEFAULT_USER_OAUTH_SCOPE;
    return Array.from(new Set(rawScope.split(/\s+/).filter(Boolean)));
  }, [integration?.oauthScope]);

  // 计算步骤进度
  const currentStep = useMemo(() => {
    if (!user) return 1;
    if (!hasSavedCredentials) return 2;
    if (!hasTechConfigCompleted) return 2;
    if (!detail?.authorization?.status || detail.authorization.status !== 'authorized') return 3;
    if (!integration?.initializedAt) return 4;
    return 5;
  }, [user, hasSavedCredentials, hasTechConfigCompleted, integration, detail]);

  const stepProgress = ((currentStep - 1) / 4) * 100;

  const copyToClipboard = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    } catch {
      setPageError('复制失败，请手动复制。');
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
      setIntegration(data.integration);
      setForm(mapIntegrationToForm(data.integration));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '读取配置失败。');
    } finally {
      setIsLoadingDetail(false);
    }
  }, []);

  const loadSingleIntegration = useCallback(async () => {
    const list = await parseJsonResponse<IntegrationView[]>(
      await fetch('/api/feishu/integrations', {
        method: 'GET',
        cache: 'no-store',
      })
    );

    if (list.length === 0) {
      setIntegration(null);
      setDetail(null);
      setForm({
        ...EMPTY_FORM,
        name: '默认飞书集成',
      });
      return;
    }

    await loadIntegrationDetail(list[0].id);
  }, [loadIntegrationDetail]);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      setAuthLoading(true);
      setPageError(null);

      try {
        const currentUser = await parseJsonResponse<AuthUser | null>(
          await fetch('/api/auth/me', { method: 'GET', cache: 'no-store' })
        );

        if (cancelled) return;

        setUser(currentUser);
        if (currentUser) {
          await loadSingleIntegration();
        } else {
          setIntegration(null);
          setDetail(null);
          setForm({
            ...EMPTY_FORM,
            name: '默认飞书集成',
          });
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : '初始化失败。');
        }
      } finally {
        if (!cancelled) {
          setAuthLoading(false);
        }
      }
    };

    void bootstrap();
    return () => { cancelled = true; };
  }, [loadSingleIntegration]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!loginEmail.trim()) {
      setPageError('请输入邮箱地址。');
      return;
    }

    setIsLoggingIn(true);
    setLoginMessage(null);
    setPageError(null);

    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: loginEmail.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/feishu-config`,
        },
      });

      if (error) throw error;
      setLoginMessage('登录链接已发送到邮箱，请查收。');
      setLoginEmail('');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '发送登录链接失败。');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    setPageError(null);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setUser(null);
      setIntegration(null);
      setDetail(null);
      setForm({
        ...EMPTY_FORM,
        name: '默认飞书集成',
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '退出登录失败。');
    } finally {
      setIsSigningOut(false);
    }
  };

  // 提交基础凭证（步骤2第一部分）
  const handleSubmitCredentials = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPageMessage(null);
    setPageError(null);

    if (!form.appId.trim()) {
      setPageError('请填写 App ID。');
      return;
    }

    if (!form.appSecret.trim()) {
      setPageError('请填写 App Secret。');
      return;
    }

    if (!form.webhookVerificationToken.trim()) {
      setPageError('请填写 Verification Token。');
      return;
    }

    const payload = {
      name: form.name.trim() || integration?.name || '默认飞书集成',
      appId: form.appId.trim(),
      appSecret: form.appSecret.trim(),
      webhookVerificationToken: form.webhookVerificationToken.trim(),
      oauthScope: form.oauthScope.trim() || null,
    };

    setIsSubmittingCredentials(true);
    try {
      const savedIntegration = await parseJsonResponse<IntegrationView>(
        await fetch(integration?.id ? `/api/feishu/integrations/${integration.id}` : '/api/feishu/integrations', {
          method: integration?.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      );
      await loadIntegrationDetail(savedIntegration.id);
      setPageMessage('基础凭证已保存，请继续在飞书开放平台完成技术配置。');
      setForm((current) => ({
        ...current,
        name: savedIntegration.name,
        appSecret: '',
        webhookVerificationToken: '',
      }));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '提交失败。');
    } finally {
      setIsSubmittingCredentials(false);
    }
  };

  const handleSaveAdvancedConfig = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!integration?.id) {
      setPageError('请先保存基础凭证。');
      return;
    }

    setPageMessage(null);
    setPageError(null);
    setIsSubmittingAdvanced(true);

    try {
      await parseJsonResponse<IntegrationView>(
        await fetch(`/api/feishu/integrations/${integration.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name.trim() || integration.name || '默认飞书集成',
            baseAppToken: form.baseAppToken.trim() || null,
            meetingTableId: form.meetingTableId.trim() || null,
            oauthScope: form.oauthScope.trim() || null,
          }),
        })
      );
      await loadIntegrationDetail(integration.id);
      setPageMessage('附加配置已保存，等待飞书回调验证通过后即可继续下一步。');
      setForm((current) => ({ ...current, baseAppToken: '' }));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '保存附加配置失败。');
    } finally {
      setIsSubmittingAdvanced(false);
    }
  };

  const handleRefreshIntegration = async () => {
    if (!integration?.id) return;
    setPageMessage(null);
    setPageError(null);
    await loadIntegrationDetail(integration.id);
  };

  const handleRunChecks = async () => {
    if (!integration?.id) return;
    setIsRunningChecks(true);
    setPageMessage(null);
    setPageError(null);
    try {
      await parseJsonResponse<{ allPassed: boolean }>(
        await fetch(`/api/feishu/integrations/${integration.id}/checks`, { method: 'POST' })
      );
      await loadIntegrationDetail(integration.id);
      setPageMessage('检查完成。');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '检查失败。');
    } finally {
      setIsRunningChecks(false);
    }
  };

  const handleInitializeBase = async () => {
    if (!integration?.id) return;
    setIsInitializingBase(true);
    setPageMessage(null);
    setPageError(null);
    try {
      const result = await parseJsonResponse<{
        appToken: string;
        tableId: string;
        createdFields: string[];
      }>(
        await fetch(`/api/feishu/integrations/${integration.id}/base/initialize`, { method: 'POST' })
      );
      await loadIntegrationDetail(integration.id);
      setPageMessage(`数据库初始化完成，已创建 ${result.createdFields.length} 个字段。`);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '初始化失败。');
    } finally {
      setIsInitializingBase(false);
    }
  };

  // 渲染步骤指示器
  const renderStepIndicator = (step: number, status: 'completed' | 'current' | 'pending') => {
    return (
      <div className="flex items-center gap-3">
        <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium ${
          status === 'completed' ? 'bg-emerald-500 text-white' :
          status === 'current' ? 'bg-indigo-500 text-white' :
          'bg-slate-200 text-slate-500'
        }`}>
          {status === 'completed' ? <Check className="h-4 w-4" /> : step}
        </div>
        <span className={`font-medium ${
          status === 'completed' ? 'text-emerald-700' :
          status === 'current' ? 'text-indigo-700' :
          'text-slate-400'
        }`}>
          {getStepTitle(step)}
        </span>
      </div>
    );
  };

  return (
    <Layout>
      <div className="mx-auto max-w-3xl space-y-6">
        {/* 页面标题 */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-slate-900">飞书集成配置</h1>
          <p className="text-slate-600">
            完成以下 5 个步骤，让系统自动分析你的飞书会议
          </p>
        </div>

        {/* 步骤进度条 */}
        <Card>
          <CardContent className="pt-6">
            <div className="mb-4 flex items-center justify-between text-sm">
              <span className="text-slate-600">配置进度</span>
              <span className="font-medium text-indigo-600">第 {currentStep} 步 / 共 5 步</span>
            </div>
            <Progress value={stepProgress} className="h-2" />
            <div className="mt-4 flex justify-between">
              {[1, 2, 3, 4, 5].map((step) => (
                <div key={step} className="text-center">
                  <div className={`mx-auto flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                    step < currentStep ? 'bg-emerald-500 text-white' :
                    step === currentStep ? 'bg-indigo-500 text-white' :
                    'bg-slate-200 text-slate-400'
                  }`}>
                    {step < currentStep ? '✓' : step}
                  </div>
                  <div className={`mt-1 text-xs ${
                    step <= currentStep ? 'text-slate-700' : 'text-slate-400'
                  }`}>
                    {getStepTitle(step).slice(0, 3)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 消息提示 */}
        {pageMessage && (
          <Alert className="border-emerald-200 bg-emerald-50">
            <Check className="h-4 w-4 text-emerald-700" />
            <AlertDescription className="text-emerald-800">{pageMessage}</AlertDescription>
          </Alert>
        )}
        {pageError && (
          <Alert className="border-red-200 bg-red-50">
            <AlertCircle className="h-4 w-4 text-red-700" />
            <AlertDescription className="text-red-800">{pageError}</AlertDescription>
          </Alert>
        )}

        {/* 步骤 1：登录 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              {renderStepIndicator(1, user ? 'completed' : 'current')}
              {user && (
                <Badge className="bg-emerald-100 text-emerald-700">已完成</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {user ? (
              <div className="flex items-center gap-3 rounded-lg bg-emerald-50 p-4">
                <User className="h-5 w-5 text-emerald-600" />
                <div>
                  <div className="text-sm text-slate-600">已登录账号</div>
                  <div className="font-medium text-slate-900">{user.email}</div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={handleSignOut}
                  disabled={isSigningOut}
                >
                  <LogOut className="mr-1 h-4 w-4" />
                  {isSigningOut ? '退出中...' : '退出'}
                </Button>
              </div>
            ) : (
              <form onSubmit={handleLogin} className="space-y-4">
                <p className="text-sm text-slate-600">
                  输入你的邮箱，我们会发送一个登录链接给你
                </p>
                {loginMessage && (
                  <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
                    {loginMessage}
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="your@email.com"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    disabled={isLoggingIn}
                    className="flex-1"
                  />
                  <Button type="submit" disabled={isLoggingIn}>
                    {isLoggingIn ? '发送中...' : '发送登录链接'}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>

        {/* 步骤 2：配置飞书应用 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              {renderStepIndicator(
                2,
                calculateStepStatus(
                  2,
                  integration,
                  detail?.checks,
                  detail?.authorization,
                  hasSavedCredentials,
                  hasTechConfigCompleted
                )
              )}
              {hasTechConfigCompleted ? (
                <Badge className="bg-emerald-100 text-emerald-700">已完成</Badge>
              ) : hasSavedCredentials ? (
                <Badge className="bg-amber-100 text-amber-700">待验证</Badge>
              ) : null}
            </div>
            <CardDescription className="pt-2">
              先保存基础凭证，再在飞书开放平台完成 Webhook、权限与回调地址配置。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {authLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : !user ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-500">
                请先完成第 1 步登录
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-medium text-indigo-700">
                      1
                    </div>
                    提交基础凭证
                  </div>

                  <form onSubmit={handleSubmitCredentials} className="space-y-4 pl-8">
                    <div className="space-y-4 rounded-lg border border-slate-200 p-4">
                      <div className="space-y-2">
                        <Label htmlFor="integration-name">集成名称</Label>
                        <Input
                          id="integration-name"
                          value={form.name}
                          onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
                          placeholder="默认飞书集成"
                        />
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="appId">App ID</Label>
                          <Input
                            id="appId"
                            value={form.appId}
                            onChange={(e) => setForm((c) => ({ ...c, appId: e.target.value }))}
                            placeholder="cli_xxx"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="appSecret">App Secret</Label>
                          <Input
                            id="appSecret"
                            type="password"
                            value={form.appSecret}
                            onChange={(e) => setForm((c) => ({ ...c, appSecret: e.target.value }))}
                            placeholder={integration?.masked.appSecret ? '如需替换请输入新值' : '请输入'}
                          />
                          {integration?.masked.appSecret && (
                            <div className="text-xs text-slate-500">已保存：{integration.masked.appSecret}</div>
                          )}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="webhookToken">Verification Token</Label>
                        <Input
                          id="webhookToken"
                          type="password"
                          value={form.webhookVerificationToken}
                          onChange={(e) => setForm((c) => ({ ...c, webhookVerificationToken: e.target.value }))}
                          placeholder={
                            integration?.masked.webhookVerificationToken ? '如需替换请输入新值' : '请输入'
                          }
                        />
                        {integration?.masked.webhookVerificationToken && (
                          <div className="text-xs text-slate-500">
                            已保存：{integration.masked.webhookVerificationToken}
                          </div>
                        )}
                      </div>
                    </div>
                    <Button type="submit" disabled={isSubmittingCredentials}>
                      {isSubmittingCredentials ? '保存中...' : integration?.id ? '更新基础凭证' : '保存基础凭证'}
                    </Button>
                  </form>
                </div>

                {hasSavedCredentials && (
                  <>
                    <Separator />
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-medium text-indigo-700">
                          2
                        </div>
                        提交信息与通信校验
                      </div>

                      <div className="space-y-6 pl-8">
                        <div className="rounded-lg border border-slate-200 p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <div className="text-sm font-medium text-slate-900">通信状态</div>
                            <Badge
                              variant="outline"
                              className={getStatusBadgeClass(
                                hasWebhookConnected ? 'success' : detail?.checks?.webhookStatus || 'pending'
                              )}
                            >
                              {hasWebhookConnected ? '已打通' : '待验证'}
                            </Badge>
                          </div>
                          <div className="space-y-2 text-sm text-slate-600">
                            <div>最近收到 Webhook：{formatDateTime(integration?.lastWebhookReceivedAt || null)}</div>
                            <div>
                              在飞书开放平台保存 Webhook 地址后，系统收到 challenge 或真实事件回调，才会自动解锁下一步。
                            </div>
                          </div>
                          <div className="mt-4">
                            <Button type="button" variant="outline" onClick={() => void handleRefreshIntegration()}>
                              <RefreshCw className="mr-2 h-4 w-4" />
                              刷新状态
                            </Button>
                          </div>
                        </div>

                        <div className="rounded-lg bg-blue-50 p-4">
                          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-900">
                            <ExternalLink className="h-4 w-4" />
                            事件与回调
                          </div>
                          <div className="mb-3 text-xs text-blue-700">
                            订阅方式：将事件发送至开发者服务器
                          </div>
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="w-20 text-xs text-slate-600">请求地址：</span>
                              <code className="flex-1 break-all rounded bg-white px-3 py-1.5 text-xs">{webhookUrl}</code>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-20 text-xs text-slate-600">事件名称：</span>
                              <code className="flex-1 rounded bg-white px-3 py-1.5 font-mono text-xs">
                                {REQUIRED_EVENTS[0].id}
                              </code>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-20 text-xs text-slate-600">加密策略：</span>
                              <code className="flex-1 rounded bg-white px-3 py-1.5 text-xs">
                                Verification Token 验证
                              </code>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-lg border border-slate-200 p-4">
                          <div className="mb-3 text-sm font-medium text-slate-900">权限管理</div>
                          <div className="mb-4">
                            <div className="mb-2 text-xs text-slate-600">应用身份权限：</div>
                            <div className="space-y-2">
                              {APP_PERMISSION_ITEMS.map((permission) => (
                                <div key={permission.id} className="flex items-center gap-2 text-sm">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  <code className="text-slate-700">{permission.id}</code>
                                  <span className="text-slate-500">{permission.description}</span>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div>
                            <div className="mb-2 text-xs text-slate-600">用户身份权限：</div>
                            <div className="space-y-2">
                              {effectiveOauthScopes.map((scope) => (
                                <div key={scope} className="flex items-center gap-2 text-sm">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  <code className="text-slate-700">{scope}</code>
                                  <span className="text-slate-500">
                                    {OAUTH_SCOPE_DESCRIPTIONS[scope] || '用于飞书用户授权'}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        <form onSubmit={handleSaveAdvancedConfig} className="space-y-4 rounded-lg border border-slate-200 p-4">
                          <div className="text-sm font-medium text-slate-900">附加配置（可选）</div>
                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label htmlFor="oauthScope">OAuth Scope</Label>
                              <Input
                                id="oauthScope"
                                value={form.oauthScope}
                                onChange={(e) => setForm((c) => ({ ...c, oauthScope: e.target.value }))}
                                placeholder={DEFAULT_USER_OAUTH_SCOPE}
                              />
                              <div className="text-xs text-slate-500">留空则使用平台默认 scope。</div>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="meetingTableId">数据表 ID</Label>
                              <Input
                                id="meetingTableId"
                                value={form.meetingTableId}
                                onChange={(e) => setForm((c) => ({ ...c, meetingTableId: e.target.value }))}
                                placeholder="tblxxxx，可后补"
                              />
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="baseAppToken">Base App Token</Label>
                            <Input
                              id="baseAppToken"
                              type="password"
                              value={form.baseAppToken}
                              onChange={(e) => setForm((c) => ({ ...c, baseAppToken: e.target.value }))}
                              placeholder="appcnxxxx，可后补"
                            />
                            {integration?.masked.baseAppToken && (
                              <div className="text-xs text-slate-500">已保存：{integration.masked.baseAppToken}</div>
                            )}
                          </div>
                          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                            完成上述操作后，请在飞书开放平台创建版本并发布，然后返回这里点击“刷新状态”确认 Webhook 已打通。
                          </div>
                          <Button type="submit" variant="outline" disabled={isSubmittingAdvanced}>
                            {isSubmittingAdvanced ? '保存中...' : '保存附加配置'}
                          </Button>
                        </form>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* 步骤 3：授权飞书账号 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              {renderStepIndicator(
                3,
                calculateStepStatus(
                  3,
                  integration,
                  detail?.checks,
                  detail?.authorization,
                  hasSavedCredentials,
                  hasTechConfigCompleted
                )
              )}
              {detail?.authorization?.status === 'authorized' && (
                <Badge className="bg-emerald-100 text-emerald-700">已授权</Badge>
              )}
            </div>
            <CardDescription className="pt-2">
              授权应用访问你的飞书账号，这是分析会议的基础
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!hasSavedCredentials ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-500">
                请先完成第 2 步基础凭证
              </div>
            ) : !hasTechConfigCompleted ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-500">
                请先完成第 2 步中的飞书后台配置，并确保 Webhook challenge 已成功回到系统。
              </div>
            ) : (
              <>
                <div className="rounded-lg bg-purple-50 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-purple-900">
                    <ExternalLink className="h-4 w-4" />
                    OAuth 回调地址
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded bg-white px-3 py-2 text-xs">{oauthCallbackUrl}</code>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void copyToClipboard('oauth', oauthCallbackUrl)}
                    >
                      {copiedKey === 'oauth' ? '已复制' : '复制'}
                    </Button>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 p-4">
                  <div className="mb-3 text-sm font-medium">授权状态</div>
                  <div className="space-y-2 text-sm text-slate-600">
                    <div className="flex items-center justify-between">
                      <span>状态</span>
                      <Badge variant="outline" className={getStatusBadgeClass(detail?.authorization?.status)}>
                        {getStatusLabel(detail?.authorization?.status || detail?.checks?.oauthStatus)}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>授权用户</span>
                      <span>{detail?.authorization?.authorizedUserName || '未授权'}</span>
                    </div>
                  </div>
                </div>

                {oauthAuthorizeUrl ? (
                  <Button asChild>
                    <a href={oauthAuthorizeUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      前往授权
                    </a>
                  </Button>
                ) : (
                  <Button disabled>请先保存配置</Button>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* 步骤 4：初始化数据库 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              {renderStepIndicator(
                4,
                calculateStepStatus(
                  4,
                  integration,
                  detail?.checks,
                  detail?.authorization,
                  hasSavedCredentials,
                  hasTechConfigCompleted
                )
              )}
              {integration?.initializedAt && (
                <Badge className="bg-emerald-100 text-emerald-700">已初始化</Badge>
              )}
            </div>
            <CardDescription className="pt-2">
              创建数据表来存储会议分析结果
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!detail?.authorization?.status || detail.authorization.status !== 'authorized' ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-500">
                请先完成第 3 步授权
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-slate-200 p-4">
                  <div className="mb-3 text-sm font-medium">当前状态</div>
                  <div className="space-y-2 text-sm text-slate-600">
                    <div className="flex items-center justify-between">
                      <span>Base Token</span>
                      <span>{integration?.masked.baseAppToken || '未设置'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>数据表 ID</span>
                      <span>{integration?.meetingTableId || '未设置'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>初始化时间</span>
                      <span>{formatDateTime(integration?.initializedAt || null)}</span>
                    </div>
                  </div>
                </div>

                <Button
                  onClick={() => void handleInitializeBase()}
                  disabled={isInitializingBase || isLoadingDetail}
                >
                  {isInitializingBase ? '初始化中...' : '一键初始化'}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {/* 步骤 5：检查配置 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              {renderStepIndicator(
                5,
                calculateStepStatus(
                  5,
                  integration,
                  detail?.checks,
                  detail?.authorization,
                  hasSavedCredentials,
                  hasTechConfigCompleted
                )
              )}
              {detail?.checks?.allPassed && (
                <Badge className="bg-emerald-100 text-emerald-700">全部通过</Badge>
              )}
            </div>
            <CardDescription className="pt-2">
              验证所有配置是否正确
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!integration?.initializedAt ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-500">
                请先完成第 4 步初始化
              </div>
            ) : (
              <>
                {/* 检查进度条 */}
                <div className="space-y-3">
                  {[
                    { label: '应用凭证', status: detail?.checks?.appCredentialStatus },
                    { label: '权限配置', status: detail?.checks?.permissionStatus },
                    { label: '事件订阅', status: detail?.checks?.eventSubscriptionStatus },
                    { label: 'Webhook', status: detail?.checks?.webhookStatus },
                    { label: 'OAuth', status: detail?.checks?.oauthStatus },
                    { label: '数据库', status: detail?.checks?.baseStatus },
                  ].map(({ label, status }) => (
                    <div key={label} className="flex items-center gap-3">
                      <div className="w-24 text-sm text-slate-600">{label}</div>
                      <div className="flex-1">
                        <div className={`h-2 rounded-full ${getStatusColor(status)}`}
                          style={{ width: status === 'passed' || status === 'success' ? '100%' : '30%', opacity: status ? 1 : 0.3 }}
                        />
                      </div>
                      <Badge variant="outline" className={`text-xs ${getStatusBadgeClass(status)}`}>
                        {getStatusLabel(status)}
                      </Badge>
                    </div>
                  ))}
                </div>

                <Separator />

                <Button
                  variant="outline"
                  onClick={() => void handleRunChecks()}
                  disabled={isRunningChecks || isLoadingDetail}
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${isRunningChecks ? 'animate-spin' : ''}`} />
                  {isRunningChecks ? '检查中...' : '重新检查'}
                </Button>

                {detail?.checks?.lastCheckedAt && (
                  <div className="text-xs text-slate-500">
                    上次检查：{formatDateTime(detail.checks.lastCheckedAt)}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

      </div>
    </Layout>
  );
}
