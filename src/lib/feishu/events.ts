/**
 * 飞书事件监听服务
 * 使用长连接模式监听事件
 *
 * @deprecated 当前正式链路已切换为 `Webhook + OpenAPI`。
 * 本文件仅保留作历史参考与迁移过渡，不再作为生产入口，也不建议继续扩展。
 * 旧方案的核心限制是：CLI 长连接不支持 `vc.bot.meeting_ended_v1`，
 * 无法覆盖“被邀请但未实际参会”的会议结束场景。
 */

import { spawn, ChildProcess } from 'child_process';
import type {
  FeishuEvent,
  MeetingEndedEventData,
  NoteGeneratedEventData,
  EventServiceStatus,
  ConsumerStatus,
  EventProcessResult,
} from './types';
import {
  getUserConfig,
  getDefaultUserConfig,
  addMeetingRecord,
  updateMeetingRecord,
  getMeetingByMeetingId,
  getDocumentContent,
} from './bitable';
import {
  setStatusAnalyzingDynamic,
  setStatusCompletedDynamic,
  setStatusFailedDynamic,
  setStatusFetchingTranscriptDynamic,
  type DynamicBitableConfig,
} from '@/services/feishuClient';
import { analyzeMeetingText } from '@/services/analysisService';
import { formatResult } from '@/formatters';
import { FEISHU_PROCESS_STATUS } from './status';

// 项目域名（用于生成报告链接）
const getProjectDomain = () => process.env.PROJECT_PUBLIC_URL || 'http://localhost:5000';

/**
 * 事件类型常量
 */
const EVENT_TYPES = {
  BOT_MEETING_ENDED: 'vc.bot.meeting_ended_v1',           // 会议结束（所有会议）
  MEETING_ENDED: 'vc.meeting.participant_meeting_ended_v1', // 用户参与的会议结束
  NOTE_GENERATED: 'vc.note.generated_v1',                  // 纪要生成
} as const;

/**
 * 飞书事件监听服务
 * 单例模式，全局只有一个实例
 */
class FeishuEventService {
  private static instance: FeishuEventService | null = null;
  
  private consumers: Map<string, Consumer> = new Map();
  private isRunning = false;
  private startedAt: number | null = null;
  private reconnectCount = 0;
  private lastEventTime: number | null = null;
  private lastError: string | null = null;
  
  private constructor() {}
  
  /**
   * 获取单例实例
   */
  static getInstance(): FeishuEventService {
    if (!FeishuEventService.instance) {
      FeishuEventService.instance = new FeishuEventService();
    }
    return FeishuEventService.instance;
  }
  
  /**
   * 启动事件监听服务
   */
  async start(): Promise<{ success: boolean; message: string }> {
    if (this.isRunning) {
      return { success: false, message: '事件监听服务已在运行中' };
    }
    
    try {
      // 注意：飞书 CLI 长连接模式不支持应用身份事件（如 vc.bot.meeting_ended_v1）
      // 只能监听用户身份事件：
      // - vc.meeting.participant_meeting_ended_v1（用户参与的会议结束）
      // - vc.note.generated_v1（纪要生成）
      // 如需监听所有会议（包括用户被邀请但未参加的），需要使用 Webhook 模式
      
      // 启动用户参与的会议结束事件监听
      const meetingConsumer = new Consumer(
        EVENT_TYPES.MEETING_ENDED,
        this.handleMeetingEnded.bind(this) as (event: FeishuEvent<unknown>) => Promise<EventProcessResult>
      );
      await meetingConsumer.start();
      this.consumers.set(EVENT_TYPES.MEETING_ENDED, meetingConsumer);
      
      // 启动纪要生成事件监听
      const noteConsumer = new Consumer(
        EVENT_TYPES.NOTE_GENERATED,
        this.handleNoteGenerated.bind(this) as (event: FeishuEvent<unknown>) => Promise<EventProcessResult>
      );
      await noteConsumer.start();
      this.consumers.set(EVENT_TYPES.NOTE_GENERATED, noteConsumer);
      
      this.isRunning = true;
      this.startedAt = Date.now();
      
      console.log('[EventService] 事件监听服务已启动');
      return { success: true, message: '事件监听服务启动成功' };
    } catch (error) {
      this.lastError = String(error);
      return { success: false, message: `启动失败: ${error}` };
    }
  }
  
