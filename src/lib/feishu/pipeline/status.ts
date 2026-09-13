/**
 * 飞书会议处理状态机
 *
 * 基于妙记生成事件（minutes.minute.generated_v1）触发
 *
 * 状态含义：
 * - 妙记已生成：已收到妙记生成事件，完成会议基础信息建档
 * - 获取文字稿中：正在导出妙记文字稿
 * - 分析中：已拿到转录稿，正在执行 Teaming 分析
 * - 已完成：分析结果和报告数据已写回多维表格
 * - 失败：处理失败
 * - 门槛未通过：会议创建人未在已初始化集成列表中，仅留档 Supabase，不写 Base
 */
export const FEISHU_PROCESS_STATUS = {
  minuteGenerated: '妙记已生成',
  fetchingTranscript: '获取文字稿中',
  analyzing: '分析中',
  completed: '已完成',
  failed: '失败',
  gatedSkipped: '门槛未通过',
} as const;

export type FeishuProcessStatus =
  typeof FEISHU_PROCESS_STATUS[keyof typeof FEISHU_PROCESS_STATUS];

export const FEISHU_ACTIVE_PROCESS_STATUSES: FeishuProcessStatus[] = [
  FEISHU_PROCESS_STATUS.minuteGenerated,
  FEISHU_PROCESS_STATUS.fetchingTranscript,
  FEISHU_PROCESS_STATUS.analyzing,
];

export const FEISHU_STATUS_OPTIONS = [
  { name: FEISHU_PROCESS_STATUS.minuteGenerated, color: 0 },
  { name: FEISHU_PROCESS_STATUS.fetchingTranscript, color: 1 },
  { name: FEISHU_PROCESS_STATUS.analyzing, color: 1 },
  { name: FEISHU_PROCESS_STATUS.completed, color: 2 },
  { name: FEISHU_PROCESS_STATUS.failed, color: 3 },
  { name: FEISHU_PROCESS_STATUS.gatedSkipped, color: 0 },
] as const;

/**
 * 将 Supabase 英文 status 映射为 Base 中文显示值
 * gatedSkipped 不写入 Base，返回 null
 */
export function mapStatusToChinese(status: string | null): string | null {
  if (!status) return null;
  const map: Record<string, string> = {
    meeting_ended: FEISHU_PROCESS_STATUS.minuteGenerated,
    fetching_transcript: FEISHU_PROCESS_STATUS.fetchingTranscript,
    analyzing: FEISHU_PROCESS_STATUS.analyzing,
    completed: FEISHU_PROCESS_STATUS.completed,
    failed: FEISHU_PROCESS_STATUS.failed,
    gated_skipped: FEISHU_PROCESS_STATUS.gatedSkipped,
  };
  return map[status] ?? null;
}
