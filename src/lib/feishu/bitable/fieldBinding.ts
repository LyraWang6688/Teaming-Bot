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
 * 1. bootstrap：迁移上线后 / 启动时对所有已配置项目一次性补绑定，按 canonical+别名匹配并落库
 * 2. 运行时解析：业务 key -> field_id -> 当前 field_name；进程内缓存 10 分钟
 * 3. 自愈：写入遇 1254045 → 强制刷新缓存重试一次；定时过期刷新也能感知改名/删除/重建
 * 4. 绑定三态：bound（名字+类型都对）/ type_mismatch（名字对上但类型不符，如第三期分类是单选、
 *    创建人是人员字段）/ unbound（名字找不到）；disabled 为人工停用，自动对账永不覆盖
 * 5. 部分同步：写入只带 bound 字段；required 缺失由上层将 Base 任务置 blocked；
 *    非 required 缺失/不兼容 → 其余字段照常写入，任务标 partial，不阻断分析与通知
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

export type BindingStatus = 'bound' | 'unbound' | 'type_mismatch' | 'disabled';
export type BindingBoundBy = 'bootstrap' | 'auto' | 'manual';

/**
 * 业务字段约定表（当前对应第四期表）。
 * canonicalName 是绑定时的首选匹配名；aliases 覆盖第三期表历史字段名。
 * valueType 是写入协议要求的字段类型：text=文本（含 url 样式），select=单选。
 */
export const BASE_BUSINESS_FIELD_SPECS = {
  meeting_id: { canonicalName: '会议ID', aliases: [] as string[], valueType: 'text', required: true },
  meeting_name: { canonicalName: '会议名称', aliases: [] as string[], valueType: 'text', required: false },
  meeting_category: {
    canonicalName: '会议分类',
    aliases: [] as string[],
    valueType: 'text',
    required: false,
  },
  direction: { canonicalName: '方向', aliases: ['数据来源'], valueType: 'select', required: false },
  creator: { canonicalName: '会议owner', aliases: ['创建人'], valueType: 'text', required: false },
  process_status: {
    canonicalName: '处理状态',
    aliases: [] as string[],
    valueType: 'select',
    required: true,
  },
  transcript: { canonicalName: '会议文字稿', aliases: [] as string[], valueType: 'text', required: false },
  analysis_summary: {
    canonicalName: '分析摘要',
    aliases: [] as string[],
    valueType: 'text',
    required: false,
  },
  zone: { canonicalName: '团队氛围', aliases: ['会议状态'], valueType: 'select', required: false },
  report_url: { canonicalName: '报告链接', aliases: [] as string[], valueType: 'text', required: false },
  error_info: { canonicalName: '后台日志', aliases: ['错误信息'], valueType: 'text', required: false },
} as const;

export type BusinessFieldKey = keyof typeof BASE_BUSINESS_FIELD_SPECS;
export type BusinessFieldEntries = Partial<Record<BusinessFieldKey, unknown>>;

export type BindingContext = { projectId: string; tableId: string };

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
  const projectId = config.orgTarget?.projectId ?? config.projectIdOverride;
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

/** 所有业务字段的 canonical 名集合：别名匹配时不得抢占其他 key 的 canonical 字段 */
const ALL_CANONICAL_NAMES: Set<string> = new Set(
  Object.values(BASE_BUSINESS_FIELD_SPECS).map((spec) => spec.canonicalName)
);

type ReconciledBinding = {
  key: BusinessFieldKey;
  status: BindingStatus;
  fieldId: string | null;
  fieldName: string | null;
  fieldType: BitableFieldMeta['type'] | null;
};

function matchByName(
  liveFields: BitableFieldMeta[],
  name: string,
  ownCanonical: string
): BitableFieldMeta | null {
  // 别名若恰好是别的业务字段的 canonical 名，不允许抢占
  if (name !== ownCanonical && ALL_CANONICAL_NAMES.has(name)) return null;
  return liveFields.find((field) => field.fieldName === name) ?? null;
}

