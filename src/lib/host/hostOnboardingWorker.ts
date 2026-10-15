/**
 * 宿主开号 worker —— 把「飞书表单提交」变成「自动开通」。
 *
 * ## 流程
 *
 *   用户在飞书表单里填姓名提交
 *        ↓ 表单写进多维表格「开通申请」表（状态默认「待开通」）
 *   本 worker 每 60 秒扫一次
 *        ↓ 发现「待开通」的行
 *   调 `provisionHostUser()` 建用户 + 宿主集成 + 接入码
 *        ↓ 写回同一行
 *   状态=已开通、接入码、有效期、开通时间
 *        ↓
 *   飞书表那边的工作流把接入码回复给用户（那部分由飞书负责，不在代码里）
 *
 * ## 为什么状态要写「失败 + 备注」
 *
 * 开号失败的原因通常是**需要人处理**的（姓名重复、项目未配置、数据库异常），
 * 静默失败会让用户一直等。所以失败时把原因写进备注，运营侧一眼能看到。
 *
 * ## 幂等
 *
 * 只处理 `状态 = 待开通`（或空）的行。写回「已开通」之后就不会被再扫到，
 * 所以重复运行不会重复开号。
 *
 * 一个例外：如果 worker 在「开号成功」与「写回成功」之间崩了，
 * 那行还是「待开通」，下次会再开一次——但 `provisionHostUser` 会复用已有
 * 用户与集成，只是**多发一张接入码**。这是可接受的（旧码可单独吊销）。
 */
import { callGlobalBaseAppTenantOpenApi } from '@/lib/feishu/integration/integrationOpenApi';
import { logFeishuMonitor, toErrorContext } from '@/lib/feishu/common/monitor';
import { getFeishuBaseAppId, getFeishuBaseAppSecret } from '@/lib/platform/env';
import { provisionHostUser } from './hostUserProvisioning';

/** 「开通申请」表所在的 Base（平台 Base「会议动力分析·运营汇总」） */
const BASE_APP_TOKEN = process.env.HOST_ONBOARD_BASE_APP_TOKEN || 'UJ6ebt6QOalLHbsOj9CckZGenQg';
/** 「开通申请」表的 id */
const TABLE_ID = process.env.HOST_ONBOARD_TABLE_ID || 'tblwuW34iQW00RPH';

const POLL_INTERVAL_MS = Number(process.env.HOST_ONBOARD_POLL_INTERVAL_MS || 60_000);
const PAGE_SIZE = 50;

/** 状态字段的三个选项（与表里定义一致） */
const STATUS_PENDING = '待开通';
const STATUS_DONE = '已开通';
const STATUS_FAILED = '失败';

type BitableRecord = {
  record_id: string;
  fields: Record<string, unknown>;
};

function apiBase(): string {
  return `/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${TABLE_ID}`;
}

/** 从 Base 的文本/富文本字段里取出纯文本 */
function readTextField(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  // 富文本字段是 [{ text: '…', type: 'text' }] 这种结构
  if (Array.isArray(value)) {
    return value
      .map((seg) => (typeof seg === 'string' ? seg : typeof seg === 'object' && seg && 'text' in seg ? String((seg as { text?: unknown }).text ?? '') : ''))
      .join('')
      .trim();
  }
  return String(value).trim();
}

/** 从单选字段里取出选项名 */
function readSelectField(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && value.length) return readTextField(value[0]);
  if (typeof value === 'object' && 'name' in (value as Record<string, unknown>)) {
    return String((value as { name?: unknown }).name ?? '').trim();
  }
  return '';
}

/** 列出待开通的申请 */
async function listPendingApplications(): Promise<BitableRecord[]> {
  // ★ 用 list（GET /records）而不是 search（POST /records/search）。
  //
  // search 接口**要求带 keyword**；只传 sort 时它返回空结果而不报错——
  // 表现是"worker 每分钟都在跑、没有错误，但什么也不做"。
  // 2026-10-15 实测踩到：日志里 records/search 每分钟 completed，但 scanned 恒为 0。
  //
  // 这里本来也不需要关键词检索——只是要把整表拉下来筛选。list 正合适。
  // 不按状态过滤，取回后在代码里筛，这样「状态为空」的新行也能被发现。
  // ★ 注意这里收到的**已经剥掉最外层 data** 了（integrationOpenApi 的
  // unwrapFeishuResponse 会解开 { code, data } 外壳）。
  //
  // 而剥完之后记录数组的键名，不同接口/版本见过两种：`items` 与 `data`。
  // 2026-10-15 实测：只写 `items` 时永远取到空数组，表现是
  // "worker 每分钟都在请求、没有错误、但 scanned 恒为 0"。
  // 两种都兼容，并打一行日志把真实结构记下来。
  const response = await callGlobalBaseAppTenantOpenApi<unknown>(
    'GET',
    `${apiBase()}/records?page_size=${PAGE_SIZE}`,
  );

  const items: BitableRecord[] = Array.isArray(response)
    ? (response as BitableRecord[])
    : (() => {
        const bag = response as { items?: BitableRecord[]; data?: BitableRecord[] } | null;
        return bag?.items ?? bag?.data ?? [];
      })();

  if (!Array.isArray(items)) {
    logFeishuMonitor('warn', 'host_onboard_unexpected_payload', {
      got: typeof response,
      keys:
        response && typeof response === 'object'
          ? Object.keys(response as Record<string, unknown>).slice(0, 12)
          : [],
    });
    return [];
  }
  return items.filter((r) => {
    const status = readSelectField(r.fields['状态']);
    return status === '' || status === STATUS_PENDING;
  });
}

