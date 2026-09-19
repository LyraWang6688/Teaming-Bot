/**
 * Base 字段绑定服务
 *
 * 背景：
 * - 飞书记录读写 API 的 fields 只认 field_name，运营在 Base 里改字段名会导致 1254045 FieldNameNotFound
 * - field_id 在「改名」后保持稳定；因此绑定 field_id，运行时用 field_id 反查当前 field_name
 * - 绑定按 project_id + table_id 隔离，代码只认业务字段 key（BusinessFieldKey），
 *   不再硬编码任何一期表的中文字段名
 *
 * 生命周期：
 * 1. bootstrap：某项目首次同步且 base_field_bindings 无记录时，拉取表字段清单，
 *    按约定字段名（canonicalName）精确匹配并落库
 * 2. 运行时解析：业务 key -> field_id -> 当前 field_name；进程内缓存 10 分钟
 * 3. 自愈：写入遇 1254045 → 强制刷新缓存重试一次；定时过期刷新也能感知改名/删除/重建
 * 4. 缺字段策略：required key 无法解析时抛错（同步失败，行为同旧链路）；
 *    非 required key 无法解析时跳过该字段并告警，其余字段照常写入
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { baseFieldBindings, type BaseFieldBindingRow } from '@/lib/db/schema';
import { logFeishuMonitor } from '../common/monitor';
import {
  type BitableFieldMeta,
  type FeishuBitableAccess,
  listBitableFields,
} from './bitableOpenApi';

/** 飞书字段名不存在错误码（FieldNameNotFound） */
export const FIELD_NAME_NOT_FOUND_CODE = 1254045;

/**
 * 业务字段约定表（当前对应第四期表）。
 * canonicalName 是绑定时的匹配名；之后运营改名不影响绑定（跟随 field_id）。
 * valueType 是写入协议要求的字段类型：text=文本（含 url 样式），select=单选。
 */
export const BASE_BUSINESS_FIELD_SPECS = {
  meeting_id: { canonicalName: '会议ID', valueType: 'text', required: true },
  meeting_name: { canonicalName: '会议名称', valueType: 'text', required: false },
  meeting_category: { canonicalName: '会议分类', valueType: 'text', required: false },
  direction: { canonicalName: '方向', valueType: 'select', required: false },
  creator: { canonicalName: '会议owner', valueType: 'text', required: false },
  process_status: { canonicalName: '处理状态', valueType: 'select', required: true },
  transcript: { canonicalName: '会议文字稿', valueType: 'text', required: false },
  analysis_summary: { canonicalName: '分析摘要', valueType: 'text', required: false },
  zone: { canonicalName: '团队氛围', valueType: 'select', required: false },
  report_url: { canonicalName: '报告链接', valueType: 'text', required: false },
  error_info: { canonicalName: '后台日志', valueType: 'text', required: false },
} as const;

export type BusinessFieldKey = keyof typeof BASE_BUSINESS_FIELD_SPECS;
export type BusinessFieldEntries = Partial<Record<BusinessFieldKey, unknown>>;

type BindingContext = { projectId: string; tableId: string };

type CacheEntry = {
  fetchedAt: number;
  /** 拉取失败时来自数据库快照，stale=true */
  stale: boolean;
  liveFields: BitableFieldMeta[];
  bindings: Map<BusinessFieldKey, BaseFieldBindingRow>;
};

const BINDING_CACHE_TTL_MS = 10 * 60 * 1000;
const bindingCache = new Map<string, CacheEntry>();
const inflightLoads = new Map<string, Promise<CacheEntry>>();

function getBindingContext(config: FeishuBitableAccess): BindingContext | null {
  const projectId = config.orgTarget?.projectId;
  if (!projectId || !config.tableId) return null;
  return { projectId, tableId: config.tableId };
}

function bindingCacheKey(ctx: BindingContext): string {
  return `${ctx.projectId}:${ctx.tableId}`;
}

export function isFieldNameNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === FIELD_NAME_NOT_FOUND_CODE
  );
}

async function loadBindingsFromDb(ctx: BindingContext): Promise<BaseFieldBindingRow[]> {
  return getDb()
    .select()
    .from(baseFieldBindings)
    .where(
      and(
        eq(baseFieldBindings.projectId, ctx.projectId),
        eq(baseFieldBindings.tableId, ctx.tableId)
      )
    );
}

type ReconciledBinding = {
  key: BusinessFieldKey;
  status: 'bound' | 'unbound';
  fieldId: string | null;
  fieldName: string | null;
  fieldType: BitableFieldMeta['type'] | null;
};

/**
 * 用最新字段清单与 DB 绑定行对账：
 * - bound 且 field_id 仍在（含被改名）→ 跟随 field_id，快照更新为当前名
 * - bound 但 field_id 消失 → 尝试按约定名重新匹配（覆盖「删除后重建」），否则置 unbound
 * - unbound 但约定名字段出现 → 自动重新绑定
 */