  /**
   * 停止事件监听服务
   */
  async stop(): Promise<{ success: boolean; message: string }> {
    if (!this.isRunning) {
      return { success: false, message: '事件监听服务未运行' };
    }
    
    try {
      for (const consumer of this.consumers.values()) {
        consumer.stop();
      }
      this.consumers.clear();
      
      this.isRunning = false;
      this.startedAt = null;
      
      console.log('[EventService] 事件监听服务已停止');
      return { success: true, message: '事件监听服务已停止' };
    } catch (error) {
      return { success: false, message: `停止失败: ${error}` };
    }
  }
  
  /**
   * 获取服务状态
   */
  getStatus(): EventServiceStatus {
    const consumerStatuses: ConsumerStatus[] = [];
    
    for (const [eventType, consumer] of this.consumers) {
      consumerStatuses.push({
        eventType,
        isRunning: consumer.isRunning(),
        pid: consumer.getPid(),
        processedCount: consumer.getProcessedCount(),
        lastEventTime: consumer.getLastEventTime(),
      });
    }
    
    return {
      isRunning: this.isRunning,
      startedAt: this.startedAt || undefined,
      reconnectCount: this.reconnectCount,
      lastEventTime: this.lastEventTime || undefined,
      lastError: this.lastError || undefined,
      consumers: consumerStatuses,
    };
  }
  
  /**
   * 处理会议结束事件
   */
  private async handleMeetingEnded(event: FeishuEvent<MeetingEndedEventData>): Promise<EventProcessResult> {
    console.log('[EventService] 收到会议结束事件:', event.event_id);
    console.log('[EventService] 事件完整数据:', JSON.stringify(event).substring(0, 1000));
    this.lastEventTime = Date.now();
    
    try {
      // 兼容两种事件格式：
      // 格式1（标准格式）: { user_identity: { open_id: "xxx" }, event: { meeting: {...} } }
      // 格式2（CLI扁平格式）: { type: "xxx", meeting_id: "xxx", topic: "xxx", ... }
      let userOpenId = event.user_identity?.open_id;
      let meeting: { id: string; topic?: string; start_time: string; end_time: string };
      
      // 检查是否是扁平格式（CLI 输出）
      const flatEvent = event as unknown as Record<string, unknown>;
      if (flatEvent.meeting_id && !event.event?.meeting) {
        // 扁平格式
        meeting = {
          id: String(flatEvent.meeting_id),
          topic: String(flatEvent.topic || '未命名会议'),
          start_time: String(flatEvent.start_time),
          end_time: String(flatEvent.end_time),
        };
        // 扁平格式中用户身份可能在 participant 字段
        const participant = flatEvent.participant as Record<string, unknown> | undefined;
        userOpenId = userOpenId || (participant?.open_id as string);
        console.log('[EventService] 检测到扁平格式事件, meeting_id:', meeting.id);
      } else if (event.event?.meeting) {
        // 标准格式
        meeting = event.event.meeting;
      } else {
        return { success: false, message: '事件中缺少会议信息' };
      }
      
      let userConfig;
      
      if (!userOpenId) {
        console.log('[EventService] 事件中缺少用户身份信息，尝试使用默认用户配置');
        // 直接使用默认用户配置（单租户模式）
        userConfig = await getDefaultUserConfig();
        if (!userConfig) {
          return { success: false, message: '事件中缺少用户身份信息，且未找到默认用户配置' };
        }
        console.log('[EventService] 使用默认用户配置:', userConfig.userId);
      } else {
        // 获取用户配置
        userConfig = await getUserConfig(userOpenId);
        if (!userConfig) {
          return { success: false, message: `未找到用户配置: ${userOpenId}` };
        }
      }
      
      // 检查是否已存在该会议记录
      const existingRecord = await getMeetingByMeetingId(
        userConfig.bitableAppToken,
        userConfig.meetingTableId,
        meeting.id
      );
      
      if (existingRecord) {
        // 更新现有记录
        await updateMeetingRecord(
          userConfig.bitableAppToken,
          userConfig.meetingTableId,
          existingRecord.recordId!,
          { status: FEISHU_PROCESS_STATUS.waitingNote }
        );
        return { success: true, message: '会议记录已更新', recordId: existingRecord.recordId };
      }
      
      // 添加新的会议记录
      const result = await addMeetingRecord(
        userConfig.bitableAppToken,
        userConfig.meetingTableId,
        {
          meetingId: meeting.id,
          topic: meeting.topic || '未命名会议',
          startTime: new Date(meeting.start_time).getTime(),
          endTime: new Date(meeting.end_time).getTime(),
          status: FEISHU_PROCESS_STATUS.waitingNote,
          userOpenId,
        }
      );
      
      if (result.success) {
        console.log('[EventService] 会议记录已添加:', result.recordId);
        return { success: true, message: '会议记录已添加', recordId: result.recordId };
      } else {
        return { success: false, message: `添加会议记录失败: ${result.error}` };
      }
    } catch (error) {
      this.lastError = String(error);
      return { success: false, message: `处理事件失败: ${error}` };
    }
  }
  
