/**
 * 飞书多维表格 API 客户端
 * 用于更新多维表格记录（飞书 CLI 链路）
 * 
 * 使用飞书 CLI 方式更新记录，不需要 appId/appSecret
 */

import { execSync } from 'child_process';
import { FEISHU_PROCESS_STATUS, type FeishuProcessStatus } from '@/lib/feishu/status';

// 动态配置类型
export interface DynamicBitableConfig {
  appToken: string;
  tableId: string;
}

// 默认字段名（与新创建的多维表格字段名一致）
const DEFAULT_FIELD_NAMES = {
  analysisReport: '分析摘要',
  reportLink: '报告链接',
  processStatus: '处理状态',
  analysisData: 'JSON数据',
  verbatimContent: '会议文字稿',
};

/**
 * 执行飞书 CLI API 调用
 */
function callApi(
  method: string,
  path: string,
  data: Record<string, unknown>
): { code: number; msg: string; data?: unknown } {
  const jsonStr = JSON.stringify(data);
  const escapedJson = jsonStr.replace(/'/g, "'\\''");
  
  const cmd = `npx @larksuite/cli api ${method} '${path}' --as user --format json --data '${escapedJson}'`;
  
  const result = execSync(cmd, {
    encoding: 'utf-8',
    timeout: 30000,
  });
  
  return JSON.parse(result);
}

/**
 * 更新飞书多维表格记录
 */
export async function updateFeishuRecordDynamic(
  config: DynamicBitableConfig,
  recordId: string,
  fields: {
    analysisReport?: string;
    reportLink?: string;
    processStatus?: FeishuProcessStatus;
    analysisData?: string;
    verbatimContent?: string;
  }
): Promise<void> {
  const path = `/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/${recordId}`;
  
  // 构建字段数据
  const fieldsData: Record<string, string> = {};
  
  if (fields.analysisReport !== undefined) {
    fieldsData[DEFAULT_FIELD_NAMES.analysisReport] = fields.analysisReport;
  }
  
  if (fields.reportLink !== undefined) {
    fieldsData[DEFAULT_FIELD_NAMES.reportLink] = fields.reportLink;
  }
  
  if (fields.processStatus !== undefined) {
    fieldsData[DEFAULT_FIELD_NAMES.processStatus] = fields.processStatus;
  }
  
  if (fields.analysisData !== undefined) {
    fieldsData[DEFAULT_FIELD_NAMES.analysisData] = fields.analysisData;
  }
  
  if (fields.verbatimContent !== undefined) {
    fieldsData[DEFAULT_FIELD_NAMES.verbatimContent] = fields.verbatimContent;
  }
  
  const result = callApi('PUT', path, { fields: fieldsData });
  
  if (result.code !== 0) {
    throw new Error(`更新飞书记录失败: ${result.msg}`);
  }
}

/**
 * 更新处理状态为指定状态
 */
export async function setProcessStatusDynamic(
  config: DynamicBitableConfig,
  recordId: string,
  status: FeishuProcessStatus
): Promise<void> {
  await updateFeishuRecordDynamic(config, recordId, {
    processStatus: status,
  });
}

/**
 * 更新处理状态为"获取文字稿中"
 */
export async function setStatusFetchingTranscriptDynamic(
  config: DynamicBitableConfig,
  recordId: string
): Promise<void> {
  await setProcessStatusDynamic(config, recordId, FEISHU_PROCESS_STATUS.fetchingTranscript);
}

/**
 * 更新处理状态为"分析中"
 */
export async function setStatusAnalyzingDynamic(
  config: DynamicBitableConfig,
  recordId: string
): Promise<void> {
  await setProcessStatusDynamic(config, recordId, FEISHU_PROCESS_STATUS.analyzing);
}

/**
 * 更新处理状态为"已完成"并写入分析结果
 */
export async function setStatusCompletedDynamic(
  config: DynamicBitableConfig,
  recordId: string,
  analysisReport: string,
  reportLink: string,
  analysisData: string,
  verbatimContent?: string
): Promise<void> {
  await updateFeishuRecordDynamic(config, recordId, {
    processStatus: FEISHU_PROCESS_STATUS.completed,
    analysisReport,
    reportLink,
    analysisData,
    verbatimContent,
  });
}

/**
 * 更新处理状态为"失败"
 */
export async function setStatusFailedDynamic(
  config: DynamicBitableConfig,
  recordId: string,
  errorMessage?: string
): Promise<void> {
  await updateFeishuRecordDynamic(config, recordId, {
    processStatus: FEISHU_PROCESS_STATUS.failed,
    analysisReport: errorMessage || '分析失败',
  });
}