/**
 * 用最新字段清单与 DB 绑定行对账：
 * - disabled（人工停用）：永不自动覆盖
 * - bound 且 field_id 仍在（含被改名）→ 跟随 field_id，再校验类型（改类型 → type_mismatch）
 * - bound 但 field_id 消失 → 按 canonical→别名 重新匹配（覆盖「删除后重建」），否则置 unbound
 * - 历史 unbound / type_mismatch：canonical→别名 重新匹配；名字对上但类型不符 → type_mismatch
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

    if (existing?.bindingStatus === 'disabled') {
      return {
        key,
        status: 'disabled',
        fieldId: existing.fieldId,
        fieldName: existing.fieldNameSnapshot,
        fieldType: (existing.fieldTypeSnapshot as BitableFieldMeta['type']) ?? null,
      };
    }

    const matchBySpecNames = (): BitableFieldMeta | null => {
      const canonical = matchByName(liveFields, spec.canonicalName, spec.canonicalName);
      if (canonical) return canonical;
      for (const alias of spec.aliases) {
        const aliasMatch = matchByName(liveFields, alias, spec.canonicalName);
        if (aliasMatch) return aliasMatch;
      }
      return null;
    };

    let target: BitableFieldMeta | null = null;
    if (existing?.fieldId) {
      target = liveById.get(existing.fieldId) ?? matchBySpecNames();
    } else {
      target = matchBySpecNames();
    }

    if (target) {
      return {
        key,
        status: target.type === spec.valueType ? 'bound' : 'type_mismatch',
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
  reconciled: ReconciledBinding[],
  boundBy: BindingBoundBy
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
        boundBy: binding.status === 'bound' ? boundBy : null,
        boundAt: binding.status === 'bound' ? checkedAt : null,
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
        // 人工 disabled 不允许自动对账覆盖
        bindingStatus: sql`CASE
          WHEN ${baseFieldBindings.bindingStatus} = 'disabled' THEN 'disabled'
          ELSE excluded.binding_status
        END`,
        required: sql`excluded.required`,
        // 仅在「非 bound → bound」时记录绑定来源/时间，已 bound 跟随改名不刷新
        boundBy: sql`CASE
          WHEN ${baseFieldBindings.bindingStatus} = 'disabled' THEN ${baseFieldBindings.boundBy}
          WHEN excluded.binding_status = 'bound' AND ${baseFieldBindings.bindingStatus} <> 'bound'
            THEN excluded.bound_by
          WHEN excluded.binding_status <> 'bound' THEN NULL
          ELSE ${baseFieldBindings.boundBy}
        END`,
        boundAt: sql`CASE
          WHEN ${baseFieldBindings.bindingStatus} = 'disabled' THEN ${baseFieldBindings.boundAt}
          WHEN excluded.binding_status = 'bound' AND ${baseFieldBindings.bindingStatus} <> 'bound'
            THEN excluded.bound_at
          WHEN excluded.binding_status <> 'bound' THEN NULL
          ELSE ${baseFieldBindings.boundAt}
        END`,
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

async function loadEntry(
  config: FeishuBitableAccess,
  ctx: BindingContext,
  boundBy: BindingBoundBy
): Promise<CacheEntry> {
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
  await persistReconciledBindings(ctx, reconciled, boundBy);

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
    boundBy: binding.status === 'bound' ? boundBy : null,
    boundAt: binding.status === 'bound' ? new Date(fetchedAt) : null,
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
  ctx: BindingContext,
  boundBy: BindingBoundBy = 'auto'
): Promise<CacheEntry> {
  const key = bindingCacheKey(ctx);
  const cached = bindingCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < BINDING_CACHE_TTL_MS) {
    return cached;
  }

  const inflight = inflightLoads.get(key);
  if (inflight) return inflight;

  const promise = loadEntry(config, ctx, boundBy).finally(() => {
    inflightLoads.delete(key);
  });
  inflightLoads.set(key, promise);

  const entry = await promise;
  bindingCache.set(key, entry);
  return entry;
}

/**
 * 强制丢弃缓存并立即拉取最新字段清单（写入遇 FieldNameNotFound 后的自愈入口）。
 * boundBy 仅影响本次「新绑定上」的行来源标记。
 */
export async function forceRefreshFieldBindings(
  config: FeishuBitableAccess,
  boundBy: BindingBoundBy = 'auto'
): Promise<void> {
  const ctx = getBindingContext(config);
  if (!ctx) return;
  bindingCache.delete(bindingCacheKey(ctx));
  inflightLoads.delete(bindingCacheKey(ctx));
  await getCacheEntry(config, ctx, boundBy);
}

function resolveLiveField(
  entry: CacheEntry,
  key: BusinessFieldKey
): { field?: BitableFieldMeta; row?: BaseFieldBindingRow } {
  const row = entry.bindings.get(key);
  if (row?.bindingStatus !== 'bound' || !row.fieldId) return {};
  return { field: entry.liveFields.find((field) => field.fieldId === row.fieldId), row };
}

