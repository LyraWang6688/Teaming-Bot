/**
 * 飞书多维表格读写操作
 */

import { execSync } from 'child_process';
import type { UserConfig, MeetingRecord } from './types';

// 全局用户注册表配置
const GLOBAL_REGISTRY_APP_TOKEN = 'DbKAbUdIsa7XyNs4jU2cewfrntf';
const GLOBAL_REGISTRY_TABLE_ID = 'tblsTtUH7FjIMk33';

// API 响应类型
interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

// 记录搜索结果
interface RecordSearchResult {
  items: Array<{
    record_id: string;
    fields: Record<string, unknown>;
  }>;
  has_more: boolean;
  page_token?: string;
}

// 文档内容结果
interface DocContentResult {
  content: string;
}

// 记录创建结果
interface RecordCreateResult {
  record: {
    record_id: string;
    fields: Record<string, unknown>;
  };
}

/**
 * 执行飞书 CLI API 调用
 * @param method HTTP 方法
 * @param path API 路径
 * @param data 请求数据
 * @param asApp 是否使用应用身份（默认 false，使用用户身份）
 */
function callApi<T = unknown>(
  method: string,
  path: string,
  data?: Record<string, unknown>,
  asApp: boolean = false
): ApiResponse<T> {
  // 全局注册表操作使用应用身份，其他操作使用用户身份
  const identity = asApp ? 'app' : 'user';
  
  // 构建 JSON 字符串
  const jsonStr = JSON.stringify(data || {});
  // 处理单引号：将单引号替换为 '\''（结束单引号，添加转义单引号，重新开始单引号）
  const escapedJson = jsonStr.replace(/'/g, "'\\''");
  
  const cmd = `npx @larksuite/cli api ${method} '${path}' --as ${identity} --format json --data '${escapedJson}'`;
  
  const result = execSync(cmd, {
    encoding: 'utf-8',
    timeout: 30000,
  });
  
  return JSON.parse(result);
}

/**
 * 全局用户注册表配置
 * 所有用户的配置都存储在这个固定的多维表格中
 * 由应用身份创建，应用拥有完全权限
 */
export const GLOBAL_USER_REGISTRY = {
  // 应用创建的全局多维表格（应用拥有完全权限）
  appToken: 'DbKAbUdIsa7XyNs4jU2cewfrntf',
  userConfigTableId: 'tblsTtUH7FjIMk33',
  // 别名，方便使用
  tableId: 'tblsTtUH7FjIMk33',
};

/**
 * 根据用户 Open ID 获取用户配置
 * 使用应用身份查询全局注册表
 */
export async function getUserConfig(userOpenId: string): Promise<UserConfig | null> {
  try {
    // 从全局配置表中查询用户配置（使用应用身份）
    const appToken = GLOBAL_USER_REGISTRY.appToken;
    const tableId = GLOBAL_USER_REGISTRY.userConfigTableId;
    
    const result = callApi<RecordSearchResult>('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`, {
      filter: {
        conditions: [{
          field_name: '用户ID',
          operator: 'is',
          value: [userOpenId]
        }]
      },
      page_size: 1
    }, true); // 使用应用身份
    
    if (result.code !== 0 || !result.data?.items?.length) {
      return null;
    }
    
    const fields = result.data.items[0].fields;
    return {
      userId: fields['用户ID'] as string,
      userName: fields['用户姓名'] as string,
      accessToken: fields['access_token'] as string,
      refreshToken: fields['refresh_token'] as string,
      expiresAt: fields['token过期时间'] as number,
      bitableAppToken: fields['多维表格app_token'] as string,
      meetingTableId: fields['数据表table_id'] as string,
      authStatus: fields['授权状态'] as '有效' | '已过期',
      createdAt: fields['创建时间'] as number,
    };
  } catch (error) {
    console.error('获取用户配置失败:', error);
    return null;
  }
}

/**
 * 根据会议 ID 查询会议记录
 */
export async function getMeetingByMeetingId(
  appToken: string,
  tableId: string,
  meetingId: string
): Promise<MeetingRecord | null> {
  try {
    const result = callApi<RecordSearchResult>('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`, {
      filter: {
        conditions: [{
          field_name: '会议ID',
          operator: 'is',
          value: [meetingId]
        }]
      },
      page_size: 1
    });
    
    if (result.code !== 0 || !result.data?.items?.length) {
      return null;
    }
    
    const item = result.data.items[0];
    const fields = item.fields;
    
    return {
      recordId: item.record_id,
      meetingId: fields['会议ID'] as string,
      topic: fields['会议主题'] as string,
      startTime: fields['开始时间'] as number,
      endTime: fields['结束时间'] as number,
      organizer: fields['组织者'] as string,
      status: fields['处理状态'] as MeetingRecord['status'],
      retryCount: fields['重试次数'] as number,
      verbatimContent: fields['会议文字稿'] as string,
      analysisSummary: fields['分析摘要'] as string,
      reportUrl: fields['报告链接'] as string,
      analysisJson: fields['JSON数据'] as string,
      errorMessage: fields['错误信息'] as string,
    };
  } catch (error) {
    console.error('查询会议记录失败:', error);
    return null;
  }
}

