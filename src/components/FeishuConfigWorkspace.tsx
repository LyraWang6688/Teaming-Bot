'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { logClientMonitor, toClientErrorContext } from '@/lib/platform/clientMonitor';
import {
  AlertCircle,
  ArrowRight,
  Check,
  MessageSquare,
  RefreshCw,
  Rocket,
  Shield,
  Sparkles,
  User,
} from 'lucide-react';

type StepDisplayStatus = 'completed' | 'current' | 'pending';
type CheckVisualStatus = 'pending' | 'success' | 'failed';

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
  selectedOrgTargetId: string | null;
  orgSelectedAt: string | null;
  initializedAt: string | null;
  createdAt: string;
  updatedAt: string;
  masked: {
    appSecret: string | null;
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
  minuteSubscriptionStatus: string;
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

const INTEGRATION_LIST_CACHE_TTL_MS = 3_000;
const INTEGRATION_DETAIL_CACHE_TTL_MS = 1_500;
const FAILED_CHECK_STATUSES = new Set([
  'denied',
  'error',
  'expired',
  'failed',
  'invalid',
  'reauthorization_required',
]);
const CHECK_STATUS_LEGEND: Array<{
  status: CheckVisualStatus;
  label: string;
}> = [
  { status: 'pending', label: '尚未完成' },
  { status: 'success', label: '校验通过' },
  { status: 'failed', label: '校验失败' },
];

function formatDateTime(value: string | null) {
  if (!value) return '未设置';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
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

function getStepLogLabel(step: number) {
  return `第 ${step} 步：${getStepTitle(step)}`;
}

function areDisplayedChecksPassed(checks: CheckStatusView | null | undefined) {
  return Boolean(
    checks &&
    checks.appCredentialStatus === 'success' &&
    checks.oauthStatus === 'authorized' &&
    checks.baseStatus === 'success' &&
    checks.permissionStatus === 'success' &&
    checks.minuteSubscriptionStatus === 'success' &&
    checks.eventSubscriptionStatus === 'success'
  );
}

function getCheckVisualStatus(
  status: string | null | undefined,
  successStatuses: string[] = ['success']
): CheckVisualStatus {
  if (status && successStatuses.includes(status)) return 'success';
  if (status && FAILED_CHECK_STATUSES.has(status)) return 'failed';
  return 'pending';
}

function getEventCheckVisualStatus(checks: CheckStatusView | null | undefined): CheckVisualStatus {
  const statuses = [
    checks?.permissionStatus,
    checks?.minuteSubscriptionStatus,
    checks?.eventSubscriptionStatus,
  ];
  if (statuses.every((status) => status === 'success')) return 'success';
  if (statuses.some((status) => getCheckVisualStatus(status) === 'failed')) return 'failed';
  return 'pending';
}

function getCheckStatusLabel(status: CheckVisualStatus) {
  switch (status) {
    case 'success':
      return '校验通过';
    case 'failed':
      return '校验失败';
    default:
      return '尚未完成';
  }
}

function getCheckStatusTextTone(status: CheckVisualStatus) {
  switch (status) {
    case 'success':
      return 'text-emerald-700';
    case 'failed':
      return 'text-red-700';
    default:
      return 'text-amber-700';
  }
}

function getCheckStatusCardTone(status: CheckVisualStatus) {
  switch (status) {
    case 'success':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-700';
    default:
      return 'border-amber-200 bg-amber-50 text-amber-700';
  }
}

function getCheckStatusDotTone(status: CheckVisualStatus) {
  switch (status) {
    case 'success':
      return 'bg-emerald-500';
    case 'failed':
      return 'bg-red-500';
    default:
      return 'bg-amber-400';
  }
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedIntegrationId = searchParams.get('integrationId');
  const autoCheckKeyRef = useRef<string | null>(null);
  const setupTraceIdRef = useRef<string | null>(null);
  const previousSetupCompleteRef = useRef<boolean | null>(null);
  const checksRequestRef = useRef<Promise<void> | null>(null);
  const integrationListRequestRef = useRef<Promise<IntegrationView[]> | null>(null);
  const integrationListCacheRef = useRef<{ data: IntegrationView[]; fetchedAt: number } | null>(null);
  const integrationDetailRequestRef = useRef<Promise<IntegrationDetailResponse | null> | null>(null);
  const integrationDetailRequestKeyRef = useRef<string | null>(null);
  const integrationDetailCacheRef = useRef<{
    integrationId: string;
    data: IntegrationDetailResponse;
    fetchedAt: number;
  } | null>(null);

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
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [showOrgDialog, setShowOrgDialog] = useState(false);
  const [authorizePollStatus, setAuthorizePollStatus] = useState<string>('idle');
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState('');
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackSuccessMessage, setFeedbackSuccessMessage] = useState<string | null>(null);
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

  const openActionLink = useCallback((url: string) => {
    window.location.href = url;
  }, []);

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

  const selectedOrgTarget = useMemo(
    () => activeOrgTargets?.targets.find((target) => target.id === selectedOrgTargetId) || null,
    [activeOrgTargets?.targets, selectedOrgTargetId]
  );

  const displayedChecksPassed = useMemo(
    () => areDisplayedChecksPassed(detail?.checks),
    [detail?.checks]
  );
  const systemCheckItems = useMemo(
    () => {
      const organizationStatus: CheckVisualStatus = selectedOrgTargetId ? 'success' : 'pending';
      const appCredentialStatus = getCheckVisualStatus(detail?.checks?.appCredentialStatus);
      const oauthStatus = getCheckVisualStatus(detail?.checks?.oauthStatus, ['authorized', 'success']);
      const baseStatus = getCheckVisualStatus(detail?.checks?.baseStatus);
      const eventStatus = getEventCheckVisualStatus(detail?.checks);

      return [
        {
          label: '组织配置',
          shortLabel: '组织',
          status: organizationStatus,
          value: getCheckStatusLabel(organizationStatus),
        },
        {
          label: '应用凭证',
          shortLabel: '应用',
          status: appCredentialStatus,
          value: getCheckStatusLabel(appCredentialStatus),
        },
        {
          label: '用户授权',
          shortLabel: '授权',
          status: oauthStatus,
          value: getCheckStatusLabel(oauthStatus),
        },
        {
          label: '目标表格',
          shortLabel: '表格',
          status: baseStatus,
          value: getCheckStatusLabel(baseStatus),
        },
        {
          label: '事件监听',
          shortLabel: '监听',
          status: eventStatus,
          value: getCheckStatusLabel(eventStatus),
        },
      ];
    },
    [detail?.checks, selectedOrgTargetId]
  );

  const setupComplete = eventSubscriptionPassed;
  const automaticSetupProgress = useMemo(() => {
    const baseStatus = getCheckVisualStatus(detail?.checks?.baseStatus);
    const eventStatus = getEventCheckVisualStatus(detail?.checks);

    if (!selectedOrgTargetId) {
      return null;
    }
    if (baseStatus === 'failed') {
      return {
        status: 'failed' as const,
        title: '目标表格校验失败',
        description:
          detail?.checks?.lastErrorMessage ||
          '系统暂时无法访问目标多维表格，请检查权限后重新校验。',
        progress: 60,
      };
    }
    if (baseStatus !== 'success') {
      return {
        status: 'running' as const,
        title: '正在校验目标表格',
        description: '系统正在确认当前飞书账号和应用能否读取所选组织的多维表格。',
        progress: 60,
      };
    }
    if (eventStatus === 'failed') {
      return {
        status: 'failed' as const,
        title: '事件监听配置失败',
        description:
          detail?.checks?.lastErrorMessage ||
          '目标表格已通过校验，但事件订阅或长连接暂时未能建立。',
        progress: 80,
      };
    }
    if (eventStatus !== 'success') {
      return {
        status: 'running' as const,
        title: '正在配置自动监听',
        description: '目标表格已通过校验，系统正在检查权限、订阅妙记事件并建立长连接。',
        progress: 80,
      };
    }
    return {
      status: 'success' as const,
      title: '自动配置已完成',
      description: '目标表格与事件监听均已就绪，后续会议将自动进入分析流程。',
      progress: 100,
    };
  }, [detail?.checks, selectedOrgTargetId]);
  const completedActionSteps = useMemo(
    () =>
      [Boolean(integration), detail?.authorization?.status === 'authorized', Boolean(selectedOrgTargetId)].filter(Boolean)
        .length,
    [detail?.authorization?.status, integration, selectedOrgTargetId]
  );
  const mobileStatusSummary = useMemo(() => {
    if (!user) {
      return {
        badge: '第 1 步',
        title: '创建飞书应用',
        description: '点击“创建应用”，系统会自动建立登录态并继续后续配置。',
      };
    }

    if (!integration) {
      return {
        badge: '第 1 步',
        title: '等待创建飞书应用',
        description: '创建完成后，页面会自动继续到授权和组织选择。',
      };
    }

    if (detail?.authorization?.status !== 'authorized') {
      return {
        badge: '第 2 步',
        title: '等待你完成飞书授权',
        description: '授权回跳成功后，页面会自动刷新当前状态。',
      };
    }

    if (!selectedOrgTargetId) {
      return {
        badge: '第 3 步',
        title: '请选择目标组织',
        description: '组织选定后，系统会自动开始 Base 与事件监听检查。',
      };
    }

    if (!setupComplete) {
      return {
        badge: '自动检查中',
        title: '系统正在完成最后校验',
        description: detail?.checks?.lastErrorMessage || '请稍等片刻，系统会自动检查目标表格与事件监听状态。',
      };
    }

    return {
      badge: '已完成',
      title: '移动端已完成初始化配置',
      description: '后续可以自动监听并分析飞书会议。',
    };
  }, [detail?.authorization?.status, detail?.checks?.lastErrorMessage, integration, selectedOrgTargetId, setupComplete, user]);

  const createStepIsActive = !integration;
  const authorizeStepIsActive = Boolean(integration && detail?.authorization?.status !== 'authorized');
  const organizationStepIsActive = Boolean(detail?.authorization?.status === 'authorized' && !selectedOrgTargetId);
  const getStepPanelClassName = (isActive: boolean) =>
    `min-h-0 rounded-xl border border-slate-200 bg-white p-3 transition-all ${isActive ? 'flex flex-1 flex-col' : 'shrink-0'}`;
  const feedbackPlaceholder = useMemo(
    () =>
      `例子：我在${getStepLogLabel(currentStep)}时卡住了，点击“${
        currentStep === 1 ? '创建应用' : currentStep === 2 ? '开始授权' : currentStep === 3 ? '选择组织' : '刷新'
      }”后页面一直没反应，弹窗里看到“xxx”报错，这会影响我继续完成配置。`,
    [currentStep]
  );

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

  const loadIntegrationList = useCallback(
    async (options?: { force?: boolean }) => {
      const cached = integrationListCacheRef.current;
      const now = Date.now();
      if (!options?.force && cached && now - cached.fetchedAt < INTEGRATION_LIST_CACHE_TTL_MS) {
        return cached.data;
      }

      if (integrationListRequestRef.current) {
        return integrationListRequestRef.current;
      }

      const request = (async () => {
        const listResponse = await fetch('/api/feishu/integrations');
        const listPayload = (await listResponse.json().catch(() => null)) as
          | { success?: boolean; data?: IntegrationView[] }
          | null;

        if (!listPayload?.success) {
          throw new Error('加载飞书集成列表失败。');
        }

        const integrations = listPayload.data || [];
        integrationListCacheRef.current = { data: integrations, fetchedAt: Date.now() };
        return integrations;
      })();

      integrationListRequestRef.current = request;

      try {
        return await request;
      } finally {
        if (integrationListRequestRef.current === request) {
          integrationListRequestRef.current = null;
        }
      }
    },
    []
  );

  const loadIntegrationSnapshot = useCallback(
    async (integrationId: string, options?: { force?: boolean }) => {
      const cached = integrationDetailCacheRef.current;
      const now = Date.now();
      if (
        !options?.force &&
        cached &&
        cached.integrationId === integrationId &&
        now - cached.fetchedAt < INTEGRATION_DETAIL_CACHE_TTL_MS
      ) {
        return cached.data;
      }

      if (
        integrationDetailRequestRef.current &&
        integrationDetailRequestKeyRef.current === integrationId
      ) {
        return integrationDetailRequestRef.current;
      }

      const request = (async () => {
        const detailResponse = await fetch(`/api/feishu/integrations/${integrationId}`);
        const detailPayload = (await detailResponse.json().catch(() => null)) as
          | { success?: boolean; data?: IntegrationDetailResponse }
          | null;

        if (!detailPayload?.success) {
          return null;
        }

        const detailData = detailPayload.data || null;
        if (detailData) {
          integrationDetailCacheRef.current = {
            integrationId,
            data: detailData,
            fetchedAt: Date.now(),
          };
        }
        return detailData;
      })();

      integrationDetailRequestRef.current = request;
      integrationDetailRequestKeyRef.current = integrationId;

      try {
        return await request;
      } finally {
        if (integrationDetailRequestRef.current === request) {
          integrationDetailRequestRef.current = null;
          integrationDetailRequestKeyRef.current = null;
        }
      }
    },
    []
  );

  const loadIntegrationDetail = useCallback(
    async (integrationId: string | null, options?: { force?: boolean; refreshList?: boolean }) => {
      setIsLoadingDetail(true);
      setPageError(null);

      try {
        let knownIntegrations = integrationListCacheRef.current?.data || [];
        let targetId = integrationId || integration?.id || knownIntegrations[0]?.id || null;

        if (!targetId || options?.refreshList) {
          knownIntegrations = await loadIntegrationList({ force: options?.force || options?.refreshList });
          targetId = integrationId || knownIntegrations[0]?.id || null;
        }

        if (!targetId) {
          setIntegration(null);
          setDetail(null);
          return;
        }

        const detailData = await loadIntegrationSnapshot(targetId, { force: options?.force });
        if (!detailData) {
          const fallbackIntegration =
            knownIntegrations.find((item) => item.id === targetId) ||
            (integration?.id === targetId ? integration : null);
          setIntegration(fallbackIntegration);
          setDetail(null);
          return;
        }

        const cachedIntegrations = integrationListCacheRef.current?.data || [];
        const nextList = cachedIntegrations.some((item) => item.id === detailData.integration.id)
          ? cachedIntegrations.map((item) =>
              item.id === detailData.integration.id ? detailData.integration : item
            )
          : [...cachedIntegrations, detailData.integration];
        integrationListCacheRef.current = {
          data: nextList,
          fetchedAt: Date.now(),
        };

        setIntegration(detailData.integration);
        setDetail(detailData);
        setSelectedOrgTargetId(detailData.integration.selectedOrgTargetId || null);
      } catch (error) {
        setPageError(error instanceof Error ? error.message : '加载配置失败。');
      } finally {
        setIsLoadingDetail(false);
      }
    },
    [integration, loadIntegrationList, loadIntegrationSnapshot]
  );

  useEffect(() => {
    if (user) {
      void loadIntegrationDetail(requestedIntegrationId);
    }
  }, [loadIntegrationDetail, requestedIntegrationId, user]);

  const autoCheckTriggerKey = useMemo(() => {
    if (!integration?.id) return '';
    return [
      integration.id,
      integration.selectedOrgTargetId || selectedOrgTargetId || 'no-org',
      detail?.authorization?.updatedAt ?? 'no-oauth-update',
    ].join(':');
  }, [detail?.authorization?.updatedAt, integration?.id, integration?.selectedOrgTargetId, selectedOrgTargetId]);

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
      await loadIntegrationDetail(integration.id, { force: true });
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
    setVerificationUrl(null);
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
            setVerificationUrl(null);
            const completedIntegration = pollData?.data?.integration as IntegrationView | undefined;
            const completedIntegrationId = pollData?.data?.integrationId as string | undefined;
            if (completedIntegration) {
              setIntegration(completedIntegration);
            }
            if (completedIntegrationId) {
              await loadIntegrationDetail(completedIntegrationId, { force: true });
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
            setVerificationUrl(null);
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
              setAuthorizeUrl(null);
              await loadIntegrationDetail(integration.id, { force: true });
            } else if (pollResult.status === 'denied' || pollResult.status === 'expired' || pollResult.status === 'error') {
              setAuthorizePollStatus(pollResult.status);
              setAuthorizeUrl(null);
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
      if (checksRequestRef.current) {
        try {
          await checksRequestRef.current;
        } catch (error) {
          if (!options?.silent) {
            setPageError(error instanceof Error ? error.message : '系统内部校验失败。');
          }
        }
        return;
      }

      setIsRunningChecks(true);
      if (!options?.silent) {
        setPageError(null);
      }

      const request = (async () => {
        await parseJsonResponse<{ allPassed: boolean }>(
          await fetch(`/api/feishu/integrations/${integrationId}/checks`, {
            method: 'POST',
            headers: setupHeaders(),
          })
        );
        await loadIntegrationDetail(integrationId, { force: true });
      })();
      checksRequestRef.current = request;

      try {
        await request;
      } catch (error) {
        if (!options?.silent) {
          setPageError(error instanceof Error ? error.message : '系统内部校验失败。');
        }
      } finally {
        if (checksRequestRef.current === request) {
          checksRequestRef.current = null;
        }
        setIsRunningChecks(false);
      }
    },
    [loadIntegrationDetail, setupHeaders]
  );

  const handleSubmitFeedback = useCallback(async () => {
    const trimmedFeedback = feedbackDraft.trim();
    if (!trimmedFeedback) {
      setPageError('请先描述你遇到的问题，最好带上发生阶段、现象、报错和影响。');
      return;
    }

    setIsSubmittingFeedback(true);
    setPageError(null);

    try {
      const pageQuery = searchParams.toString();
      const sourcePage = pageQuery ? `${pathname}?${pageQuery}` : pathname;
      await parseJsonResponse<{ id: string; createdAt: string }>(
        await fetch('/api/feedback', {
          method: 'POST',
          headers: setupHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            sourcePage,
            currentStep: getStepLogLabel(currentStep),
            integrationId: integration?.id || null,
            orgTargetId: selectedOrgTargetId || integration?.selectedOrgTargetId || null,
            taskId: null,
            recordId: null,
            feedbackText: trimmedFeedback,
            metadata: {
              pageType: 'feishu_config_workspace',
              setupComplete,
              selectedOrgName: selectedOrgTarget?.orgName || null,
              authorizationStatus: detail?.authorization?.status || null,
              baseStatus: detail?.checks?.baseStatus || null,
              eventSubscriptionStatus: detail?.checks?.eventSubscriptionStatus || null,
              lastErrorMessage: detail?.checks?.lastErrorMessage || null,
            },
          }),
        })
      );
      setFeedbackDraft('');
      setIsFeedbackDialogOpen(false);
      setFeedbackSuccessMessage('反馈已提交。我们会结合页面上下文和日志继续排查。');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '提交反馈失败。');
    } finally {
      setIsSubmittingFeedback(false);
    }
  }, [
    currentStep,
    detail?.authorization?.status,
    detail?.checks?.baseStatus,
    detail?.checks?.eventSubscriptionStatus,
    detail?.checks?.lastErrorMessage,
    feedbackDraft,
    integration?.id,
    integration?.selectedOrgTargetId,
    pathname,
    searchParams,
    selectedOrgTarget?.orgName,
    selectedOrgTargetId,
    setupComplete,
    setupHeaders,
  ]);

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

      <Dialog open={isFeedbackDialogOpen} onOpenChange={setIsFeedbackDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>反馈问题</DialogTitle>
          </DialogHeader>
          <div>
            <Textarea
              value={feedbackDraft}
              onChange={(event) => setFeedbackDraft(event.target.value)}
              placeholder={feedbackPlaceholder}
              className="min-h-36"
              disabled={isSubmittingFeedback}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsFeedbackDialogOpen(false)}
              disabled={isSubmittingFeedback}
            >
              取消
            </Button>
            <Button type="button" onClick={() => void handleSubmitFeedback()} disabled={isSubmittingFeedback}>
              {isSubmittingFeedback ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  提交中
                </>
              ) : (
                '提交反馈'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-6xl flex-col gap-3 py-4 lg:h-[calc(100dvh-4rem)] lg:overflow-hidden lg:py-5">
        <div className="shrink-0 space-y-0.5">
          <h1 className="text-xl font-bold text-slate-900">飞书集成配置</h1>
          <p className="text-sm text-slate-600">完成创建应用、用户授权和组织选择，系统会自动校验目标表格与事件监听状态。</p>
        </div>

        <div className="sticky top-[88px] z-30 -mx-1 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur lg:hidden">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge className={setupComplete ? 'bg-emerald-100 text-emerald-700' : 'bg-indigo-100 text-indigo-700'}>
                  {mobileStatusSummary.badge}
                </Badge>
                <span className="text-xs text-slate-500">操作步骤 {completedActionSteps}/3</span>
              </div>
              <div className="mt-2 text-sm font-semibold text-slate-900">{mobileStatusSummary.title}</div>
              <p className="mt-1 text-xs leading-5 text-slate-600">{mobileStatusSummary.description}</p>
            </div>
            <div className="flex shrink-0 items-start gap-2">
              {user ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsFeedbackDialogOpen(true)}
                  className="h-7 px-2 text-xs"
                >
                  <MessageSquare className="mr-1 h-3.5 w-3.5" />
                  反馈问题
                </Button>
              ) : null}
              <div className="text-right">
                <div className="text-[11px] text-slate-500">当前进度</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">{Math.min(currentStep, 3)}/3</div>
              </div>
            </div>
          </div>
          <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2">
            <div className="text-xs font-medium text-slate-900">系统校验结果</div>
            <div className="mt-2 grid grid-cols-5 gap-1.5">
              {systemCheckItems.map((item) => (
                <div
                  key={item.label}
                  title={`${item.label}：${item.value}`}
                  aria-label={`${item.label}：${item.value}`}
                  className={`rounded-lg border px-1 py-2 text-center ${getCheckStatusCardTone(item.status)}`}
                >
                  <div className="truncate text-[11px] font-medium">{item.shortLabel}</div>
                  <div className="mt-1 flex justify-center">
                    <span className={`h-2.5 w-2.5 rounded-full ${getCheckStatusDotTone(item.status)}`} aria-hidden />
                    <span className="sr-only">{item.value}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-600">
              {CHECK_STATUS_LEGEND.map((item) => (
                <span key={item.status} className="inline-flex items-center gap-1">
                  <span className={`h-2 w-2 rounded-full ${getCheckStatusDotTone(item.status)}`} aria-hidden />
                  {item.label}
                </span>
              ))}
            </div>
          </div>
          {feedbackSuccessMessage ? (
            <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              {feedbackSuccessMessage}
            </div>
          ) : null}
        </div>

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="hidden min-h-0 flex-col gap-2 lg:flex">
            <Card className="shrink-0">
              <CardContent className="p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-900">配置进度</div>
                  <div className="flex items-center gap-1 text-xs text-slate-500">
                    <span>第 {currentStep} 步</span>
                    <ArrowRight className="h-3 w-3" />
                    <span>共 5 步</span>
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
                  {integration?.id ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => void runAutomatedChecks(integration.id)} disabled={isRunningChecks} className="h-6 px-2 text-xs">
                      <RefreshCw className={`mr-1 h-3 w-3 ${isRunningChecks ? 'animate-spin' : ''}`} />
                      刷新
                    </Button>
                  ) : null}
                </div>
                <div className="space-y-1 text-xs">
                  {systemCheckItems.map((item) => (
                    <div
                      key={item.label}
                      className={`flex items-center justify-between ${getCheckStatusTextTone(item.status)}`}
                    >
                      <span>{item.label}</span>
                      <span className="text-xs">{item.value}</span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-slate-100 pt-1.5 text-[10px] text-slate-500">
                  {CHECK_STATUS_LEGEND.map((item) => (
                    <span key={item.status} className="inline-flex items-center gap-1">
                      <span className={`h-2 w-2 rounded-full ${getCheckStatusDotTone(item.status)}`} aria-hidden />
                      {item.label}
                    </span>
                  ))}
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
                {user || feedbackSuccessMessage ? (
                  <div className="hidden shrink-0 items-center gap-3 lg:flex">
                    {feedbackSuccessMessage ? (
                      <div className="min-w-0 flex-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                        {feedbackSuccessMessage}
                      </div>
                    ) : (
                      <div className="flex-1" />
                    )}
                    {user ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setIsFeedbackDialogOpen(true)}
                        className="shrink-0"
                      >
                        <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                        反馈问题
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {authLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-48 w-full" />
                  </div>
                ) : (
                  <>
                    <div id="step-create-app" className={getStepPanelClassName(createStepIsActive)}>
                      <StepHeader
                        step={1}
                        status={integration ? 'completed' : 'current'}
                        description={getStepDescription(1)}
                      />
                      <CardContent className="min-h-0 flex-1 px-0 pb-0 pt-0">
                        {!integration ? (
                          <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50 p-3">
                            {verificationUrl ? (
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-medium text-indigo-900">飞书创建链接已就绪</div>
                                </div>
                                <Button type="button" size="sm" className="w-full shrink-0 sm:w-auto" onClick={() => openActionLink(verificationUrl)}>
                                  前往飞书创建
                                </Button>
                              </div>
                            ) : (
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                <div className="min-w-0">
                                  <h3 className="text-sm font-semibold text-slate-900">创建飞书应用</h3>
                                </div>
                                <Button onClick={handleCreateApp} disabled={isCreatingApp} size="sm" className="w-full shrink-0 sm:w-auto">
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
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                              <div className="flex min-w-0 items-center gap-2">
                                <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                                <span className="truncate text-sm font-medium text-emerald-900">应用已创建：{integration.name}</span>
                              </div>
                              <span className="break-all font-mono text-[11px] text-emerald-700 sm:shrink-0 sm:text-right">{integration.appId}</span>
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
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-indigo-900">授权链接已就绪</div>
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
                                  <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                                    <Button type="button" size="sm" onClick={() => openActionLink(authorizeUrl)} className="w-full sm:w-auto">
                                      前往飞书授权
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => {
                                        setAuthorizeUrl(null);
                                        setAuthorizePollStatus('idle');
                                        if (authorizePollRef.current) {
                                          clearTimeout(authorizePollRef.current);
                                          authorizePollRef.current = null;
                                        }
                                      }}
                                      className="w-full sm:w-auto"
                                    >
                                      重新发起
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                  <div className="min-w-0">
                                    <h3 className="text-sm font-semibold text-slate-900">授权应用</h3>
                                    <p className="mt-1 text-xs leading-4 text-slate-600">允许系统读取妙记并写入目标多维表格。</p>
                                  </div>
                                  <Button onClick={handleAuthorize} disabled={isAuthorizing} size="sm" className="w-full shrink-0 sm:w-auto">
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
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
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
                                className="w-full shrink-0 sm:w-auto"
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

                    {automaticSetupProgress ? (
                      <div
                        id="step-checks"
                        role="status"
                        aria-live="polite"
                        className={`hidden rounded-xl border p-4 lg:block ${
                          automaticSetupProgress.status === 'success'
                            ? 'border-emerald-200 bg-emerald-50'
                            : automaticSetupProgress.status === 'failed'
                              ? 'border-red-200 bg-red-50'
                              : 'border-indigo-200 bg-indigo-50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex min-w-0 items-start gap-3">
                            <div
                              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                                automaticSetupProgress.status === 'success'
                                  ? 'bg-emerald-100 text-emerald-600'
                                  : automaticSetupProgress.status === 'failed'
                                    ? 'bg-red-100 text-red-600'
                                    : 'bg-indigo-100 text-indigo-600'
                              }`}
                            >
                              {automaticSetupProgress.status === 'success' ? (
                                <Check className="h-5 w-5" />
                              ) : automaticSetupProgress.status === 'failed' ? (
                                <AlertCircle className="h-5 w-5" />
                              ) : (
                                <RefreshCw className="h-5 w-5 animate-spin" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div
                                className={`text-sm font-semibold ${
                                  automaticSetupProgress.status === 'success'
                                    ? 'text-emerald-900'
                                    : automaticSetupProgress.status === 'failed'
                                      ? 'text-red-900'
                                      : 'text-indigo-900'
                                }`}
                              >
                                {automaticSetupProgress.title}
                              </div>
                              <p className="mt-1 text-xs leading-5 text-slate-600">
                                {automaticSetupProgress.description}
                              </p>
                            </div>
                          </div>
                          {automaticSetupProgress.status === 'running' ? (
                            <Badge className="shrink-0 bg-indigo-100 text-indigo-700">系统处理中</Badge>
                          ) : null}
                          {automaticSetupProgress.status === 'failed' && integration?.id ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void runAutomatedChecks(integration.id)}
                              disabled={isRunningChecks}
                              className="shrink-0 border-red-200 bg-white text-red-700 hover:bg-red-50"
                            >
                              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isRunningChecks ? 'animate-spin' : ''}`} />
                              重新检查
                            </Button>
                          ) : null}
                        </div>
                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/80">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${
                              automaticSetupProgress.status === 'success'
                                ? 'bg-emerald-500'
                                : automaticSetupProgress.status === 'failed'
                                  ? 'bg-red-500'
                                  : 'bg-indigo-500'
                            }`}
                            style={{ width: `${automaticSetupProgress.progress}%` }}
                          />
                        </div>
                        {automaticSetupProgress.status === 'running' ? (
                          <p className="mt-2 text-[11px] text-slate-500">
                            无需继续操作，请保持页面打开；全部完成后系统会自动提示。
                          </p>
                        ) : null}
                      </div>
                    ) : null}

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
