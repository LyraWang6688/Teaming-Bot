'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Layout from '@/components/Layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  AlertCircle,
  ArrowRight,
  Check,
  ExternalLink,
  LogOut,
  RefreshCw,
  User,
} from 'lucide-react';

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
  appId: string;
  appSecret: string;
  webhookVerificationToken: string;
};

type SetupSummary = {
  tone: SummaryTone;
  title: string;
  description: string;
};

const EMPTY_FORM: FormState = {
  appId: '',
  appSecret: '',
  webhookVerificationToken: '',
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

function mapIntegrationToForm(integration: IntegrationView | null): FormState {
  if (!integration) return EMPTY_FORM;
  return {
    appId: integration.appId,
    appSecret: '',
    webhookVerificationToken: '',
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

function getStepTitle(step: number) {
  switch (step) {
    case 1:
      return '登录账号';
    case 2:
      return '配置飞书应用';
    case 3:
      return '授权飞书账号';
    case 4:
      return '初始化多维表格';
    default:
      return '';
  }
}

function getStepDescription(step: number) {
  switch (step) {
    case 1:
      return '登录后才能绑定你的飞书集成。';
    case 2:
      return '保存基础凭证，并去飞书后台补齐配置。';
    case 3:
      return '完成用户授权，系统才能读取会议资源。';
    case 4:
      return '初始化多维表格，随后系统自动完成内部校验。';
    default:
      return '';
  }
}

function buildSetupSummary(options: {
  user: AuthUser | null;
  hasSavedCredentials: boolean;
  hasTechConfigCompleted: boolean;
  authorization: AuthorizationView | null | undefined;
  integration: IntegrationView | null;
  checks: CheckStatusView | null | undefined;
  isRunningChecks: boolean;
}): SetupSummary {
  if (!options.user) {
    return {
      tone: 'indigo',
      title: '先登录账号',
      description: '登录后即可开始绑定飞书应用，完成后续 4 步配置。',
    };
  }

  if (!options.hasSavedCredentials) {
    return {
      tone: 'indigo',
      title: '请先保存基础凭证',
      description: '先保存 App ID、App Secret 和 Verification Token，再去飞书后台补齐事件、权限和重定向 URL。',
    };
  }

  if (!options.hasTechConfigCompleted) {
    return {
      tone: 'amber',
      title: '等待飞书后台配置完成',
      description: '请完成 Webhook、事件订阅、权限和重定向 URL 配置，然后返回页面刷新状态。',
    };
  }

  if (options.authorization?.status !== 'authorized') {
    return {
      tone: 'indigo',
      title: '请完成飞书授权',
      description: '授权完成后会自动返回配置页，继续初始化多维表格。',
    };
  }

  if (!options.integration?.initializedAt) {
    return {
      tone: 'indigo',
      title: '请初始化多维表格',
      description: '初始化完成后，系统会自动在后台校验联通状态。',
    };
  }

  if (options.checks?.allPassed) {
    return {
      tone: 'emerald',
      title: '配置完成，可以开始使用',
      description: '系统将自动监听并分析后续会议，无需再手动执行检查。',
    };
  }

  if (options.isRunningChecks) {
    return {
      tone: 'amber',
      title: '系统正在自动校验',
      description: '正在后台检查凭证、Webhook、OAuth 和多维表格联通状态。',
    };
  }

  return {
    tone: 'amber',
    title: '等待系统完成内部校验',
    description: '用户配置步骤已完成，系统正在后台确认各项状态，请稍候查看结果。',
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
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const autoCheckKeyRef = useRef<string | null>(null);

  const [origin, setOrigin] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginMessage, setLoginMessage] = useState<string | null>(null);

  const [integration, setIntegration] = useState<IntegrationView | null>(null);
  const [detail, setDetail] = useState<IntegrationDetailResponse | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const [isSubmittingCredentials, setIsSubmittingCredentials] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [isInitializingBase, setIsInitializingBase] = useState(false);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

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
      setForm(EMPTY_FORM);
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
          setForm(EMPTY_FORM);
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
    return () => {
      cancelled = true;
    };
  }, [loadSingleIntegration]);

  useEffect(() => {
    const oauthResult = searchParams.get('oauth');
    if (!oauthResult) {
      return;
    }

    if (oauthResult === 'success') {
      setPageMessage('飞书授权成功，请继续初始化多维表格。');
      setPageError(null);
      if (user) {
        void loadSingleIntegration();
      }
    }

    router.replace('/feishu-config', { scroll: false });
  }, [loadSingleIntegration, router, searchParams, user]);

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

  const stepStatuses = useMemo<Record<number, StepDisplayStatus>>(
    () => ({
      1: user ? 'completed' : 'current',
      2: !user ? 'pending' : hasTechConfigCompleted ? 'completed' : 'current',
      3:
        !user || !hasSavedCredentials || !hasTechConfigCompleted
          ? 'pending'
          : detail?.authorization?.status === 'authorized'
            ? 'completed'
            : 'current',
      4:
        detail?.authorization?.status !== 'authorized'
          ? 'pending'
          : integration?.initializedAt
            ? 'completed'
            : 'current',
    }),
    [detail?.authorization?.status, hasSavedCredentials, hasTechConfigCompleted, integration?.initializedAt, user]
  );

  const currentStep = useMemo(() => {
    if (!user) return 1;
    if (stepStatuses[2] !== 'completed') return 2;
    if (stepStatuses[3] !== 'completed') return 3;
    return 4;
  }, [stepStatuses, user]);

  const setupSummary = useMemo(
    () =>
      buildSetupSummary({
        user,
        hasSavedCredentials,
        hasTechConfigCompleted,
        authorization: detail?.authorization,
        integration,
        checks: detail?.checks,
        isRunningChecks,
      }),
    [detail?.authorization, detail?.checks, hasSavedCredentials, hasTechConfigCompleted, integration, isRunningChecks, user]
  );

  const summaryToneClasses = getSummaryToneClasses(setupSummary.tone);

  const sidebarSteps = useMemo(
    () =>
      [1, 2, 3, 4].map((step) => ({
        step,
        anchor: `step-${step}`,
        title: getStepTitle(step),
        description: getStepDescription(step),
        status: stepStatuses[step],
      })),
    [stepStatuses]
  );

  const copyToClipboard = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    } catch {
      setPageError('复制失败，请手动复制。');
    }
  };

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
      name: integration?.name || '默认飞书集成',
      appId: form.appId.trim(),
      appSecret: form.appSecret.trim(),
      webhookVerificationToken: form.webhookVerificationToken.trim(),
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
      setPageMessage('基础凭证已保存，请继续在飞书开放平台完成事件、权限和重定向 URL 配置。');
      setForm((current) => ({
        ...current,
        appId: savedIntegration.appId,
        appSecret: '',
        webhookVerificationToken: '',
      }));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '提交失败。');
    } finally {
      setIsSubmittingCredentials(false);
    }
  };

  const handleRefreshIntegration = async () => {
    if (!integration?.id) return;
    setPageMessage(null);
    setPageError(null);
    await loadIntegrationDetail(integration.id);
  };

  const runAutomatedChecks = useCallback(
    async (integrationId: string, options?: { silent?: boolean }) => {
      setIsRunningChecks(true);
      if (!options?.silent) {
        setPageMessage(null);
        setPageError(null);
      }
      try {
        await parseJsonResponse<{ allPassed: boolean }>(
          await fetch(`/api/feishu/integrations/${integrationId}/checks`, { method: 'POST' })
        );
        await loadIntegrationDetail(integrationId);
        if (!options?.silent) {
          setPageMessage('系统内部校验已更新。');
        }
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
    if (!integration?.id || !integration.initializedAt || detail?.checks?.allPassed || isRunningChecks) {
      return;
    }

    const autoCheckKey = `${integration.id}:${integration.initializedAt}:${detail?.checks?.lastCheckedAt ?? 'never'}`;
    if (autoCheckKeyRef.current === autoCheckKey) {
      return;
    }

    autoCheckKeyRef.current = autoCheckKey;
    void runAutomatedChecks(integration.id, { silent: true });
  }, [
    detail?.checks?.allPassed,
    detail?.checks?.lastCheckedAt,
    integration?.id,
    integration?.initializedAt,
    isRunningChecks,
    runAutomatedChecks,
  ]);

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
        checkResult?: {
          allPassed: boolean;
        };
      }>(
        await fetch(`/api/feishu/integrations/${integration.id}/base/initialize`, { method: 'POST' })
      );
      await loadIntegrationDetail(integration.id);
      setPageMessage(
        result.checkResult?.allPassed
          ? '多维表格初始化完成，系统已完成内部校验，可以开始使用系统。'
          : '多维表格初始化完成，系统正在后台校验联通状态，请稍候查看结果。'
      );
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
            {pageMessage ? (
              <Alert className="border-emerald-200 bg-emerald-50">
                <Check className="h-4 w-4 text-emerald-700" />
                <AlertDescription className="text-emerald-800">{pageMessage}</AlertDescription>
              </Alert>
            ) : null}

            {pageError ? (
              <Alert className="border-red-200 bg-red-50">
                <AlertCircle className="h-4 w-4 text-red-700" />
                <AlertDescription className="text-red-800">{pageError}</AlertDescription>
              </Alert>
            ) : null}

            <Card id="step-1">
              <StepHeader
                step={1}
                status={stepStatuses[1]}
                description="先登录当前账号，再继续绑定飞书应用。"
                badgeText={user ? '已完成' : undefined}
              />
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
                    <p className="text-sm text-slate-600">输入你的邮箱，我们会发送一个登录链接给你。</p>
                    {loginMessage ? (
                      <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{loginMessage}</div>
                    ) : null}
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

            <Card id="step-2">
              <StepHeader
                step={2}
                status={stepStatuses[2]}
                description="先保存基础凭证，再在飞书开放平台完成事件、权限和回调配置。"
                badgeText={hasTechConfigCompleted ? '已完成' : hasSavedCredentials ? '待验证' : undefined}
              />
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
                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label htmlFor="appId">App ID</Label>
                              <Input
                                id="appId"
                                value={form.appId}
                                onChange={(e) => setForm((current) => ({ ...current, appId: e.target.value }))}
                                placeholder="cli_xxx"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="appSecret">App Secret</Label>
                              <Input
                                id="appSecret"
                                type="password"
                                value={form.appSecret}
                                onChange={(e) => setForm((current) => ({ ...current, appSecret: e.target.value }))}
                                placeholder={integration?.masked.appSecret ? '如需替换请输入新值' : '请输入'}
                              />
                              {integration?.masked.appSecret ? (
                                <div className="text-xs text-slate-500">已保存：{integration.masked.appSecret}</div>
                              ) : null}
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="webhookToken">Verification Token</Label>
                            <Input
                              id="webhookToken"
                              type="password"
                              value={form.webhookVerificationToken}
                              onChange={(e) =>
                                setForm((current) => ({ ...current, webhookVerificationToken: e.target.value }))
                              }
                              placeholder={
                                integration?.masked.webhookVerificationToken ? '如需替换请输入新值' : '请输入'
                              }
                            />
                            {integration?.masked.webhookVerificationToken ? (
                              <div className="text-xs text-slate-500">
                                已保存：{integration.masked.webhookVerificationToken}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <Button type="submit" disabled={isSubmittingCredentials}>
                          {isSubmittingCredentials ? '保存中...' : integration?.id ? '更新基础凭证' : '保存基础凭证'}
                        </Button>
                      </form>
                    </div>

                    <Separator />

                    <div className="space-y-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-medium text-indigo-700">
                          2
                        </div>
                        提交信息与通信校验
                      </div>

                      {!hasSavedCredentials ? (
                        <div className="ml-8 rounded-lg border border-dashed border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                          请先保存基础凭证。保存成功后，再到飞书开放平台依次完成下面这些配置。
                        </div>
                      ) : null}

                      <div className="space-y-6 pl-8">
                        <div className="rounded-lg bg-blue-50 p-4">
                          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-900">
                            <ExternalLink className="h-4 w-4" />
                            事件与回调
                          </div>
                          <div className="mb-3 text-xs text-blue-700">订阅方式：将事件发送至开发者服务器</div>
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="w-20 text-xs text-slate-600">请求地址：</span>
                              <code className="flex-1 break-all rounded bg-white px-3 py-1.5 text-xs">{webhookUrl}</code>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void copyToClipboard('webhook', webhookUrl)}
                              >
                                {copiedKey === 'webhook' ? '已复制' : '复制'}
                              </Button>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-20 text-xs text-slate-600">事件名称：</span>
                              <code className="flex-1 rounded bg-white px-3 py-1.5 font-mono text-xs">
                                {REQUIRED_EVENTS[0].id}
                              </code>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-20 text-xs text-slate-600">加密策略：</span>
                              <code className="flex-1 rounded bg-white px-3 py-1.5 text-xs">Verification Token 验证</code>
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

                        <div className="rounded-lg border border-slate-200 p-4">
                          <div className="mb-3 text-sm font-medium text-slate-900">重定向 URL</div>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 break-all rounded bg-slate-50 px-3 py-2 text-xs">{oauthCallbackUrl}</code>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void copyToClipboard('oauth', oauthCallbackUrl)}
                            >
                              {copiedKey === 'oauth' ? '已复制' : '复制'}
                            </Button>
                          </div>
                          <div className="mt-2 text-xs text-slate-500">在飞书开放平台配置网页授权重定向地址时，请填写这个 URL。</div>
                        </div>

                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                          完成上述操作后，请在飞书开放平台创建版本并发布，然后返回这里点击“刷新状态”确认 Webhook 已打通。
                        </div>

                        <div className="rounded-lg border border-slate-200 p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <div className="text-sm font-medium text-slate-900">通信状态</div>
                            <Badge
                              variant="outline"
                              className={getStatusBadgeClass(
                                !hasSavedCredentials
                                  ? 'pending'
                                  : hasWebhookConnected
                                    ? 'success'
                                    : detail?.checks?.webhookStatus || 'pending'
                              )}
                            >
                              {!hasSavedCredentials ? '待保存基础凭证' : hasWebhookConnected ? '已打通' : '待验证'}
                            </Badge>
                          </div>
                          <div className="space-y-2 text-sm text-slate-600">
                            <div>最近收到 Webhook：{formatDateTime(integration?.lastWebhookReceivedAt || null)}</div>
                            <div>
                              {!hasSavedCredentials
                                ? '保存基础凭证后，系统才能根据当前集成识别并接收 Webhook challenge。'
                                : hasWebhookConnected
                                  ? '已收到飞书 challenge 或真实事件回调，第二步配置已打通。'
                                  : '请在飞书开放平台保存上述配置并发布版本，然后返回这里刷新状态。'}
                            </div>
                          </div>
                          <div className="mt-4">
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => void handleRefreshIntegration()}
                              disabled={isLoadingDetail}
                            >
                              <RefreshCw className="mr-2 h-4 w-4" />
                              刷新状态
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card id="step-3">
              <StepHeader
                step={3}
                status={stepStatuses[3]}
                description="授权当前飞书账号，让系统能够读取会议与妙记资源。"
                badgeText={detail?.authorization?.status === 'authorized' ? '已授权' : undefined}
              />
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
                    <div className="rounded-lg bg-purple-50 p-4 text-sm text-purple-900">
                      授权完成后，系统会自动返回当前配置页，并继续展示最新状态。
                    </div>

                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="mb-3 text-sm font-medium">授权状态</div>
                      <div className="space-y-2 text-sm text-slate-600">
                        <div className="flex items-center justify-between gap-4">
                          <span>状态</span>
                          <Badge
                            variant="outline"
                            className={getStatusBadgeClass(detail?.authorization?.status || detail?.checks?.oauthStatus)}
                          >
                            {getStatusLabel(detail?.authorization?.status || detail?.checks?.oauthStatus)}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <span>授权用户</span>
                          <span>{detail?.authorization?.authorizedUserName || '未授权'}</span>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <span>最近更新时间</span>
                          <span>{formatDateTime(detail?.authorization?.updatedAt || null)}</span>
                        </div>
                      </div>
                    </div>

                    {oauthAuthorizeUrl ? (
                      <Button asChild>
                        <a href={oauthAuthorizeUrl}>
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

            <Card id="step-4">
              <StepHeader
                step={4}
                status={stepStatuses[4]}
                description="初始化多维表格；完成后系统会自动在后台做内部校验。"
                badgeText={integration?.initializedAt ? '已初始化' : undefined}
              />
              <CardContent className="space-y-4">
                {detail?.authorization?.status !== 'authorized' ? (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-500">
                    请先完成第 3 步授权
                  </div>
                ) : (
                  <>
                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="mb-3 text-sm font-medium">当前状态</div>
                      <div className="space-y-3 text-sm text-slate-600">
                        <div className="flex items-center justify-between gap-4">
                          <span>初始化时间</span>
                          <span>{formatDateTime(integration?.initializedAt || null)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <span>多维表格链接</span>
                          <span>{integration?.links.baseUrl ? '已生成' : '初始化后自动生成'}</span>
                        </div>
                        {integration?.links.baseUrl ? (
                          <div>
                            <Button asChild variant="outline">
                              <a href={integration.links.baseUrl} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="mr-2 h-4 w-4" />
                                打开多维表格
                              </a>
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <Button
                      onClick={() => void handleInitializeBase()}
                      disabled={isInitializingBase || isLoadingDetail}
                    >
                      {isInitializingBase ? '初始化中...' : '一键初始化多维表格'}
                    </Button>

                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="text-sm font-medium text-slate-900">系统内部校验</div>
                        <Badge
                          variant="outline"
                          className={getStatusBadgeClass(
                            detail?.checks?.allPassed
                              ? 'success'
                              : isRunningChecks
                                ? 'pending'
                                : integration?.initializedAt
                                  ? detail?.checks?.baseStatus || 'pending'
                                  : 'pending'
                          )}
                        >
                          {detail?.checks?.allPassed ? '已通过' : isRunningChecks ? '校验中' : '自动校验'}
                        </Badge>
                      </div>
                      <div className="space-y-2 text-sm text-slate-600">
                        <div>
                          {detail?.checks?.allPassed
                            ? '系统已完成应用凭证、权限、Webhook、OAuth 和多维表格联通性校验，可以开始使用系统。'
                            : '完成初始化后，系统会自动在后台校验凭证、Webhook、OAuth 和多维表格联通状态。'}
                        </div>
                        {detail?.checks?.lastCheckedAt ? (
                          <div>最近校验时间：{formatDateTime(detail.checks.lastCheckedAt)}</div>
                        ) : null}
                      </div>
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
