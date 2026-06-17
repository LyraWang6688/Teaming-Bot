/**
 * 飞书会议处理状态机
 *
 * 状态含义：
 * - 等待纪要：已收到会议结束信号，等待飞书生成转录稿
 * - 获取文字稿中：已收到纪要/转录稿信号，正在拉取逐字文字记录
 * - 分析中：已拿到转录稿，正在执行 Teaming 分析
 * - 已完成：分析结果和报告数据已写回多维表格
 * - 失败：处理失败；不使用智能纪要正文作为转录稿 fallback
 */
export const FEISHU_PROCESS_STATUS = {
  waitingNote: '等待纪要',
  fetchingTranscript: '获取文字稿中',
  analyzing: '分析中',
  completed: '已完成',
  failed: '失败',
} as const;

export type FeishuProcessStatus =
  typeof FEISHU_PROCESS_STATUS[keyof typeof FEISHU_PROCESS_STATUS];

export const FEISHU_ACTIVE_PROCESS_STATUSES: FeishuProcessStatus[] = [
  FEISHU_PROCESS_STATUS.waitingNote,
  FEISHU_PROCESS_STATUS.fetchingTranscript,
  FEISHU_PROCESS_STATUS.analyzing,
];

export const FEISHU_STATUS_OPTIONS = [
  { name: FEISHU_PROCESS_STATUS.waitingNote, color: 0 },
  { name: FEISHU_PROCESS_STATUS.fetchingTranscript, color: 1 },
  { name: FEISHU_PROCESS_STATUS.analyzing, color: 1 },
  { name: FEISHU_PROCESS_STATUS.completed, color: 2 },
  { name: FEISHU_PROCESS_STATUS.failed, color: 3 },
] as const;

