'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Layout from '@/components/Layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertCircle,
  ArrowRight,
  Check,
  ExternalLink,
  LogOut,
  RefreshCw,
  Rocket,
  Shield,
  Table,
  User,
  QrCode,
} from 'lucide-react';

const DEFAULT_USER_OAUTH_SCOPE =
  'minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app';

const OAUTH_SCOPE_DESCRIPTIONS: Record<string, string> = {
  'minutes:minutes.basic:read': '获取妙记基本信息',
  'minutes:minutes.transcript:export': '导出妙记转写文字',
  offline_access: '持续访问已授权数据',
  'bitable:app': '多维表格（查看、评论、编辑）',
};

type StepDisplayStatus = 'completed' | 'current' | 'pending';
type SummaryTone = 'slate' | 'indigo' | 'amber' | 'emerald';

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
  createdAt: string;
  updatedAt: string;
  links: {
    baseUrl: string | null;
  };
  masked: {
    appSecret: string | null;
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
  oauthStatus: string;
  baseStatus: string;
  allPassed: boolean;
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

type SetupSummary = {
  tone: SummaryTone;
  title: string;
  description: string;
};

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

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: T; error?: string }
    | null;
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error || '请求失败，请稍后重试。');
  }
  return payload.data as T;
}

function getStepTitle(step: number) {
  switch (step) {
    case 1:
      return '创建应用并登录';
    case 2:
      return '创建飞书应用';
    case 3:
      return '完成授权';
    case 4:
      return '初始化多维表格';
    default:
      return '';
  }
}

function getStepDescription(step: number) {
  switch (step) {
    case 1:
      return '扫码创建你的飞书应用，系统自动完成配置。';
    case 2:
      return '扫码创建你的飞书应用，系统自动完成配置。';
    case 3:
      return '点击授权，飞书将发送授权卡片到你的客户端。';
    case 4:
      return '初始化多维表格，自动创建会议信息表。';
    default:
      return '';
  }
}

function buildSetupSummary(options: {
  user: AuthUser | null;
  integration: IntegrationView | null;
  authorization: AuthorizationView | null | undefined;
  checks: CheckStatusView | null | undefined;
  isRunningChecks: boolean;
}): SetupSummary {
  if (!options.user) {
    return {
      tone: 'indigo',
      title: '请先登录',
      description: '创建你的飞书应用后即可开始配置，全程自动完成。',
    };
  }

  if (!options.integration) {
    return {
      tone: 'indigo',
      title: '完成配置',
      description: '点击按钮，系统将自动为你创建飞书应用并配置所需权限。',
    };
  }

  if (!options.authorization || options.authorization.status !== 'authorized') {
    return {
      tone: 'indigo',
      title: '完成飞书授权',
      description: '点击授权按钮，飞书将发送授权卡片到你的客户端，请确认授权。',
    };
  }

  if (!options.integration.initializedAt) {
    return {
      tone: 'indigo',
      title: '初始化多维表格',
      description: '点击按钮，系统将自动创建会议信息表。',
    };
  }

  if (options.checks?.allPassed) {
    return {
      tone: 'emerald',
      title: '配置完成，可以开始使用',
      description: '系统将自动监听并分析后续会议。',
    };
  }

  if (options.isRunningChecks) {
    return {
      tone: 'amber',
      title: '系统正在自动校验',
      description: '正在后台检查各项配置是否正常。',
    };
  }

  return {
    tone: 'amber',
    title: '等待系统完成校验',
    description: '配置步骤已完成，系统正在确认各项状态。',
  };
}

function getSummaryToneClasses(tone: SummaryTone) {
  switch (tone) {
    case 'emerald':
      return {
        badge: 'bg-emerald-100 text-emerald-700',
        panel: 'border-emerald-200 bg-emerald-50',
        title: 'text-emerald-900',
        text: 'text-emerald-800',
      };
    case 'amber':
      return {
        badge: 'bg-amber-100 text-amber-700',
        panel: 'border-amber-200 bg-amber-50',
        title: 'text-amber-900',
        text: 'text-amber-800',
      };
    case 'indigo':
      return {
        badge: 'bg-indigo-100 text-indigo-700',
        panel: 'border-indigo-200 bg-indigo-50',
        title: 'text-indigo-900',
        text: 'text-indigo-800',
      };
    default:
      return {
        badge: 'bg-slate-100 text-slate-700',
        panel: 'border-slate-200 bg-slate-50',
        title: 'text-slate-900',
        text: 'text-slate-700',
      };
  }
}

