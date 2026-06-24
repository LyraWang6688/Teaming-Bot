'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Layout from '@/components/Layout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  LogOut,
  RefreshCw,
  User,
  ChevronDown,
  ChevronRight,
  Mail,
  Key,
  Settings,
  Shield,
  Database,
} from 'lucide-react';

// ============ 常量定义 ============
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
function calculateStepStatus(step: number, integration: IntegrationView | null, checks: CheckStatusView | null | undefined, authorization: AuthorizationView | null | undefined) {
  switch (step) {
    case 1: // 登录
      return 'completed';
    case 2: // 配置飞书应用
      return integration?.appId ? 'completed' : 'current';
    case 3: // OAuth 授权
      if (!integration?.appId) return 'pending';
      return authorization?.status === 'authorized' ? 'completed' : 'current';
    case 4: // 初始化
      if (!authorization?.status) return 'pending';
      return integration?.initializedAt ? 'completed' : 'current';
    case 5: // 检查
      if (!integration?.initializedAt) return 'pending';
      return checks ? 'current' : 'pending';
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

  // 操作状态
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [isInitializingBase, setIsInitializingBase] = useState(false);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  // UI 状态
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    basic: true,
    secrets: false,
    advanced: false,
  });

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

  // 计算步骤进度
  const currentStep = useMemo(() => {
    if (!user) return 1;
    if (!integration?.appId) return 2;
    if (!detail?.authorization?.status || detail.authorization.status !== 'authorized') return 3;
    if (!integration?.initializedAt) return 4;
    return 5;
  }, [user, integration, detail]);

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

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
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

  const ensureIntegrationExists = useCallback(async () => {
    if (integration?.id) return integration.id;
    
    try {
      const data = await parseJsonResponse<IntegrationView>(
        await fetch('/api/feishu/integrations', {
          method: 'GET',
          cache: 'no-store',
        })
      );
      
      if (data && 'id' in data) {
        const list = data as unknown as IntegrationView[];
        if (Array.isArray(list) && list.length > 0) {
          await loadIntegrationDetail(list[0].id);
          return list[0].id;
        }
      }
      
      // 创建新集成
      const newIntegration = await parseJsonResponse<IntegrationView>(
        await fetch('/api/feishu/integrations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '我的飞书集成' }),
        })
      );
      await loadIntegrationDetail(newIntegration.id);
      return newIntegration.id;
    } catch {
      // 如果创建失败，返回 null
      return null;
    }
  }, [integration, loadIntegrationDetail]);

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
          await ensureIntegrationExists();
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
  }, [ensureIntegrationExists]);

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
      setForm(EMPTY_FORM);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '退出登录失败。');
    } finally {
      setIsSigningOut(false);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPageMessage(null);
    setPageError(null);

    if (!integration?.id) {
      setPageError('请先确保集成已创建。');
      return;
    }

    if (!form.name.trim() || !form.appId.trim()) {
      setPageError('请填写应用名称和 App ID。');
      return;
    }

    const payload: Record<string, string | null> = {
      name: form.name.trim(),
      appId: form.appId.trim(),
      meetingTableId: form.meetingTableId.trim() || null,
    };

    if (form.appSecret.trim()) payload.appSecret = form.appSecret.trim();
    if (form.webhookVerificationToken.trim()) payload.webhookVerificationToken = form.webhookVerificationToken.trim();
    if (form.baseAppToken.trim()) payload.baseAppToken = form.baseAppToken.trim();
    if (form.oauthScope.trim()) payload.oauthScope = form.oauthScope.trim();

    setIsSaving(true);
    try {
      await parseJsonResponse<IntegrationView>(
        await fetch(`/api/feishu/integrations/${integration.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      );
      await loadIntegrationDetail(integration.id);
      setPageMessage('配置已保存。');
      setForm((current) => ({ ...current, appSecret: '', webhookVerificationToken: '', baseAppToken: '' }));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setIsSaving(false);
    }
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
              {renderStepIndicator(2, calculateStepStatus(2, integration, detail?.checks, detail?.authorization))}
              {integration?.appId && (
                <Badge className="bg-emerald-100 text-emerald-700">已完成</Badge>
              )}
            </div>
            <CardDescription className="pt-2">
              填写你的飞书应用信息，你可以去{' '}
              <a
                href="https://open.feishu.cn/app"
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:underline"
              >
                飞书开放平台
              </a>{' '}
              创建应用获取这些信息
            </CardDescription>
          </CardHeader>
          <CardContent>
            {authLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : !user ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-500">
                请先完成第 1 步登录
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Webhook 地址 */}
                <div className="rounded-lg bg-blue-50 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-900">
                    <ExternalLink className="h-4 w-4" />
                    Webhook 回调地址（需要填写到飞书应用后台）
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded bg-white px-3 py-2 text-xs">{webhookUrl}</code>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void copyToClipboard('webhook', webhookUrl)}
                    >
                      {copiedKey === 'webhook' ? '已复制' : '复制'}
                    </Button>
                  </div>
                </div>

                {/* 基础配置 */}
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => toggleSection('basic')}
                    className="flex w-full items-center gap-2 text-sm font-medium text-slate-900"
                  >
                    {expandedSections.basic ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    基础配置
                  </button>
                  {expandedSections.basic && (
                    <div className="space-y-4 pl-6">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="name">应用名称</Label>
                          <Input
                            id="name"
                            value={form.name}
                            onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
                            placeholder="我的会议分析应用"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="appId">App ID</Label>
                          <Input
                            id="appId"
                            value={form.appId}
                            onChange={(e) => setForm((c) => ({ ...c, appId: e.target.value }))}
                            placeholder="cli_xxx"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                {/* 密钥配置 */}
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => toggleSection('secrets')}
                    className="flex w-full items-center gap-2 text-sm font-medium text-slate-900"
                  >
                    {expandedSections.secrets ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    密钥配置
                    {integration?.masked.appSecret && (
                      <Badge variant="outline" className="ml-2 text-xs">已配置</Badge>
                    )}
                  </button>
                  {expandedSections.secrets && (
                    <div className="space-y-4 pl-6">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="appSecret">App Secret</Label>
                          <Input
                            id="appSecret"
                            type="password"
                            value={form.appSecret}
                            onChange={(e) => setForm((c) => ({ ...c, appSecret: e.target.value }))}
                            placeholder={integration?.masked.appSecret ? '已保存，输入新值可更新' : '请输入'}
                          />
                          {integration?.masked.appSecret && (
                            <div className="text-xs text-slate-500">已保存：{integration.masked.appSecret}</div>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="webhookToken">Webhook 验证 Token</Label>
                          <Input
                            id="webhookToken"
                            type="password"
                            value={form.webhookVerificationToken}
                            onChange={(e) => setForm((c) => ({ ...c, webhookVerificationToken: e.target.value }))}
                            placeholder={integration?.masked.webhookVerificationToken ? '已保存，输入新值可更新' : '请输入'}
                          />
                          {integration?.masked.webhookVerificationToken && (
                            <div className="text-xs text-slate-500">已保存：{integration.masked.webhookVerificationToken}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                {/* 高级配置 */}
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => toggleSection('advanced')}
                    className="flex w-full items-center gap-2 text-sm font-medium text-slate-900"
                  >
                    {expandedSections.advanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    高级配置（可选）
                  </button>
                  {expandedSections.advanced && (
                    <div className="space-y-4 pl-6">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="baseAppToken">Base App Token</Label>
                          <Input
                            id="baseAppToken"
                            type="password"
                            value={form.baseAppToken}
                            onChange={(e) => setForm((c) => ({ ...c, baseAppToken: e.target.value }))}
                            placeholder="appcnxxxx"
                          />
                          {integration?.masked.baseAppToken && (
                            <div className="text-xs text-slate-500">已保存：{integration.masked.baseAppToken}</div>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="tableId">数据表 ID</Label>
                          <Input
                            id="tableId"
                            value={form.meetingTableId}
                            onChange={(e) => setForm((c) => ({ ...c, meetingTableId: e.target.value }))}
                            placeholder="tblxxxx"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex gap-2 pt-2">
                  <Button type="submit" disabled={isSaving}>
                    {isSaving ? '保存中...' : '保存配置'}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>

        {/* 步骤 3：授权飞书账号 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              {renderStepIndicator(3, calculateStepStatus(3, integration, detail?.checks, detail?.authorization))}
              {detail?.authorization?.status === 'authorized' && (
                <Badge className="bg-emerald-100 text-emerald-700">已授权</Badge>
              )}
            </div>
            <CardDescription className="pt-2">
              授权应用访问你的飞书账号，这是分析会议的基础
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!integration?.appId ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-500">
                请先完成第 2 步配置
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
              {renderStepIndicator(4, calculateStepStatus(4, integration, detail?.checks, detail?.authorization))}
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
              {renderStepIndicator(5, calculateStepStatus(5, integration, detail?.checks, detail?.authorization))}
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

        {/* 权限列表（折叠） */}
        <Card>
          <CardHeader className="pb-3">
            <button
              type="button"
              onClick={() => toggleSection('permissions')}
              className="flex w-full items-center justify-between"
            >
              <CardTitle className="text-base">技术配置参考</CardTitle>
              {expandedSections.permissions !== false && <ChevronDown className="h-4 w-4" />}
              {expandedSections.permissions === false && <ChevronRight className="h-4 w-4" />}
            </button>
            <CardDescription>这些信息用于在飞书开放平台配置应用</CardDescription>
          </CardHeader>
          {expandedSections.permissions !== false && (
            <CardContent className="space-y-6">
              <div>
                <div className="mb-2 text-sm font-medium">需要的权限</div>
                <div className="space-y-1">
                  {REQUIRED_PERMISSIONS.map((p) => (
                    <div key={p} className="rounded bg-slate-50 px-3 py-1.5 font-mono text-xs">{p}</div>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-sm font-medium">需要的事件</div>
                <div className="space-y-2">
                  {REQUIRED_EVENTS.map((event) => (
                    <div key={event.id} className="rounded bg-slate-50 p-3">
                      <div className="font-medium text-sm">{event.name}</div>
                      <div className="font-mono text-xs text-slate-500">{event.id}</div>
                      <div className="mt-1 text-xs text-slate-500">{event.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </Layout>
  );
}
