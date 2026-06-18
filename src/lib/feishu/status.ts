/**
 * 飞书会议处理状态机
 *
 * 状态含义：
 * - 会议结束：已收到参与会议结束事件，并完成会议基础信息建档
 * - 获取录制文件中：正在根据 meeting_id 获取会议录制文件
 * - 获取文字稿中：已获得 minute_token，正在导出妙记文字稿
 * - 分析中：已拿到转录稿，正在执行 Teaming 分析
 * - 已完成：分析结果和报告数据已写回多维表格
 * - 失败：在轮询窗口内仍未拿到录制文件/文字稿，或后续处理失败
 */
export const FEISHU_PROCESS_STATUS = {
  meetingEnded: '会议结束',
  fetchingRecording: '获取录制文件中',
  fetchingTranscript: '获取文字稿中',
  analyzing: '分析中',
  completed: '已完成',
  failed: '失败',
} as const;

export type FeishuProcessStatus =
  typeof FEISHU_PROCESS_STATUS[keyof typeof FEISHU_PROCESS_STATUS];

export const FEISHU_ACTIVE_PROCESS_STATUSES: FeishuProcessStatus[] = [
  FEISHU_PROCESS_STATUS.meetingEnded,
  FEISHU_PROCESS_STATUS.fetchingRecording,
  FEISHU_PROCESS_STATUS.fetchingTranscript,
  FEISHU_PROCESS_STATUS.analyzing,
];

export const FEISHU_STATUS_OPTIONS = [
  { name: FEISHU_PROCESS_STATUS.meetingEnded, color: 0 },
  { name: FEISHU_PROCESS_STATUS.fetchingRecording, color: 1 },
  { name: FEISHU_PROCESS_STATUS.fetchingTranscript, color: 1 },
  { name: FEISHU_PROCESS_STATUS.analyzing, color: 1 },
  { name: FEISHU_PROCESS_STATUS.completed, color: 2 },
  { name: FEISHU_PROCESS_STATUS.failed, color: 3 },
] as const;