/**
 * 添加会议记录
 */
export async function addMeetingRecord(
  appToken: string,
  tableId: string,
  meeting: MeetingRecord
): Promise<{ success: boolean; recordId?: string; error?: string }> {
  try {
    const fields: Record<string, unknown> = {
      '会议ID': meeting.meetingId,
      '会议主题': meeting.topic,
      '开始时间': meeting.startTime,
      '结束时间': meeting.endTime,
      '处理状态': meeting.status,
    };
    
    if (meeting.organizer) {
      fields['组织者'] = meeting.organizer;
    }
    if (meeting.userOpenId) {
      fields['用户ID'] = meeting.userOpenId;
    }
    
    const result = callApi<RecordCreateResult>('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
      fields
    });
    
    if (result.code !== 0) {
      return { success: false, error: result.msg };
    }
    
    return { success: true, recordId: result.data?.record?.record_id };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * 更新会议记录
 */
export async function updateMeetingRecord(
  appToken: string,
  tableId: string,
  recordId: string,
  updates: Partial<MeetingRecord>
): Promise<{ success: boolean; error?: string }> {
  try {
    const fields: Record<string, unknown> = {};
    
    if (updates.status !== undefined) {
      fields['处理状态'] = updates.status;
    }
    if (updates.verbatimContent !== undefined) {
      fields['会议文字稿'] = updates.verbatimContent;
    }
    if (updates.analysisSummary !== undefined) {
      fields['分析摘要'] = updates.analysisSummary;
    }
    if (updates.reportUrl !== undefined) {
      fields['报告链接'] = updates.reportUrl;
    }
    if (updates.analysisJson !== undefined) {
      fields['JSON数据'] = updates.analysisJson;
    }
    if (updates.retryCount !== undefined) {
      fields['重试次数'] = updates.retryCount;
    }
    if (updates.errorMessage !== undefined) {
      fields['错误信息'] = updates.errorMessage;
    }
    
    const result = callApi<RecordCreateResult>('PUT', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
      fields
    });
    
    if (result.code !== 0) {
      return { success: false, error: result.msg };
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * 获取文档内容
 */
export async function getDocumentContent(docToken: string): Promise<string | null> {
  try {
    const result = callApi<DocContentResult>('GET', `/open-apis/docs/v1/documents/${docToken}/content`);
    
    if (result.code !== 0) {
      console.error('获取文档内容失败:', result.msg);
      return null;
    }
    
    // 解析文档内容，提取纯文本
    const content = result.data?.content;
    if (typeof content === 'string') {
      return content;
    }
    
    // 如果是结构化内容，提取文本
    if (Array.isArray(content)) {
      return extractTextFromBlocks(content);
    }
    
    return null;
  } catch (error) {
    console.error('获取文档内容失败:', error);
    return null;
  }
}

/**
 * 从文档块中提取纯文本
 */
function extractTextFromBlocks(blocks: unknown[]): string {
  let text = '';
  
  for (const block of blocks) {
    if (typeof block === 'string') {
      text += block + '\n';
    } else if (block && typeof block === 'object') {
      const blockObj = block as Record<string, unknown>;
      if (blockObj.text) {
        text += blockObj.text + '\n';
      }
      if (Array.isArray(blockObj.children)) {
        text += extractTextFromBlocks(blockObj.children);
      }
    }
  }
  
  return text.trim();
}

/**
 * 获取默认用户配置（单租户模式）
 * 用于事件中没有用户身份信息时，使用固定的默认配置
 * 注意：这是单租户模式的简化实现，后续扩展为多租户时需要改用全局注册表
 */
export async function getDefaultUserConfig(): Promise<UserConfig | null> {
  // 单租户模式：直接返回固定配置
  // 王颖的配置（最新初始化的多维表格）
  return {
    userId: 'ou_28fc551442788185750ac30f199cd089',
    userName: '王颖',
    accessToken: '[已授权]',  // 实际 token 由飞书 CLI 管理
    refreshToken: '[已授权]',
    expiresAt: Date.now() + 3600000,  // 1小时后过期（占位）
    bitableAppToken: 'ESQkbIG93a42oUs9loXcYxdcn3c',  // 王颖最新创建的多维表格
    meetingTableId: 'tblKw6sEbnFniFaH',  // 会议信息表
    authStatus: '有效',
    createdAt: Date.now(),
  };
}
