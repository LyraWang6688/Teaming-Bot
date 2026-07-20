'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Layout from '@/components/Layout';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { logClientMonitor, toClientErrorContext } from '@/lib/platform/clientMonitor';
import {
  AlertCircle,
  ArrowRight,
  Check,
  LogOut,
  RefreshCw,
  Rocket,
  Shield,
  Sparkles,
  User,
  QrCode,
} from 'lucide-react';

type StepDisplayStatus = 'completed' | 'current' | 'pending';
type ActiveQrDialog = 'registration' | 'authorization' | null;

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
  selectedOrgTargetId: string | null;
  orgSelectedAt: string | null;
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

type ActiveProjectView = {
  id: string;
  projectKey: string;
  name: string;
  status: string;
};

type OrgTargetView = {
  id: string;
  projectId: string;
  orgKey: string;
  orgName: string;
  baseUrl: string;
  enabled: boolean;
};

type ActiveOrgTargetsResponse = {
  project: ActiveProjectView | null;
  targets: OrgTargetView[];
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
      return '创建应用';
    case 2:
      return '用户授权';
    case 3:
      return '选择组织';
    case 4:
      return 'Base 校验';
    case 5:
      return '事件长连接';
    default:
      return '';
  }
}

function getStepDescription(step: number) {
  switch (step) {
    case 1:
      return '创建飞书应用并完成事件配置。';
    case 2:
      return '授权访问妙记和多维表格。';
    case 3:
      return '绑定目标组织表格。';
    case 4:
      return '自动校验目标多维表格可访问。';
    case 5:
      return '建立消费级事件长连接。';
    default:
      return '';
  }
}

function areDisplayedChecksPassed(checks: CheckStatusView | null | undefined) {
  return Boolean(
    checks &&
    checks.appCredentialStatus === 'success' &&
    checks.oauthStatus === 'authorized' &&
    checks.baseStatus === 'success' &&
    checks.permissionStatus === 'success' &&
    checks.eventSubscriptionStatus === 'success'
  );
}

function getCheckStatusTone(passed: boolean) {
  return passed ? 'text-emerald-600' : 'text-amber-600';
}

function getCheckStatusLabel(passed: boolean) {
  return passed ? '已通过' : '待确认';
}