/** 把开通结果写回同一行 */
async function writeBack(
  recordId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await callGlobalBaseAppTenantOpenApi(
    'PUT',
    `${apiBase()}/records/${recordId}`,
    { fields },
  );
}

/**
 * 处理一轮。返回本轮结果，便于测试与日志。
 *
 * 导出是为了能在不启动轮询的情况下单测（见 tests/host-onboarding-worker）。
 */
export async function sweepHostOnboardingOnce(): Promise<{
  scanned: number;
  provisioned: number;
  failed: number;
}> {
  let pending: BitableRecord[];
  try {
    pending = await listPendingApplications();
  } catch (error) {
    logFeishuMonitor('error', 'host_onboard_list_failed', toErrorContext(error));
    return { scanned: 0, provisioned: 0, failed: 0 };
  }

  let provisioned = 0;
  let failed = 0;

  for (const record of pending) {
    const name = readTextField(record.fields['姓名']);
    if (!name) {
      // 表单要求姓名必填，但表被人手工改过就可能出现空行 —— 标出来别让它一直挂着
      failed += 1;
      try {
        await writeBack(record.record_id, {
          状态: STATUS_FAILED,
          备注: '姓名为空，无法开通。请在表单里补填后把状态改回「待开通」。',
        });
      } catch (error) {
        logFeishuMonitor('error', 'host_onboard_writeback_failed', {
          recordId: record.record_id,
          ...toErrorContext(error),
        });
      }
      continue;
    }

    try {
      const result = await provisionHostUser({ name });
      await writeBack(record.record_id, {
        状态: STATUS_DONE,
        接入码: result.code,
        有效期: result.expiresAt.getTime(),
        开通时间: Date.now(),
        备注: result.reusedUser
          ? `复用已有用户（集成 ${result.integrationId.slice(0, 8)}）`
          : `新建用户（集成 ${result.integrationId.slice(0, 8)}）`,
      });
      provisioned += 1;
      logFeishuMonitor('info', 'host_onboard_provisioned', {
        recordId: record.record_id,
        name,
        integrationId: result.integrationId,
        reusedUser: result.reusedUser,
        reusedIntegration: result.reusedIntegration,
      });
    } catch (error) {
      failed += 1;
      logFeishuMonitor('error', 'host_onboard_failed', {
        recordId: record.record_id,
        name,
        ...toErrorContext(error),
      });
      try {
        await writeBack(record.record_id, {
          状态: STATUS_FAILED,
          备注: `开通失败：${String((error as Error)?.message || error).slice(0, 180)}`,
        });
      } catch (writeError) {
        logFeishuMonitor('error', 'host_onboard_writeback_failed', {
          recordId: record.record_id,
          ...toErrorContext(writeError),
        });
      }
    }
  }

  return { scanned: pending.length, provisioned, failed };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** 启动轮询。重复调用是安全的（只会有定时器）。 */
export function startHostOnboardingWorker(): void {
  if (timer) return;
  // 平台 Base 的读写走平台级应用；没配就说明部署缺配置，早点说清楚
  try {
    getFeishuBaseAppId();
    getFeishuBaseAppSecret();
  } catch (error) {
    logFeishuMonitor('warn', 'host_onboard_worker_skipped', {
      hint: '平台 Base 应用凭证未配置，宿主开号 worker 未启动。',
      ...toErrorContext(error),
    });
    return;
  }

  const tick = async () => {
    if (running) return; // 上一轮还没跑完就跳过，避免堆积
    running = true;
    try {
      const result = await sweepHostOnboardingOnce();
      // 每次扫描都记一条：否则"每一轮都读到 0 行"和"worker 根本没跑"从日志上分不开
      // —— 2026-10-15 就是因为这个，多花了一轮排查。
      logFeishuMonitor('info', 'host_onboard_swept', result);
    } catch (error) {
      logFeishuMonitor('error', 'host_onboard_sweep_failed', toErrorContext(error));
    } finally {
      running = false;
    }
  };

  logFeishuMonitor('info', 'host_onboard_worker_started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    baseAppToken: BASE_APP_TOKEN,
    tableId: TABLE_ID,
  });
  // 启动后立刻跑一次（重启即补上停机期间提交的申请）
  void tick();
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** 仅测试用：停掉定时器 */
export function stopHostOnboardingWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