function reconcile(
  liveFields: BitableFieldMeta[],
  dbRows: BaseFieldBindingRow[]
): ReconciledBinding[] {
  const liveById = new Map(liveFields.map((field) => [field.fieldId, field]));
  const dbByKey = new Map(dbRows.map((row) => [row.businessKey as BusinessFieldKey, row]));

  return (Object.keys(BASE_BUSINESS_FIELD_SPECS) as BusinessFieldKey[]).map((key) => {
    const spec = BASE_BUSINESS_FIELD_SPECS[key];
    const existing = dbByKey.get(key);
    const matchCanonical = () =>
      liveFields.find((field) => field.fieldName === spec.canonicalName) ?? null;

    let target: BitableFieldMeta | null = null;

    if (existing?.bindingStatus === 'bound' && existing.fieldId) {
      target = liveById.get(existing.fieldId) ?? matchCanonical();
    } else {
      target = matchCanonical();
    }

    if (target) {
      return {
        key,
        status: 'bound',
        fieldId: target.fieldId,
        fieldName: target.fieldName,
        fieldType: target.type,
      };
    }

    return {
      key,
      status: 'unbound',
      fieldId: null,
      fieldName: null,
      fieldType: null,
    };
  });
}

async function persistReconciledBindings(
  ctx: BindingContext,
  reconciled: ReconciledBinding[]
): Promise<void> {
  const checkedAt = new Date();
  await getDb()
    .insert(baseFieldBindings)
    .values(
      reconciled.map((binding) => ({
        projectId: ctx.projectId,
        tableId: ctx.tableId,
        businessKey: binding.key,
        fieldId: binding.fieldId,
        fieldNameSnapshot: binding.fieldName,
        fieldTypeSnapshot: binding.fieldType,
        bindingStatus: binding.status,
        required: BASE_BUSINESS_FIELD_SPECS[binding.key].required,
        lastCheckedAt: checkedAt,
        updatedAt: checkedAt,
      }))
    )
    .onConflictDoUpdate({
      target: [
        baseFieldBindings.projectId,
        baseFieldBindings.tableId,
        baseFieldBindings.businessKey,
      ],
      set: {
        fieldId: sql`excluded.field_id`,
        fieldNameSnapshot: sql`excluded.field_name_snapshot`,
        fieldTypeSnapshot: sql`excluded.field_type_snapshot`,
        bindingStatus: sql`excluded.binding_status`,
        required: sql`excluded.required`,
        lastCheckedAt: sql`excluded.last_checked_at`,
        updatedAt: checkedAt,
      },
    });
}

function entryFromSnapshot(dbRows: BaseFieldBindingRow[], fetchedAt: number): CacheEntry {
  const liveFields: BitableFieldMeta[] = dbRows
    .filter((row) => row.bindingStatus === 'bound' && row.fieldId && row.fieldNameSnapshot)
    .map((row) => ({
      fieldId: row.fieldId as string,
      fieldName: row.fieldNameSnapshot as string,
      type: (row.fieldTypeSnapshot as BitableFieldMeta['type']) ?? 'other',
      rawType: null,
      rawUiType: null,
    }));
  return {
    fetchedAt,
    stale: true,
    liveFields,
    bindings: new Map(dbRows.map((row) => [row.businessKey as BusinessFieldKey, row])),
  };
}

async function loadEntry(config: FeishuBitableAccess, ctx: BindingContext): Promise<CacheEntry> {
  const dbRows = await loadBindingsFromDb(ctx);
  const fetchedAt = Date.now();

  let liveFields: BitableFieldMeta[];
  try {
    liveFields = await listBitableFields(config);
  } catch (error) {
    // 拉字段清单失败但已有绑定时，降级使用 DB 快照，避免飞书列表接口抖动拖垮记录写入
    if (dbRows.length > 0) {
      logFeishuMonitor('warn', 'base_field_binding_list_failed_use_snapshot', {
        userId: config.userId,
        integrationId: config.integrationId,
        projectId: ctx.projectId,
        tableId: ctx.tableId,
      });
      return entryFromSnapshot(dbRows, fetchedAt);
    }
    throw error;
  }

  const reconciled = reconcile(liveFields, dbRows);
  await persistReconciledBindings(ctx, reconciled);

  const freshRows: BaseFieldBindingRow[] = reconciled.map((binding) => ({
    id: '',
    projectId: ctx.projectId,
    tableId: ctx.tableId,
    businessKey: binding.key,
    fieldId: binding.fieldId,
    fieldNameSnapshot: binding.fieldName,
    fieldTypeSnapshot: binding.fieldType,
    bindingStatus: binding.status,
    required: BASE_BUSINESS_FIELD_SPECS[binding.key].required,
    mappingVersion: 1,
    lastCheckedAt: new Date(fetchedAt),
    createdAt: new Date(0),
    updatedAt: new Date(fetchedAt),
  }));

  return {
    fetchedAt,
    stale: false,
    liveFields,
    bindings: new Map(freshRows.map((row) => [row.businessKey as BusinessFieldKey, row])),
  };
}