function StepHeader(props: {
  step: number;
  status: StepDisplayStatus;
  description: string;
  badgeText?: string;
}) {
  const { step, status, description, badgeText } = props;
  const isCompleted = status === 'completed';
  const isCurrent = status === 'current';

  return (
    <CardHeader className="pb-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium ${
              isCompleted
                ? 'bg-emerald-500 text-white'
                : isCurrent
                  ? 'bg-indigo-500 text-white'
                  : 'bg-slate-200 text-slate-500'
            }`}
          >
            {isCompleted ? <Check className="h-4 w-4" /> : step}
          </div>
          <div>
            <div
              className={`font-medium ${
                isCompleted
                  ? 'text-emerald-700'
                  : isCurrent
                    ? 'text-indigo-700'
                    : 'text-slate-500'
              }`}
            >
              {getStepTitle(step)}
            </div>
            <CardDescription className="pt-1">{description}</CardDescription>
          </div>
        </div>
        {badgeText ? (
          <Badge className={isCompleted ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
            {badgeText}
          </Badge>
        ) : null}
      </div>
    </CardHeader>
  );
}

export default function FeishuConfigWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const autoCheckKeyRef = useRef<string | null>(null);

  const [origin, setOrigin] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  const [integration, setIntegration] = useState<IntegrationView | null>(null);
  const [detail, setDetail] = useState<IntegrationDetailResponse | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);

  const [isCreatingApp, setIsCreatingApp] = useState(false);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isInitializingBase, setIsInitializingBase] = useState(false);

  const [pageError, setPageError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [registrationQrUrl, setRegistrationQrUrl] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentStep = useMemo(() => {
    if (!user) return 1;
    if (!integration) return 2;
    if (!detail?.authorization || detail.authorization.status !== 'authorized') return 3;
    if (!integration.initializedAt) return 4;
    return 4;
  }, [user, integration, detail?.authorization?.status]);

  const sidebarSteps = useMemo(() => {
    const steps = [
      {
        step: 1,
        anchor: 'step-login',
        title: '创建应用并登录',
        description: '使用飞书账号登录',
        status: user ? 'completed' : 'current',
      },
      {
        step: 2,
        anchor: 'step-create-app',
        title: '完成配置',
        description: '应用创建并授权',
        status: integration ? 'completed' : user ? 'current' : 'pending',
      },
      {
        step: 3,
        anchor: 'step-authorize',
        title: '完成授权',
        description: '点击授权卡片',
        status: (detail?.authorization?.status === 'authorized') ? 'completed' : integration ? 'current' : 'pending',
      },
      {
        step: 4,
        anchor: 'step-base',
        title: '初始化表格',
        description: '创建会议信息表',
        status: integration?.initializedAt ? 'completed' : (detail?.authorization?.status === 'authorized') ? 'current' : 'pending',
      },
    ];
    return steps;
  }, [user, integration, detail?.authorization?.status]);

  const effectiveOauthScopes = useMemo(() => {
    const scope = integration?.oauthScope || DEFAULT_USER_OAUTH_SCOPE;
    return scope.split(/\s+/).filter(Boolean);
  }, [integration?.oauthScope]);

  const eventListenerStatus = useMemo(() => {
    return detail?.checks?.eventSubscriptionStatus === 'success' ? '已连接' : '未连接';
  }, [detail?.checks?.eventSubscriptionStatus]);

  const setupSummary = useMemo(() => {
    return buildSetupSummary({
      user,
      integration,
      authorization: detail?.authorization,
      checks: detail?.checks,
      isRunningChecks,
    });
  }, [user, integration, detail?.authorization, detail?.checks, isRunningChecks]);

  const summaryToneClasses = useMemo(() => getSummaryToneClasses(setupSummary.tone), [setupSummary.tone]);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    setAuthLoading(true);
    void (async () => {
      try {
        const response = await fetch('/api/auth/me');
        const payload = (await response.json().catch(() => null)) as
          | { success?: boolean; data?: AuthUser | null }
          | null;
        if (payload?.success) {
          setUser(payload.data ?? null);
          if (payload.data) {
            await loadIntegrationDetail(null);
          }
        }
      } catch (error) {
        console.error('[auth:me] 获取用户信息失败', error);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const authCode = searchParams.get('code');
    if (authCode && integration?.id) {
      void runAutomatedChecks(integration.id, { silent: true });
    }
  }, [searchParams]);

  const loadIntegrationDetail = useCallback(
    async (integrationId: string | null) => {
      if (!user) return;

      setIsLoadingDetail(true);
      setPageError(null);

      try {
        const listResponse = await fetch('/api/feishu/integrations');
        const listPayload = (await listResponse.json().catch(() => null)) as
          | { success?: boolean; data?: IntegrationView[] }
          | null;

        if (!listPayload?.success) {
          setIntegration(null);
          setDetail(null);
          return;
        }

        const integrations = listPayload.data || [];
        const targetId = integrationId || integrations[0]?.id;

        if (!targetId) {
          setIntegration(null);
          setDetail(null);
          return;
        }

        const detailResponse = await fetch(`/api/feishu/integrations/${targetId}`);
        const detailPayload = (await detailResponse.json().catch(() => null)) as
          | { success?: boolean; data?: IntegrationDetailResponse }
          | null;

        if (!detailPayload?.success) {
          setIntegration(integrations.find((i) => i.id === targetId) || null);
          setDetail(null);
          return;
        }

        const detailData = detailPayload.data;
        if (!detailData) {
          setIntegration(integrations.find((i) => i.id === targetId) || null);
          setDetail(null);
          return;
        }

        setIntegration(detailData.integration);
        setDetail(detailData);
      } catch (error) {
        setPageError(error instanceof Error ? error.message : '加载配置失败。');
      } finally {
        setIsLoadingDetail(false);
      }
    },
    [user]
  );

  const autoCheckTriggerKey = useMemo(() => {
    if (!integration?.id) return '';
    return [
      integration.id,
      integration.initializedAt,
      detail?.authorization?.updatedAt ?? 'no-oauth-update',
    ].join(':');
  }, [detail?.authorization?.updatedAt, integration?.id, integration?.initializedAt]);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    setPageError(null);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      setUser(null);
      setIntegration(null);
      setDetail(null);
      router.push('/feishu-config');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '退出登录失败。');
    } finally {
      setIsSigningOut(false);
    }
  };

  const handleCreateApp = async () => {
    setPageError(null);
    setRegistrationQrUrl(null);
    setVerificationUrl(null);
    try {
      const result = await parseJsonResponse<{
        deviceCode: string;
        verificationUrl: string;
        expiresIn: number;
        interval: number;
      }>(await fetch('/api/feishu/integrations/create-app', { method: 'POST' }));
      
      setVerificationUrl(result.verificationUrl);
      setRegistrationQrUrl(result.verificationUrl);
      
      const intervalMs = Math.max((result.interval || 5) * 1000, 3000);
      
      const poll = async () => {
        try {
          const pollRes = await fetch('/api/feishu/integrations/register/poll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceCode: result.deviceCode }),
          });
          const pollData = await pollRes.json();
          
          if (pollData.status === 'completed') {
            if (pollRef.current) clearInterval(pollRef.current);
            window.location.reload();
          } else if (pollData.status === 'denied' || pollData.status === 'expired') {
            if (pollRef.current) clearInterval(pollRef.current);
            setRegistrationQrUrl(null);
            setPageError(pollData.error || '创建失败');
          }
        } catch (e) {
          console.error('[poll]', e);
        }
      };
      
      pollRef.current = setInterval(poll, intervalMs);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '创建应用失败。');
    }
  };

  const handleAuthorize = async () => {
    if (!integration?.id) return;
    setIsAuthorizing(true);
    setPageError(null);
    try {
      await parseJsonResponse(
        await fetch(`/api/feishu/integrations/${integration.id}/authorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ integrationId: integration.id }),
        })
      );
      await loadIntegrationDetail(integration.id);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '推送授权失败。');
    } finally {
      setIsAuthorizing(false);
    }
  };

  const handleRefreshIntegration = async () => {
    if (!integration?.id) return;
    setPageError(null);
    await loadIntegrationDetail(integration.id);
  };

  const runAutomatedChecks = useCallback(
    async (integrationId: string, options?: { silent?: boolean }) => {
      setIsRunningChecks(true);
      if (!options?.silent) {
        setPageError(null);
      }
      try {
        await parseJsonResponse<{ allPassed: boolean }>(
          await fetch(`/api/feishu/integrations/${integrationId}/checks`, { method: 'POST' })
        );
        await loadIntegrationDetail(integrationId);
      } catch (error) {
        if (!options?.silent) {
          setPageError(error instanceof Error ? error.message : '系统内部校验失败。');
        }
      } finally {
        setIsRunningChecks(false);
      }
    },
    [loadIntegrationDetail]
  );

  useEffect(() => {
    if (!integration?.id || !autoCheckTriggerKey || isRunningChecks) {
      return;
    }

    if (autoCheckKeyRef.current === autoCheckTriggerKey) {
      return;
    }

    autoCheckKeyRef.current = autoCheckTriggerKey;
    void runAutomatedChecks(integration.id, { silent: true });
  }, [autoCheckTriggerKey, integration?.id, isRunningChecks, runAutomatedChecks]);

  const handleInitializeBase = async () => {
    if (!integration?.id) return;
    setIsInitializingBase(true);
    setPageError(null);
    try {
      await parseJsonResponse<{
        appToken: string;
        tableId: string;
        createdFields: string[];
        checkResult?: {
          allPassed: boolean;
        };
      }>(
        await fetch(`/api/feishu/integrations/${integration.id}/base/initialize`, { method: 'POST' })
      );
      await loadIntegrationDetail(integration.id);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '初始化失败。');
    } finally {
      setIsInitializingBase(false);
    }
  };

  return (
    <Layout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-slate-900">飞书集成配置</h1>
          <p className="text-slate-600">完成以下 4 个步骤，让系统自动监听并分析你的飞书会议。</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="space-y-4 self-start lg:sticky lg:top-24">
            <Card className={summaryToneClasses.panel}>
              <CardContent className="space-y-3 pt-6">
                <Badge className={summaryToneClasses.badge}>当前状态</Badge>
                <div className={`text-base font-semibold ${summaryToneClasses.title}`}>{setupSummary.title}</div>
                <p className={`text-sm leading-6 ${summaryToneClasses.text}`}>{setupSummary.description}</p>
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <span>当前进度</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                  <span>第 {currentStep} 步 / 共 4 步</span>
                </div>
                {detail?.checks?.allPassed ? (
                  <div className="rounded-lg border border-emerald-200 bg-white/70 p-3 text-sm text-emerald-800">
                    系统内部校验已通过，你可以开始使用系统了。
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="space-y-4">
                  {sidebarSteps.map((item, index) => {
                    const isCompleted = item.status === 'completed';
                    const isCurrent = item.status === 'current';
                    return (
                      <a key={item.step} href={`#${item.anchor}`} className="flex gap-3 rounded-lg p-1 transition hover:bg-slate-50">
                        <div className="flex flex-col items-center">
                          <div
                            className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium ${
                              isCompleted
                                ? 'bg-emerald-500 text-white'
                                : isCurrent
                                  ? 'bg-indigo-500 text-white'
                                  : 'bg-slate-200 text-slate-500'
                            }`}
                          >
                            {isCompleted ? <Check className="h-4 w-4" /> : item.step}
                          </div>
                          {index < sidebarSteps.length - 1 ? (
                            <div className={`mt-2 h-10 w-px ${isCompleted ? 'bg-emerald-300' : 'bg-slate-200'}`} />
                          ) : null}
                        </div>
                        <div className="pb-2">
                          <div
                            className={`text-sm font-medium ${
                              isCompleted
                                ? 'text-emerald-700'
                                : isCurrent
                                  ? 'text-indigo-700'
                                  : 'text-slate-500'
                            }`}
                          >
                            {item.title}
                          </div>
                          <div className="mt-1 text-xs leading-5 text-slate-500">{item.description}</div>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </aside>

          <div className="space-y-6">
            {pageError ? (
              <Alert className="border-red-200 bg-red-50">
                <AlertCircle className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-800">{pageError}</AlertDescription>
              </Alert>
            ) : null}

            <Card>
              <CardContent className="space-y-6">
                {authLoading ? (
                  <div className="space-y-4">
                    <Skeleton className="h-8 w-32" />
                    <Skeleton className="h-48 w-full" />
                  </div>
                ) : !user ? (
                  <div id="step-login" className="flex flex-col items-center justify-center py-12">
                    <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-100">
                      <User className="h-8 w-8 text-indigo-600" />
                    </div>
                    <h3 className="mb-2 text-lg font-semibold text-slate-900">创建应用并登录</h3>
                    <p className="mb-6 text-center text-sm text-slate-500">
                      点击按钮后使用飞书扫码，系统将自动为你创建应用并完成配置。
                    </p>
                    <Button onClick={handleCreateApp} className="w-full max-w-xs">
                      <QrCode className="mr-2 h-4 w-4" />
                      创建应用并登录
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 text-sm font-medium text-indigo-700">
                          <User className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="font-medium text-slate-900">已登录</div>
                          <div className="text-xs text-slate-500">{user.email || '飞书用户'}</div>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={handleSignOut} disabled={isSigningOut}>
                        <LogOut className="mr-1.5 h-3.5 w-3.5" />
                        {isSigningOut ? '退出中...' : '退出'}
                      </Button>
                    </div>

                    <Separator />

                    <div id="step-create-app">
                      <StepHeader
                        step={2}
                        status={integration ? 'completed' : 'current'}
                        description={getStepDescription(2)}
                      />
                      <CardContent>
                        {!integration ? (
                          <div className="space-y-4">
                            <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50 p-6 text-center">
                              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-sm">
                                <Rocket className="h-8 w-8 text-indigo-600" />
                              </div>
                              <h3 className="mb-2 text-lg font-semibold text-slate-900">创建飞书应用</h3>
                              <p className="mb-6 text-sm text-slate-600">
                                点击下方按钮，系统将自动完成以下操作：
                              </p>
                              <ul className="mb-6 text-left text-sm text-slate-600 space-y-2">
                                <li className="flex items-center gap-2">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  创建飞书应用（App ID + App Secret）
                                </li>
                                <li className="flex items-center gap-2">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  配置应用权限（多维表格）
                                </li>
                                <li className="flex items-center gap-2">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  订阅妙记生成事件（minutes.minute.generated_v1）
                                </li>
                                <li className="flex items-center gap-2">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  配置 OAuth 重定向地址
                                </li>
                              </ul>
                              <Button onClick={handleCreateApp} disabled={isCreatingApp} className="w-full">
                                {isCreatingApp ? (
                                  <>
                                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                    创建中...
                                  </>
                                ) : (
                                  <>
                                    <Rocket className="mr-2 h-4 w-4" />
                                    创建飞书应用
                                  </>
                                )}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-4">
                            <div className="rounded-lg bg-emerald-50 p-4">
                              <div className="flex items-center gap-2 mb-2">
                                <Check className="h-4 w-4 text-emerald-600" />
                                <span className="font-medium text-emerald-900">应用已创建</span>
                              </div>
                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                  <div className="text-xs text-emerald-600 mb-1">应用名称</div>
                                  <div className="font-medium text-emerald-900">{integration.name}</div>
                                </div>
                                <div>
                                  <div className="text-xs text-emerald-600 mb-1">App ID</div>
                                  <div className="font-mono text-sm text-emerald-900">{integration.appId}</div>
                                </div>
                              </div>
                            </div>

                            <div className="rounded-lg border border-slate-200 p-4">
                              <div className="mb-3 flex items-center justify-between">
                                <div className="text-sm font-medium text-slate-900">事件监听配置</div>
                                <Badge
                                  variant="outline"
                                  className={getStatusBadgeClass(
                                    detail?.checks?.eventSubscriptionStatus
                                  )}
                                >
                                  {eventListenerStatus}
                                </Badge>
                              </div>
                              <div className="space-y-2 text-sm text-slate-600">
                                <div>
                                  <span className="text-xs text-slate-500">事件名称：</span>
                                  <code className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs">minutes.minute.generated_v1</code>
                                </div>
                                <div className="text-xs text-slate-500">
                                  系统通过飞书 CLI 自动监听妙记生成事件。
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </div>

                    <Separator />

                    <div id="step-authorize">
                      <StepHeader
                        step={3}
                        status={(detail?.authorization?.status === 'authorized') ? 'completed' : 'current'}
                        description={getStepDescription(3)}
                      />
                      <CardContent>
                        {!integration ? (
                          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
                            <div className="mb-2 text-sm font-medium text-slate-500">请先创建飞书应用</div>
                          </div>
                        ) : detail?.authorization?.status === 'authorized' ? (
                          <div className="space-y-4">
                            <div className="rounded-lg bg-emerald-50 p-4">
                              <div className="flex items-center gap-2 mb-2">
                                <Check className="h-4 w-4 text-emerald-600" />
                                <span className="font-medium text-emerald-900">已完成授权</span>
                              </div>
                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                  <div className="text-xs text-emerald-600 mb-1">授权用户</div>
                                  <div className="font-medium text-emerald-900">{detail.authorization.authorizedUserName || '未知'}</div>
                                </div>
                                <div>
                                  <div className="text-xs text-emerald-600 mb-1">授权时间</div>
                                  <div className="font-medium text-emerald-900">{formatDateTime(detail.authorization.updatedAt)}</div>
                                </div>
                              </div>
                            </div>

                            <div className="rounded-lg border border-slate-200 p-4">
                              <div className="mb-3 text-sm font-medium text-slate-900">已授权权限</div>
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
                        ) : (
                          <div className="space-y-4">
                            <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50 p-6 text-center">
                              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-sm">
                                <Shield className="h-8 w-8 text-indigo-600" />
                              </div>
                              <h3 className="mb-2 text-lg font-semibold text-slate-900">完成飞书授权</h3>
                              <p className="mb-6 text-sm text-slate-600">
                                点击下方按钮，飞书将发送授权卡片到你的客户端，请确认授权。
                              </p>
                              <ul className="mb-6 text-left text-sm text-slate-600 space-y-2">
                                <li className="flex items-center gap-2">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  获取妙记基本信息
                                </li>
                                <li className="flex items-center gap-2">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  导出妙记转写文字
                                </li>
                                <li className="flex items-center gap-2">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  持续访问已授权数据
                                </li>
                                <li className="flex items-center gap-2">
                                  <Check className="h-4 w-4 text-emerald-500" />
                                  多维表格（查看、评论、编辑）
                                </li>
                              </ul>
                              <Button onClick={handleAuthorize} disabled={isAuthorizing} className="w-full">
                                {isAuthorizing ? (
                                  <>
                                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                    发送授权卡片中...
                                  </>
                                ) : (
                                  <>
                                    <Shield className="mr-2 h-4 w-4" />
                                    发送授权卡片
                                  </>
                                )}
                              </Button>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </div>

                    <Separator />

                    <div id="step-base">
                      <StepHeader
                        step={4}
                        status={integration?.initializedAt ? 'completed' : 'current'}
                        description={getStepDescription(4)}
                      />
                      <CardContent>
                        {!integration || detail?.authorization?.status !== 'authorized' ? (
                          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
                            <div className="mb-2 text-sm font-medium text-slate-500">请先完成前面的步骤</div>
                          </div>
                        ) : !integration.initializedAt ? (
                          <div className="space-y-4">
                            <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50 p-6 text-center">
                              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-sm">
                                <Table className="h-8 w-8 text-indigo-600" />
                              </div>
                              <h3 className="mb-2 text-lg font-semibold text-slate-900">初始化多维表格</h3>
                              <p className="mb-6 text-sm text-slate-600">
                                点击下方按钮，系统将自动创建会议信息表并添加所需字段。
                              </p>
                              <Button onClick={handleInitializeBase} disabled={isInitializingBase} className="w-full">
                                {isInitializingBase ? (
                                  <>
                                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                    初始化中...
                                  </>
                                ) : (
                                  <>
                                    <Table className="mr-2 h-4 w-4" />
                                    初始化多维表格
                                  </>
                                )}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-4">
                            <div className="rounded-lg bg-emerald-50 p-4">
                              <div className="flex items-center gap-2 mb-2">
                                <Check className="h-4 w-4 text-emerald-600" />
                                <span className="font-medium text-emerald-900">多维表格已初始化</span>
                              </div>
                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                  <div className="text-xs text-emerald-600 mb-1">表格链接</div>
                                  <a
                                    href={integration.links.baseUrl ?? undefined}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-medium text-emerald-900 hover:underline flex items-center gap-1"
                                  >
                                    {integration.links.baseUrl || '点击查看'}
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </div>
                                <div>
                                  <div className="text-xs text-emerald-600 mb-1">初始化时间</div>
                                  <div className="font-medium text-emerald-900">{formatDateTime(integration.initializedAt)}</div>
                                </div>
                              </div>
                            </div>

                            {detail?.checks && (
                              <div className="rounded-lg border border-slate-200 p-4">
                                <div className="mb-3 flex items-center justify-between">
                                  <div className="text-sm font-medium text-slate-900">系统校验状态</div>
                                  <Badge
                                    variant="outline"
                                    className={detail.checks.allPassed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}
                                  >
                                    {detail.checks.allPassed ? '全部通过' : '部分失败'}
                                  </Badge>
                                </div>
                                <div className="grid grid-cols-2 gap-3 text-sm">
                                  <div className={`flex items-center gap-2 ${detail.checks.appCredentialStatus === 'success' ? 'text-emerald-600' : 'text-amber-600'}`}>
                                    <div className={`w-2 h-2 rounded-full ${detail.checks.appCredentialStatus === 'success' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                                    应用凭证
                                  </div>
                                  <div className={`flex items-center gap-2 ${detail.checks.oauthStatus === 'authorized' ? 'text-emerald-600' : 'text-amber-600'}`}>
                                    <div className={`w-2 h-2 rounded-full ${detail.checks.oauthStatus === 'authorized' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                                    用户授权
                                  </div>
                                  <div className={`flex items-center gap-2 ${detail.checks.baseStatus === 'success' ? 'text-emerald-600' : 'text-amber-600'}`}>
                                    <div className={`w-2 h-2 rounded-full ${detail.checks.baseStatus === 'success' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                                    多维表格
                                  </div>
                                  <div className={`flex items-center gap-2 ${detail.checks.permissionStatus === 'success' ? 'text-emerald-600' : 'text-amber-600'}`}>
                                    <div className={`w-2 h-2 rounded-full ${detail.checks.permissionStatus === 'success' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                                    权限检查
                                  </div>
                                </div>
                                {!detail.checks.allPassed && detail.checks.lastErrorMessage ? (
                                  <div className="mt-3 text-xs text-red-600">
                                    错误信息：{detail.checks.lastErrorMessage}
                                  </div>
                                ) : null}
                              </div>
                            )}

                            <Button type="button" variant="outline" onClick={() => void handleRefreshIntegration()} disabled={isLoadingDetail}>
                              <RefreshCw className="mr-2 h-4 w-4" />
                              刷新状态
                            </Button>
                          </div>
                        )}
                      </CardContent>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </Layout>
  );
}