  /**
   * 处理纪要生成事件
   */
  private async handleNoteGenerated(event: FeishuEvent<NoteGeneratedEventData>): Promise<EventProcessResult> {
    console.log('[EventService] 收到纪要生成事件:', event.event_id);
    this.lastEventTime = Date.now();
    
    try {
      const userOpenId = event.user_identity?.open_id;
      if (!userOpenId) {
        return { success: false, message: '事件中缺少用户身份信息' };
      }
      
      const eventData = event.event;
      if (!eventData?.note || !eventData?.note_source) {
        return { success: false, message: '事件中缺少纪要信息' };
      }
      
      const { note, note_source } = eventData;
      const meetingId = note_source.source_entity_id;
      
      // 获取用户配置
      const userConfig = await getUserConfig(userOpenId);
      if (!userConfig) {
        return { success: false, message: `未找到用户配置: ${userOpenId}` };
      }
      
      // 构建动态配置（复用 feishuClient 的写入链路）
      const bitableConfig: DynamicBitableConfig = {
        appToken: userConfig.bitableAppToken,
        tableId: userConfig.meetingTableId,
      };
      
      // 查找对应的会议记录
      const meetingRecord = await getMeetingByMeetingId(
        userConfig.bitableAppToken,
        userConfig.meetingTableId,
        meetingId
      );
      
      if (!meetingRecord) {
        return { success: false, message: `未找到会议记录: ${meetingId}` };
      }
      
      // 更新状态为获取文字稿中（使用 feishuClient）
      await setStatusFetchingTranscriptDynamic(bitableConfig, meetingRecord.recordId!);
      
      // 获取转录稿内容
      const verbatimToken = note.verbatim_token;
      if (!verbatimToken) {
        await setStatusFailedDynamic(bitableConfig, meetingRecord.recordId!, '纪要中没有转录稿 token');
        return { success: false, message: '纪要中没有转录稿 token' };
      }
      
      const verbatimContent = await getDocumentContent(verbatimToken);
      if (!verbatimContent) {
        await setStatusFailedDynamic(bitableConfig, meetingRecord.recordId!, '获取转录稿内容失败');
        return { success: false, message: '获取转录稿内容失败' };
      }
      
      console.log('[EventService] 转录稿获取成功，长度:', verbatimContent.length);
      
      // 第三阶段：调用 LLM 分析
      console.log('[EventService] 开始 LLM 分析...');
      await setStatusAnalyzingDynamic(bitableConfig, meetingRecord.recordId!);
      const analysisResult = await analyzeMeetingText(verbatimContent);
      
      // 生成分析摘要（Markdown 格式）
      const analysisSummary = await formatResult(analysisResult, 'feishu') as string;
      
      // 生成报告链接
      const reportLink = `${getProjectDomain()}/report?recordId=${meetingRecord.recordId}`;
      
      // 完整 JSON 数据
      const analysisJson = JSON.stringify(analysisResult);
      
      // 写入多维表格（使用 feishuClient 的写入链路）
      await setStatusCompletedDynamic(
        bitableConfig,
        meetingRecord.recordId!,
        analysisSummary,
        reportLink,
        analysisJson,
        verbatimContent
      );
      
      console.log('[EventService] 分析完成，结果已写入:', meetingRecord.recordId);
      return { success: true, message: '分析完成', recordId: meetingRecord.recordId };
    } catch (error) {
      this.lastError = String(error);
      return { success: false, message: `处理事件失败: ${error}` };
    }
  }
}

