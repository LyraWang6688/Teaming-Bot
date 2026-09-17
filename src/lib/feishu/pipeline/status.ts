/**
 * 飞书会议处理状态机
 *
 * 基于妙记生成事件（minutes.minute.generated_v1）触发
 *
 * 状态含义：
 * - 妙记已生成：已收到妙记生成事件，完成会议基础信息建档（中间态，仅 Supabase）
 * - 获取文字稿中：正在导出妙记文字稿（中间态，仅 Supabase）
 * - 分析中：已拿到转录稿，正在执行 Teaming 分析（中间态，仅 Supabase）
 * - 已完成：分析结果和报告数据已写回多维表格（终态）
 * - 分析失败：LLM 分析未成功，Supabase status='failed'（终态）
 * - 写入失败：LLM 分析成功但 Base 同步失败，Supabase status='base_sync_failed'（终态）
 * - 门槛未通过：会议创建人未在已初始化集成列表中，仅留档 Supabase，不写 Base
 *
 * Base「处理状态」单选字段只展示终态：已完成 / 分析失败 / 写入失败
 */
export const FEISHU_PROCESS_STATUS = {
  minuteGenerated: '妙记已生成',
  fetchingTranscript: '获取文字稿中',
  analyzing: '分析中',
  completed: '已完成',
  failed: '分析失败',
  baseSyncFailed: '写入失败',
  gatedSkipped: '门槛未通过',
} as const;

export type FeishuProcessStatus =
  typeof FEISHU_PROCESS_STATUS[keyof typeof FEISHU_PROCESS_STATUS];

export const FEISHU_ACTIVE_PROCESS_STATUSES: FeishuProcessStatus[] = [
  FEISHU_PROCESS_STATUS.minuteGenerated,
  FEISHU_PROCESS_STATUS.fetchingTranscript,
  FEISHU_PROCESS_STATUS.analyzing,
];