function createSetupTraceId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `setup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
    <CardHeader className="px-0 pb-2 pt-0">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${
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
              className={`text-sm font-medium ${
                isCompleted
                  ? 'text-emerald-700'
                  : isCurrent
                    ? 'text-indigo-700'
                    : 'text-slate-500'
              }`}
            >
              {getStepTitle(step)}
            </div>
            <CardDescription className="pt-0.5 text-xs">{description}</CardDescription>
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
  const setupTraceIdRef = useRef<string | null>(null);
  const previousSetupCompleteRef = useRef<boolean | null>(null);

  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  const [integration, setIntegration] = useState<IntegrationView | null>(null);
  const [detail, setDetail] = useState<IntegrationDetailResponse | null>(null);
  const [, setIsLoadingDetail] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [activeOrgTargets, setActiveOrgTargets] = useState<ActiveOrgTargetsResponse | null>(null);
  const [selectedOrgTargetId, setSelectedOrgTargetId] = useState<string | null>(null);
  const [isSavingOrganization, setIsSavingOrganization] = useState(false);

  const [isCreatingApp, setIsCreatingApp] = useState(false);
  const [isAuthorizing, setIsAuthorizing] = useState(false);

  const [pageError, setPageError] = useState<string | null>(null);
  const [showCelebration, setShowCelebration] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [registrationQrUrl, setRegistrationQrUrl] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [activeQrDialog, setActiveQrDialog] = useState<ActiveQrDialog>(null);
  const [showOrgDialog, setShowOrgDialog] = useState(false);
  const [authorizePollStatus, setAuthorizePollStatus] = useState<string>('idle');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const authorizePollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getSetupTraceId = useCallback(() => {
    if (!setupTraceIdRef.current) {
      setupTraceIdRef.current = createSetupTraceId();
    }
    return setupTraceIdRef.current;
  }, []);

  const setupHeaders = useCallback((extra?: HeadersInit): HeadersInit => ({
    ...extra,
    'x-setup-trace-id': getSetupTraceId(),
  }), [getSetupTraceId]);

  const currentStep = useMemo(() => {
    if (!user) return 1;
    if (!integration) return 1;
    if (detail?.authorization?.status !== 'authorized') return 2;
    if (!selectedOrgTargetId) return 3;
    if (detail?.checks?.baseStatus !== 'success') return 4;
    return 5;
  }, [user, integration, detail?.authorization?.status, detail?.checks?.baseStatus, selectedOrgTargetId]);

  const eventSubscriptionPassed = detail?.checks?.eventSubscriptionStatus === 'success';

  const sidebarSteps = useMemo(() => {
    const steps = [
      {
        step: 1,
        anchor: 'step-create-app',
        title: '创建应用',
        description: '使用飞书 SDK 一键创建应用',
        status: integration ? 'completed' : 'current',
      },
      {
        step: 2,
        anchor: 'step-authorize',
        title: '用户授权',
        description: '授权访问权限',
        status: (detail?.authorization?.status === 'authorized') ? 'completed' : integration ? 'current' : 'pending',
      },
      {
        step: 3,
        anchor: 'step-organization',
        title: '选择组织',
        description: '选择所在组织',
        status: selectedOrgTargetId ? 'completed' : (detail?.authorization?.status === 'authorized') ? 'current' : 'pending',
      },
      {
        step: 4,
        anchor: 'step-checks',
        title: 'Base 校验',
        description: '自动校验可访问',
        status: detail?.checks?.baseStatus === 'success' ? 'completed' : selectedOrgTargetId ? 'current' : 'pending',
      },
      {
        step: 5,
        anchor: 'step-checks',
        title: '事件长连接',
        description: '启动事件消费',
        status: eventSubscriptionPassed ? 'completed' : detail?.checks?.baseStatus === 'success' ? 'current' : 'pending',
      },
    ];
    return steps;
  }, [selectedOrgTargetId, integration, detail?.authorization?.status, detail?.checks, eventSubscriptionPassed]);

  const displayedChecksPassed = useMemo(
    () => areDisplayedChecksPassed(detail?.checks),
    [detail?.checks]
  );

  const setupComplete = eventSubscriptionPassed;

  const activeRegistrationQrUrl = verificationUrl || registrationQrUrl;

  const selectedOrgTarget = useMemo(
    () => activeOrgTargets?.targets.find((target) => target.id === selectedOrgTargetId) || null,
    [activeOrgTargets?.targets, selectedOrgTargetId]
  );

  const createStepIsActive = !integration;
  const authorizeStepIsActive = Boolean(integration && detail?.authorization?.status !== 'authorized');
  const organizationStepIsActive = Boolean(detail?.authorization?.status === 'authorized' && !selectedOrgTargetId);
  const getStepPanelClassName = (isActive: boolean) =>
    `min-h-0 rounded-xl border border-slate-200 bg-white p-3 transition-all ${isActive ? 'flex flex-1 flex-col' : 'shrink-0'}`;

  useEffect(() => {
    if (previousSetupCompleteRef.current === null) {
      previousSetupCompleteRef.current = setupComplete;
      return;
    }
    const becameComplete = !previousSetupCompleteRef.current && setupComplete;
    previousSetupCompleteRef.current = setupComplete;
    if (!becameComplete) return;
    setShowCelebration(true);
    const timer = window.setTimeout(() => setShowCelebration(false), 4200);
    return () => window.clearTimeout(timer);
  }, [setupComplete]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/project-org-targets/active');
        const payload = (await response.json().catch(() => null)) as
          | { success?: boolean; data?: ActiveOrgTargetsResponse; error?: string }
          | null;
        if (payload?.success && payload.data) {
          setActiveOrgTargets(payload.data);
        }
      } catch (error) {
        logClientMonitor('error', 'feishu_config_workspace', 'active_org_targets_load_failed', toClientErrorContext(error));
      }
    })();
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
        }
      } catch (error) {
        logClientMonitor('error', 'feishu_config_workspace', 'auth_me_failed', toClientErrorContext(error));
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  const loadIntegrationDetail = useCallback(
    async (integrationId: string | null) => {
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
        if (detailData.integration.selectedOrgTargetId) {
          setSelectedOrgTargetId(detailData.integration.selectedOrgTargetId);
        } else {
          setSelectedOrgTargetId(null);
        }
      } catch (error) {
        setPageError(error instanceof Error ? error.message : '加载配置失败。');
      } finally {
        setIsLoadingDetail(false);
      }
    },
    []
  );

  useEffect(() => {
    if (user) {
      void loadIntegrationDetail(searchParams.get('integrationId'));
    }
  }, [loadIntegrationDetail, searchParams, user]);

  const autoCheckTriggerKey = useMemo(() => {
    if (!integration?.id) return '';
    return [
      integration.id,
      integration.selectedOrgTargetId || selectedOrgTargetId || 'no-org',
      detail?.authorization?.updatedAt ?? 'no-oauth-update',
    ].join(':');
  }, [detail?.authorization?.updatedAt, integration?.id, integration?.selectedOrgTargetId, selectedOrgTargetId]);

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

  const handleSelectOrganization = async (orgTargetId: string) => {
    setSelectedOrgTargetId(orgTargetId);
    setPageError(null);

    if (!integration?.id) {
      return;
    }

    setIsSavingOrganization(true);
    try {
      await parseJsonResponse<IntegrationView>(
        await fetch(`/api/feishu/integrations/${integration.id}`, {
          method: 'PATCH',
          headers: setupHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ selectedOrgTargetId: orgTargetId }),
        })
      );
      await loadIntegrationDetail(integration.id);
      setShowOrgDialog(false);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '保存组织失败。');
    } finally {
      setIsSavingOrganization(false);
    }
  };

  const handleCreateApp = async () => {
    setIsCreatingApp(true);
    setPageError(null);
    setRegistrationQrUrl(null);
    setVerificationUrl(null);
    setActiveQrDialog(null);
    try {
      const result = await parseJsonResponse<{
        verificationUrl: string;
        sessionToken: string;
        expiresAt: string;
        user: AuthUser;
      }>(await fetch('/api/feishu/integrations/create-app', {
        method: 'POST',
        headers: setupHeaders(),
      }));
      
      setVerificationUrl(result.verificationUrl);
      setRegistrationQrUrl(result.verificationUrl);
      setActiveQrDialog('registration');
      setUser(result.user);
      
      const intervalMs = 3000;
      
      const poll = async () => {
        try {
          const pollRes = await fetch('/api/feishu/integrations/register/poll', {
            method: 'POST',
            headers: setupHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ sessionToken: result.sessionToken }),
          });
          const pollData = await pollRes.json();
          const status = pollData?.data?.status || pollData?.status;
          
          if (status === 'completed') {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setActiveQrDialog(null);
            setRegistrationQrUrl(null);
            setVerificationUrl(null);
            const completedIntegration = pollData?.data?.integration as IntegrationView | undefined;
            const completedIntegrationId = pollData?.data?.integrationId as string | undefined;
            if (completedIntegration) {
              setIntegration(completedIntegration);
            }
            if (completedIntegrationId) {
              await loadIntegrationDetail(completedIntegrationId);
            }
          } else if (
            status === 'failed' ||
            status === 'error' ||
            status === 'denied' ||
            status === 'expired'
          ) {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setRegistrationQrUrl(null);
            setActiveQrDialog(null);
            setPageError(pollData?.data?.error || pollData?.error || '创建失败');
          }
        } catch (e) {
          logClientMonitor('warn', 'feishu_config_workspace', 'register_poll_request_failed', {
            ...toClientErrorContext(e),
            setupTraceId: getSetupTraceId(),
          });
        }
      };
      
      pollRef.current = setInterval(poll, intervalMs);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '创建应用失败。');
    } finally {
      setIsCreatingApp(false);
    }
  };

  const handleAuthorize = async () => {
    if (!integration?.id) return;
    setIsAuthorizing(true);
    setPageError(null);
    setAuthorizeUrl(null);
    setActiveQrDialog(null);
    setAuthorizePollStatus('idle');
    try {
      const result = await parseJsonResponse<{ authorizationUrl: string; expiresIn: number }>(
        await fetch(`/api/feishu/integrations/${integration.id}/authorize/start`, {
          method: 'POST',
          headers: setupHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ integrationId: integration.id }),
        })
      );

      setAuthorizeUrl(result.authorizationUrl);
      setActiveQrDialog('authorization');
      setAuthorizePollStatus('pending');

      if (authorizePollRef.current) {
        clearTimeout(authorizePollRef.current);
      }

      const scheduleAuthorizePoll = () => {
        authorizePollRef.current = setTimeout(async () => {
          authorizePollRef.current = null;
          try {
            const pollResult = await parseJsonResponse<{ status: string; error?: string }>(
              await fetch(`/api/feishu/integrations/${integration.id}/authorize/poll`, {
                method: 'POST',
                headers: setupHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ integrationId: integration.id }),
              })
            );

            if (pollResult.status === 'completed') {
              setAuthorizePollStatus('completed');
              setActiveQrDialog(null);
              await loadIntegrationDetail(integration.id);
            } else if (pollResult.status === 'denied' || pollResult.status === 'expired' || pollResult.status === 'error') {
              setAuthorizePollStatus(pollResult.status);
              setActiveQrDialog(null);
              setPageError(pollResult.error || '授权失败');
            } else {
              scheduleAuthorizePoll();
            }
          } catch (pollErr) {
            logClientMonitor('warn', 'feishu_config_workspace', 'authorize_poll_request_failed', {
              ...toClientErrorContext(pollErr),
              setupTraceId: getSetupTraceId(),
              integrationId: integration.id,
            });
            scheduleAuthorizePoll();
          }
        }, 3000);
      };

      scheduleAuthorizePoll();
    } catch (error) {
      logClientMonitor('error', 'feishu_config_workspace', 'authorize_start_failed', {
        ...toClientErrorContext(error),
        setupTraceId: getSetupTraceId(),
        integrationId: integration.id,
      });
      setPageError(error instanceof Error ? error.message : '发起授权失败。');
    } finally {
      setIsAuthorizing(false);
    }
  };

  const runAutomatedChecks = useCallback(
    async (integrationId: string, options?: { silent?: boolean }) => {
      setIsRunningChecks(true);
      if (!options?.silent) {
        setPageError(null);
      }
      try {
        await parseJsonResponse<{ allPassed: boolean }>(
          await fetch(`/api/feishu/integrations/${integrationId}/checks`, {
            method: 'POST',
            headers: setupHeaders(),
          })
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
    [loadIntegrationDetail, setupHeaders]
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

  return (
    <Layout>
      <AlertDialog open={Boolean(pageError)} onOpenChange={(open) => {
        if (!open) setPageError(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-red-100 text-red-600">
              <AlertCircle className="h-5 w-5" />
            </div>
            <AlertDialogTitle>操作未完成</AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-6 text-slate-600">
              {pageError}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setPageError(null)}>
              我知道了
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={activeQrDialog === 'registration' && Boolean(activeRegistrationQrUrl)} onOpenChange={(open) => {
        if (!open) setActiveQrDialog(null);
      }}>
        <AlertDialogContent className="sm:max-w-xl">
          <AlertDialogHeader>
            <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
              <QrCode className="h-5 w-5" />
            </div>
            <AlertDialogTitle>创建飞书应用</AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-6 text-slate-600">
              你可以使用飞书扫码，也可以直接打开链接完成应用创建。请在飞书页面显示的有效期内完成确认，创建成功后本页会自动进入用户授权步骤。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {activeRegistrationQrUrl ? (
            <div className="grid gap-4 rounded-xl border border-indigo-100 bg-indigo-50 p-4 sm:grid-cols-[160px_minmax(0,1fr)]">
              <div className="mx-auto rounded-xl border bg-white p-3 shadow-sm">
                <Image
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=148x148&data=${encodeURIComponent(activeRegistrationQrUrl)}`}
                  alt="创建应用二维码"
                  width={144}
                  height={144}
                  unoptimized
                  className="h-36 w-36"
                />
              </div>
              <div className="space-y-2 text-sm text-slate-700">
                <div className="font-medium text-slate-900">扫码或打开链接</div>
                <p className="leading-6">按飞书页面提示完成应用创建和权限配置。系统会在后台轮询创建结果。</p>
                <a href={activeRegistrationQrUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800">
                  打开链接
                </a>
                <p className="text-xs leading-5 text-slate-500">如果二维码过期，请关闭弹窗后重新点击“创建应用”。</p>
              </div>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setActiveQrDialog(null)}>稍后处理</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={activeQrDialog === 'authorization' && Boolean(authorizeUrl)} onOpenChange={(open) => {
        if (!open) setActiveQrDialog(null);
      }}>
        <AlertDialogContent className="sm:max-w-xl">
          <AlertDialogHeader>
            <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
              <Shield className="h-5 w-5" />
            </div>
            <AlertDialogTitle>完成用户授权</AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-6 text-slate-600">
              你可以使用飞书扫码，也可以直接打开链接授权妙记和多维表格访问权限。授权完成后系统会自动更新状态。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {authorizeUrl ? (
            <div className="grid gap-4 rounded-xl border border-indigo-100 bg-indigo-50 p-4 sm:grid-cols-[160px_minmax(0,1fr)]">
              <div className="mx-auto rounded-xl border bg-white p-3 shadow-sm">
                <Image
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=148x148&data=${encodeURIComponent(authorizeUrl)}`}
                  alt="授权二维码"
                  width={144}
                  height={144}
                  unoptimized
                  className="h-36 w-36"
                />
              </div>
              <div className="space-y-2 text-sm text-slate-700">
                <div className="font-medium text-slate-900">扫码或打开链接</div>
                <p className="leading-6">确认授权后，系统会持续等待飞书返回授权结果。</p>
                <a href={authorizeUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800">
                  打开链接
                </a>
                {authorizePollStatus === 'pending' ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    等待授权确认
                  </div>
                ) : null}
                <p className="text-xs leading-5 text-slate-500">如果授权链接失效，请关闭弹窗后重新发起授权。</p>
              </div>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setActiveQrDialog(null)}>稍后处理</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showOrgDialog} onOpenChange={setShowOrgDialog}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
              <User className="h-5 w-5" />
            </div>
            <AlertDialogTitle>选择目标组织</AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-6 text-slate-600">
              请选择本次飞书会议分析要写入的组织表格。系统会将后续会议记录、总结和校验结果绑定到该组织目标。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-500">当前项目</div>
              <div className="mt-1 text-sm font-semibold text-slate-900">
                {activeOrgTargets?.project?.name || '尚未导入 active 项目配置'}
              </div>
            </div>
            {activeOrgTargets?.targets.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {activeOrgTargets.targets.map((target) => (
                  <Button
                    key={target.id}
                    type="button"
                    variant={target.id === selectedOrgTargetId ? 'default' : 'outline'}
                    onClick={() => void handleSelectOrganization(target.id)}
                    disabled={isSavingOrganization}
                    className="justify-start"
                  >
                    {isSavingOrganization && target.id === selectedOrgTargetId ? (
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {target.orgName}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800">
                当前没有可选组织，请先在服务器导入项目组织配置。
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSavingOrganization}>稍后选择</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {showCelebration ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-slate-950/10 backdrop-blur-[1px]">
          <div className="relative overflow-hidden rounded-2xl border border-emerald-200 bg-white px-8 py-7 text-center shadow-2xl">
            {['left-6 top-6 bg-pink-400', 'right-8 top-8 bg-indigo-400', 'left-10 bottom-8 bg-amber-400', 'right-10 bottom-7 bg-emerald-400', 'left-1/2 top-4 bg-sky-400'].map((className) => (
              <span
                key={className}
                className={`absolute h-2.5 w-2.5 rounded-full ${className} animate-ping`}
              />
            ))}
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
              <Sparkles className="h-7 w-7" />
            </div>
            <div className="text-lg font-semibold text-slate-900">配置完成</div>
            <p className="mt-2 max-w-sm text-sm leading-6 text-slate-600">
              系统校验已通过，后续可以自动监听并分析飞书会议。
            </p>
          </div>
        </div>
      ) : null}

      <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-6xl flex-col gap-3 py-5 lg:overflow-hidden">
        <div className="shrink-0 space-y-0.5">
          <h1 className="text-xl font-bold text-slate-900">飞书集成配置</h1>
          <p className="text-sm text-slate-600">完成创建应用、用户授权和组织选择，系统会自动校验目标表格与事件监听状态。</p>
        </div>

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col gap-2">
            <Card className="shrink-0">
              <CardContent className="p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-900">配置进度</div>
                  <div className="flex items-center gap-1 text-xs text-slate-500">
                    <span>第 {currentStep} 步</span>
                    <ArrowRight className="h-3 w-3" />
                    <span>共 4 步</span>
                  </div>
                </div>
                <div className="space-y-1">
                  {sidebarSteps.map((item, index) => {
                    const isCompleted = item.status === 'completed';
                    const isCurrent = item.status === 'current';
                    return (
                      <a key={item.step} href={`#${item.anchor}`} className="flex gap-2 rounded-lg p-1 transition hover:bg-slate-50">
                        <div className="flex flex-col items-center">
                          <div
                            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${
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
                            <div className={`mt-1 h-4 w-px ${isCompleted ? 'bg-emerald-300' : 'bg-slate-200'}`} />
                          ) : null}
                        </div>
                        <div className="pb-1">
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
                          <div className="mt-0.5 text-[11px] leading-3 text-slate-500">{item.description}</div>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <Card className="min-h-0 flex-1">
              <CardContent className="flex h-full min-h-0 flex-col space-y-1.5 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-slate-900">系统校验结果</div>
                  <div className="flex items-center gap-1.5">
                    {integration?.id ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => void runAutomatedChecks(integration.id)} disabled={isRunningChecks} className="h-6 px-2 text-xs">
                        <RefreshCw className={`mr-1 h-3 w-3 ${isRunningChecks ? 'animate-spin' : ''}`} />
                        刷新
                      </Button>
                    ) : null}
                    <Badge
                      variant="outline"
                      className={displayedChecksPassed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}
                    >
                      {displayedChecksPassed ? '全部通过' : '待确认'}
                    </Badge>
                  </div>
                </div>
                <div className="space-y-1 text-xs">
                  <div className={`flex items-center justify-between ${getCheckStatusTone(Boolean(selectedOrgTargetId))}`}>
                    <span>组织配置</span>
                    <span className="text-xs">{selectedOrgTarget ? selectedOrgTarget.orgName : getCheckStatusLabel(Boolean(selectedOrgTargetId))}</span>
                  </div>
                  <div className={`flex items-center justify-between ${getCheckStatusTone(detail?.checks?.appCredentialStatus === 'success')}`}>
                    <span>应用凭证</span>
                    <span className="text-xs">{getCheckStatusLabel(detail?.checks?.appCredentialStatus === 'success')}</span>
                  </div>
                  <div className={`flex items-center justify-between ${getCheckStatusTone(detail?.checks?.oauthStatus === 'authorized')}`}>
                    <span>用户授权</span>
                    <span className="text-xs">{getCheckStatusLabel(detail?.checks?.oauthStatus === 'authorized')}</span>
                  </div>
                  <div className={`flex items-center justify-between ${getCheckStatusTone(detail?.checks?.baseStatus === 'success')}`}>
                    <span>目标表格</span>
                    <span className="text-xs">{detail?.checks?.baseStatus === 'success' ? '可访问' : getStatusLabel(detail?.checks?.baseStatus)}</span>
                  </div>
                  <div className={`flex items-center justify-between ${getCheckStatusTone(eventSubscriptionPassed)}`}>
                    <span>事件监听</span>
                    <span className="text-xs">{eventSubscriptionPassed ? '已就绪' : getStatusLabel(detail?.checks?.eventSubscriptionStatus)}</span>
                  </div>
                </div>
                {!displayedChecksPassed && detail?.checks?.lastErrorMessage ? (
                  <div className="rounded-md border border-red-100 bg-red-50 p-1.5 text-xs leading-4 text-red-700">
                    {detail.checks.lastErrorMessage}
                  </div>
                ) : null}
                {setupComplete ? (
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-1.5 text-xs leading-4 text-emerald-800">
                    配置已完成，后续可以实现飞书会议的自动监听与分析。
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </aside>

          <div className="flex min-h-0 flex-col">
            <Card className="min-h-0 flex-1">
              <CardContent className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3">
                {authLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-8 w-32" />
                    <Skeleton className="h-48 w-full" />
                  </div>
                ) : (
                  <>
                    {user ? (
                    <div className="flex shrink-0 items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-sm font-medium text-indigo-700">
                          <User className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="text-sm font-medium text-slate-900">已登录</div>
                          <div className="text-xs text-slate-500">{user.email || '飞书用户'}</div>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={handleSignOut} disabled={isSigningOut}>
                        <LogOut className="mr-1.5 h-3.5 w-3.5" />
                        {isSigningOut ? '退出中...' : '退出'}
                      </Button>
                    </div>
                    ) : null}

                    <div id="step-create-app" className={getStepPanelClassName(createStepIsActive)}>
                      <StepHeader
                        step={1}
                        status={integration ? 'completed' : 'current'}
                        description={getStepDescription(1)}
                      />
                      <CardContent className="min-h-0 flex-1 px-0 pb-0 pt-0">
                        {!integration ? (
                          <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50 p-3">
                            {registrationQrUrl ? (
                              <div className="flex items-center justify-between gap-4">
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-medium text-indigo-900">创建二维码已生成</div>
                                  <p className="mt-1 text-xs leading-4 text-slate-600">请在弹窗中扫码，页面会自动等待创建结果。</p>
                                </div>
                                <Button type="button" size="sm" className="shrink-0" onClick={() => setActiveQrDialog('registration')}>
                                  <QrCode className="mr-2 h-4 w-4" />
                                  查看二维码
                                </Button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-4">
                                <div className="min-w-0">
                                  <h3 className="text-sm font-semibold text-slate-900">创建飞书应用</h3>
                                </div>
                                <Button onClick={handleCreateApp} disabled={isCreatingApp} size="sm" className="shrink-0">
                                  {isCreatingApp ? (
                                    <>
                                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                      创建中
                                    </>
                                  ) : (
                                    <>
                                      <Rocket className="mr-2 h-4 w-4" />
                                      创建应用
                                    </>
                                  )}
                                </Button>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="rounded-lg bg-emerald-50 px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-2">
                                <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                                <span className="truncate text-sm font-medium text-emerald-900">应用已创建：{integration.name}</span>
                              </div>
                              <span className="shrink-0 font-mono text-[11px] text-emerald-700">{integration.appId}</span>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </div>

                    <div id="step-authorize" className={getStepPanelClassName(authorizeStepIsActive)}>
                      <StepHeader
                        step={2}
                        status={(detail?.authorization?.status === 'authorized') ? 'completed' : integration ? 'current' : 'pending'}
                        description={getStepDescription(2)}
                      />
                      <CardContent className="min-h-0 flex-1 px-0 pb-0 pt-0">
                        {!integration ? (
                          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3">
                            <div className="text-sm font-medium text-slate-500">请先完成第 1 步创建应用</div>
                          </div>
                        ) : detail?.authorization?.status === 'authorized' ? (
                          <div className="rounded-lg bg-emerald-50 px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-2">
                                <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                                <span className="truncate text-sm font-medium text-emerald-900">
                                  已完成授权：{detail.authorization.authorizedUserName || '未知用户'}
                                </span>
                              </div>
                              <span className="shrink-0 text-[11px] text-emerald-700">{formatDateTime(detail.authorization.updatedAt)}</span>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50 p-3">
                              {authorizeUrl ? (
                                <div className="flex items-center justify-between gap-4">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-indigo-900">授权二维码已生成</div>
                                    {authorizePollStatus === 'pending' && (
                                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                        等待授权确认
                                      </div>
                                    )}
                                    {authorizePollStatus === 'completed' && (
                                      <div className="mt-2 flex items-center gap-2 text-xs text-emerald-600">
                                        <Check className="h-3.5 w-3.5" />
                                        授权已完成
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <Button type="button" size="sm" onClick={() => setActiveQrDialog('authorization')}>
                                      <QrCode className="mr-2 h-4 w-4" />
                                      查看二维码
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => {
                                        setAuthorizeUrl(null);
                                        setActiveQrDialog(null);
                                        setAuthorizePollStatus('idle');
                                        if (authorizePollRef.current) {
                                          clearTimeout(authorizePollRef.current);
                                          authorizePollRef.current = null;
                                        }
                                      }}
                                    >
                                      重新发起
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-center justify-between gap-4">
                                  <div className="min-w-0">
                                    <h3 className="text-sm font-semibold text-slate-900">授权应用</h3>
                                    <p className="mt-1 text-xs leading-4 text-slate-600">允许系统读取妙记并写入目标多维表格。</p>
                                  </div>
                                  <Button onClick={handleAuthorize} disabled={isAuthorizing} size="sm" className="shrink-0">
                                    {isAuthorizing ? (
                                      <>
                                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                        生成中
                                      </>
                                    ) : (
                                      <>
                                        <Shield className="mr-2 h-4 w-4" />
                                        开始授权
                                      </>
                                    )}
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </div>

                    <div id="step-organization" className={getStepPanelClassName(organizationStepIsActive)}>
                      <StepHeader
                        step={3}
                        status={selectedOrgTargetId ? 'completed' : (detail?.authorization?.status === 'authorized') ? 'current' : 'pending'}
                        description={getStepDescription(3)}
                      />
                      <CardContent className="min-h-0 flex-1 px-0 pb-0 pt-0">
                        {detail?.authorization?.status !== 'authorized' ? (
                          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3">
                            <div className="text-sm font-medium text-slate-500">请先完成第 2 步用户授权</div>
                          </div>
                        ) : (
                          <div className={selectedOrgTarget ? 'rounded-lg bg-emerald-50 p-3' : 'rounded-lg border border-dashed border-indigo-200 bg-indigo-50 p-3'}>
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="mb-1 flex items-center gap-2">
                                  {selectedOrgTarget ? (
                                    <Check className="h-4 w-4 text-emerald-600" />
                                  ) : (
                                    <AlertCircle className="h-4 w-4 text-indigo-600" />
                                  )}
                                  <span className={selectedOrgTarget ? 'text-sm font-medium text-emerald-900' : 'text-sm font-medium text-indigo-900'}>
                                    {selectedOrgTarget ? '组织已选择' : '请选择所在组织'}
                                  </span>
                                </div>
                                <p className={selectedOrgTarget ? 'text-xs text-emerald-900' : 'text-xs text-slate-600'}>
                                  当前项目：{activeOrgTargets?.project?.name || '尚未导入 active 项目配置'}
                                </p>
                                {selectedOrgTarget ? (
                                  <p className="mt-1 text-xs text-emerald-900">目标组织：{selectedOrgTarget.orgName}</p>
                                ) : (
                                  <p className="mt-1 text-xs text-slate-600">
                                    可选组织：{activeOrgTargets?.targets.length || 0} 个
                                  </p>
                                )}
                              </div>
                              <Button
                                type="button"
                                variant={selectedOrgTarget ? 'outline' : 'default'}
                                size="sm"
                                onClick={() => setShowOrgDialog(true)}
                                disabled={isSavingOrganization}
                                className="shrink-0"
                              >
                                {isSavingOrganization ? (
                                  <>
                                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                    保存中
                                  </>
                                ) : selectedOrgTarget ? (
                                  '更换组织'
                                ) : (
                                  '选择组织'
                                )}
                              </Button>
                            </div>
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