/**
 * 事件消费者
 * 监听单个事件类型
 */
class Consumer {
  private eventType: string;
  private handler: (event: FeishuEvent) => Promise<EventProcessResult>;
  private process: ChildProcess | null = null;
  private running = false;
  private processedCount = 0;
  private lastEventTime: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60000; // 最大等待 60 秒
  
  constructor(
    eventType: string,
    handler: (event: FeishuEvent) => Promise<EventProcessResult>
  ) {
    this.eventType = eventType;
    this.handler = handler;
  }
  
  /**
   * 启动消费者
   */
  async start(): Promise<void> {
    this.running = true;
    this.connect();
  }
  
  /**
   * 停止消费者
   */
  stop(): void {
    this.running = false;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
  
  /**
   * 是否运行中
   */
  isRunning(): boolean {
    return this.running && this.process !== null;
  }
  
  /**
   * 获取进程 PID
   */
  getPid(): number | undefined {
    return this.process?.pid;
  }
  
  /**
   * 获取已处理事件数
   */
  getProcessedCount(): number {
    return this.processedCount;
  }
  
  /**
   * 获取最近事件时间
   */
  getLastEventTime(): number | undefined {
    return this.lastEventTime || undefined;
  }
  
  /**
   * 建立连接
   */
  private connect(): void {
    console.log(`[Consumer] 启动监听: ${this.eventType}`);
    
    // 使用 shell 模式启动，通过 tail -f /dev/null 保持 stdin 打开
    // 这是飞书 CLI 推荐的方式，避免 stdin EOF 导致进程退出
    const command = `tail -f /dev/null | npx @larksuite/cli event consume ${this.eventType} --as user`;
    
    this.process = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    // 处理标准输出（事件数据）
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleData(data);
    });
    
    // 处理错误输出
    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[Consumer] 错误: ${data.toString()}`);
    });
    
    // 处理进程退出
    this.process.on('exit', (code, signal) => {
      console.log(`[Consumer] 进程退出: code=${code}, signal=${signal}`);
      this.process = null;
      
      // 如果不是主动停止，则自动重连
      if (this.running && code !== 0) {
        this.reconnect();
      }
    });
    
    // 重置重连计数
    this.reconnectAttempts = 0;
  }
  
  /**
   * 处理事件数据
   */
  private handleData(data: Buffer): void {
    try {
      const lines = data.toString().split('\n').filter(Boolean);
      
      for (const line of lines) {
        // 跳过非 JSON 行（如 [event] ready 等状态消息）
        if (!line.startsWith('{')) {
          continue;
        }
        
        let event: FeishuEvent;
        try {
          event = JSON.parse(line) as FeishuEvent;
        } catch (parseError) {
          console.error(`[Consumer] JSON 解析失败:`, line.substring(0, 200));
          continue;
        }
        
        this.processedCount++;
        this.lastEventTime = Date.now();
        console.log(`[Consumer] 解析事件成功:`, JSON.stringify(event).substring(0, 500));
        
        // 异步处理事件
        this.handler(event).then(result => {
          console.log(`[Consumer] 事件处理结果:`, result);
        }).catch(error => {
          console.error(`[Consumer] 处理事件失败:`, error);
        });
      }
    } catch (error) {
      console.error(`[Consumer] 处理数据失败:`, error);
    }
  }
  
  /**
   * 重连
   */
  private reconnect(): void {
    this.reconnectAttempts++;
    
    // 指数退避
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );
    
    console.log(`[Consumer] ${this.reconnectAttempts}秒后重连...`);
    
    setTimeout(() => {
      if (this.running) {
        this.connect();
      }
    }, delay);
  }
}

/**
 * @deprecated 请使用 `/api/feishu/webhook` + `webhookProcessor.ts`。
 */
export const getEventService = () => FeishuEventService.getInstance();