async function getCacheEntry(
  config: FeishuBitableAccess,
  ctx: BindingContext
): Promise<CacheEntry> {
  const key = bindingCacheKey(ctx);
  const cached = bindingCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < BINDING_CACHE_TTL_MS) {
    return cached;
  }

  const inflight = inflightLoads.get(key);
  if (inflight) return inflight;

  const promise = loadEntry(config, ctx).finally(() => {
    inflightLoads.delete(key);
  });
  inflightLoads.set(key, promise);

  const entry = await promise;
  bindingCache.set(key, entry);
  return entry;
}

/** 强制丢弃缓存并立即拉取最新字段清单（写入遇 FieldNameNotFound 后的自愈入口） */
export async function forceRefreshFieldBindings(
  config: FeishuBitableAccess
): Promise<void> {
  const ctx = getBindingContext(config);
  if (!ctx) return;
  bindingCache.delete(bindingCacheKey(ctx));
  inflightLoads.delete(bindingCacheKey(ctx));
  await getCacheEntry(config, ctx);
}

function resolveLiveField(
  entry: CacheEntry,
  key: BusinessFieldKey
): { field?: BitableFieldMeta; row?: BaseFieldBindingRow } {
  const row = entry.bindings.get(key);
  if (row?.bindingStatus !== 'bound' || !row.fieldId) return {};
  return { field: entry.liveFields.find((field) => field.fieldId === row.fieldId), row };
}

/**
 * 把「业务 key -> 值」解析为飞书 API 需要的「当前字段名 -> 值」。
 *
 * - 无项目上下文（未选方向/测试链路）：直接使用约定字段名，保持旧行为
 * - required key 缺失/类型不兼容：抛错，本次同步失败（由上层标记写入失败并重试）
 * - 非 required key 缺失/类型不兼容：跳过并告警，不影响其他字段写入
 */
export async function resolveBusinessFields(
  config: FeishuBitableAccess,
  entries: BusinessFieldEntries
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};
  const ctx = getBindingContext(config);

  if (!ctx) {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined || value === null) continue;
      resolved[BASE_BUSINESS_FIELD_SPECS[key as BusinessFieldKey].canonicalName] = value;
    }
    return resolved;
  }

  const entry = await getCacheEntry(config, ctx);

  for (const [rawKey, value] of Object.entries(entries)) {
    if (value === undefined || value === null) continue;
    const key = rawKey as BusinessFieldKey;
    const spec = BASE_BUSINESS_FIELD_SPECS[key];
    const { field } = resolveLiveField(entry, key);

    if (!field) {
      if (spec.required) {
        throw new Error(`Base 必需字段未绑定：业务字段「${spec.canonicalName}」在目标表中不存在`);
      }
      logFeishuMonitor('warn', 'base_field_binding_missing_skip', {
        userId: config.userId,
        integrationId: config.integrationId,
        projectId: ctx.projectId,
        tableId: ctx.tableId,
        businessKey: key,
        canonicalName: spec.canonicalName,
      });
      continue;
    }

    if (field.type !== spec.valueType) {
      if (spec.required) {
        throw new Error(
          `Base 必需字段类型不兼容：「${field.fieldName}」当前类型=${field.type}，需要=${spec.valueType}`
        );
      }
      logFeishuMonitor('warn', 'base_field_binding_type_incompatible_skip', {
        userId: config.userId,
        integrationId: config.integrationId,
        projectId: ctx.projectId,
        tableId: ctx.tableId,
        businessKey: key,
        fieldId: field.fieldId,
        fieldName: field.fieldName,
        actualType: field.type,
        expectedType: spec.valueType,
      });
      continue;
    }

    resolved[field.fieldName] = value;
  }

  return resolved;
}

/**
 * 解析单个字段的当前名称（用于读路径：记录搜索 filter、处理状态更新）。
 * 无法解析时回退约定名（交由飞书 API 返回真实错误，不掩盖问题）。
 */
export async function resolveFieldName(
  config: FeishuBitableAccess,
  key: BusinessFieldKey
): Promise<string> {
  const spec = BASE_BUSINESS_FIELD_SPECS[key];
  const ctx = getBindingContext(config);
  if (!ctx) return spec.canonicalName;

  try {
    const entry = await getCacheEntry(config, ctx);
    const { field } = resolveLiveField(entry, key);
    return field?.fieldName ?? spec.canonicalName;
  } catch {
    return spec.canonicalName;
  }
}