export type SkippedBusinessField = {
  key: BusinessFieldKey;
  reason: 'unbound' | 'type_mismatch' | 'disabled';
  canonicalName: string;
  actualType?: string;
  expectedType?: string;
};

export type ResolveBusinessFieldsResult = {
  /** 飞书 API 需要的「当前字段名 -> 值」 */
  fields: Record<string, unknown>;
  /** 未能写入的业务字段及原因（供上层标记 blocked/partial） */
  skipped: SkippedBusinessField[];
  target: BindingContext | null;
  /** 是否使用了 DB 快照降级（字段清单接口失败时 true） */
  stale: boolean;
};

/**
 * 把「业务 key -> 值」解析为飞书 API 需要的「当前字段名 -> 值」，并返回完整跳过明细。
 *
 * - 无项目上下文（未选方向/测试链路）：直接使用约定字段名，保持旧行为
 * - bound 但运行时类型与 spec 不符：记 type_mismatch
 * - disabled / unbound / type_mismatch：该字段跳过并写入 skipped，由上层决定 blocked 或 partial
 */
export async function resolveBusinessFieldsDetailed(
  config: FeishuBitableAccess,
  entries: BusinessFieldEntries
): Promise<ResolveBusinessFieldsResult> {
  const resolved: Record<string, unknown> = {};
  const skipped: SkippedBusinessField[] = [];
  const ctx = getBindingContext(config);

  if (!ctx) {
    for (const [rawKey, value] of Object.entries(entries)) {
      if (value === undefined || value === null) continue;
      resolved[BASE_BUSINESS_FIELD_SPECS[rawKey as BusinessFieldKey].canonicalName] = value;
    }
    return { fields: resolved, skipped, target: null, stale: false };
  }

  const entry = await getCacheEntry(config, ctx);

  for (const [rawKey, value] of Object.entries(entries)) {
    if (value === undefined || value === null) continue;
    const key = rawKey as BusinessFieldKey;
    const spec = BASE_BUSINESS_FIELD_SPECS[key];
    const bindingRow = entry.bindings.get(key);
    const { field } = resolveLiveField(entry, key);

    if (!field || !bindingRow) {
      const reason: SkippedBusinessField['reason'] =
        bindingRow?.bindingStatus === 'type_mismatch'
          ? 'type_mismatch'
          : bindingRow?.bindingStatus === 'disabled'
            ? 'disabled'
            : 'unbound';
      skipped.push({
        key,
        reason,
        canonicalName: spec.canonicalName,
        actualType: bindingRow?.fieldTypeSnapshot ?? undefined,
        expectedType: spec.valueType,
      });
      continue;
    }

    if (field.type !== spec.valueType) {
      skipped.push({
        key,
        reason: 'type_mismatch',
        canonicalName: spec.canonicalName,
        actualType: field.type,
        expectedType: spec.valueType,
      });
      continue;
    }

    resolved[field.fieldName] = value;
  }

  return { fields: resolved, skipped, target: ctx, stale: entry.stale };
}

/**
 * 兼容旧签名：仅返回字段名->值（跳过明细丢弃）。
 * required key 缺失时抛错的行为已下沉到 Base 交付执行器（按 blocked/partial 处理）。
 */
export async function resolveBusinessFields(
  config: FeishuBitableAccess,
  entries: BusinessFieldEntries
): Promise<Record<string, unknown>> {
  const { fields } = await resolveBusinessFieldsDetailed(config, entries);
  return fields;
}

/**
 * 解析单个字段的当前名称（用于读路径：记录搜索 filter）。
 * 仅 bound 字段可解析；无法解析时回退约定名（交由飞书 API 返回真实错误，不掩盖问题）。
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

/** 返回某项目表当前未就绪（非 bound）的业务字段，供运维视图/排障查询 */
export async function listUnreadyBindings(
  ctx: BindingContext
): Promise<Array<{ key: BusinessFieldKey; status: BindingStatus; required: boolean }>> {
  const rows = await loadBindingsFromDb(ctx);
  return rows
    .filter((row) => row.bindingStatus !== 'bound')
    .map((row) => ({
      key: row.businessKey as BusinessFieldKey,
      status: row.bindingStatus as BindingStatus,
      required: row.required,
    }));
}
