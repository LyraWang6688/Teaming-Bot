/**
 * 飞书集成相关类型定义
 */

import type { FeishuProcessStatus } from './status';

// ==================== 用户配置相关 ====================

/**
 * 用户授权配置（存储在多维表格中）
 */
export interface UserConfig {
  /** 用户 Open ID */
  userId: string;
  /** 用户姓名 */
  userName: string;
  /** 访问令牌 */
  accessToken: string;
  /** 刷新令牌 */
  refreshToken: string;
  /** Token 过期时间（时间戳，毫秒） */
  expiresAt: number;
  /** 多维表格 app_token */
  bitableAppToken: string;
  /** 会议信息数据表 table_id */
  meetingTableId: string;
  /** 授权状态 */
  authStatus: '有效' | '已过期';
  /** 创建时间（时间戳，毫秒） */
  createdAt: number;
}

// ==================== 会议相关 ====================

/**
 * 会议信息（存储在多维表格中）
 */
export interface MeetingRecord {
  /** 记录 ID（多维表格自动生成） */
  recordId?: string;
  /** 会议 ID */
  meetingId: string;
  /** 会议主题 */
  topic: string;
  /** 开始时间（时间戳，毫秒） */
  startTime: number;
  /** 结束时间（时间戳，毫秒） */
  endTime: number;
  /** 组织者 */
  organizer?: string;
  /** 处理状态 */
  status: FeishuProcessStatus;
  /** 重试次数 */
  retryCount?: number;
  /** 会议文字稿 */
  verbatimContent?: string;
  /** 分析摘要 */
  analysisSummary?: string;
  /** 报告链接 */
  reportUrl?: string;
  /** 分析 JSON 数据 */
  analysisJson?: string;
  /** 错误信息 */
  errorMessage?: string;
  /** 用户 Open ID */
  userOpenId?: string;
}

// ==================== 事件相关 ====================

/**
 * 飞书事件基础结构
 */
export interface FeishuEvent<T = unknown> {
  /** 事件 ID */
  event_id: string;
  /** 事件类型 */
  event_type: string;
  /** 事件时间戳 */
  event_time: string;
  /** 事件主体（租户信息） */
  tenant_key: string;
  /** 用户身份信息 */
  user_identity?: UserIdentity;
  /** 事件数据 */
  event?: T;
}

/**
 * 用户身份信息
 */
export interface UserIdentity {
  /** Open ID */
  open_id: string;
  /** Union ID */
  union_id: string;
  /** 用户 ID */
  user_id: string;
}

/**
 * 会议结束事件数据
 * vc.meeting.participant_meeting_ended_v1
 */
export interface MeetingEndedEventData {
  /** 会议信息 */
  meeting: {
    /** 会议 ID */
    id: string;
    /** 会议主题 */
    topic: string;
    /** 开始时间（ISO 8601 格式） */
    start_time: string;
    /** 结束时间（ISO 8601 格式） */
    end_time: string;
    /** 会议时长（秒） */
    duration: number;
  };
}

/**
 * 纪要生成事件数据
 * vc.note.generated_v1
 */
export interface NoteGeneratedEventData {
  /** 纪要信息 */
  note: {
    /** 纪要文档 token */
    note_token: string;
    /** 转录稿文档 token */
    verbatim_token: string;
    /** 纪要标题 */
    title: string;
  };
  /** 来源信息 */
  note_source: {
    /** 来源类型 */
    source_type: string;
    /** 来源实体 ID（会议 ID） */
    source_entity_id: string;
  };
}

// ==================== 事件处理结果 ====================

/**
 * 事件处理结果
 */
export interface EventProcessResult {
  /** 是否成功 */
  success: boolean;
  /** 消息 */
  message: string;
  /** 相关记录 ID */
  recordId?: string;
  /** 错误信息 */
  error?: string;
}

// ==================== 监听服务状态 ====================

/**
 * 事件监听服务状态
 */
export interface EventServiceStatus {
  /** 是否运行中 */
  isRunning: boolean;
  /** 启动时间 */
  startedAt?: number;
  /** 重连次数 */
  reconnectCount: number;
  /** 最近一次事件时间 */
  lastEventTime?: number;
  /** 最近一次错误 */
  lastError?: string;
  /** 监听的消费者列表 */
  consumers: ConsumerStatus[];
}

/**
 * 消费者状态
 */
export interface ConsumerStatus {
  /** 事件类型 */
  eventType: string;
  /** 是否运行中 */
  isRunning: boolean;
  /** 进程 PID */
  pid?: number;
  /** 已处理事件数 */
  processedCount: number;
  /** 最近一次事件时间 */
  lastEventTime?: number;
}
