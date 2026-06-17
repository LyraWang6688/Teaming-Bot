/**
 * 飞书多维表格创建 API
 * 创建多维表格和两个数据表
 */

import { NextRequest, NextResponse } from 'next/server';
import { 
  callLarkApi,
  getAuthStatus,
  addRecord 
} from '@/lib/feishu/client';
import { GLOBAL_USER_REGISTRY } from '@/lib/feishu/bitable';
import { FEISHU_STATUS_OPTIONS } from '@/lib/feishu/status';

// 字段类型常量（飞书多维表格 API）
// 参考：https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/create
const FIELD_TYPE = {
  TEXT: 1,           // 文本
  NUMBER: 2,         // 数字
  SINGLE_SELECT: 3,  // 单选
  MULTI_SELECT: 4,   // 多选
  DATE: 5,           // 日期
  CHECKBOX: 7,       // 复选框
  // 注意：飞书多维表格没有独立的"多行文本"类型，使用 TEXT 即可
  // type 15 是 URL 类型，不是多行文本！
};

// 会议信息表字段定义
const MEETING_TABLE_FIELDS = [
  { field_name: '会议ID', type: FIELD_TYPE.TEXT },
  { field_name: '会议主题', type: FIELD_TYPE.TEXT },
  { field_name: '开始时间', type: FIELD_TYPE.DATE },
  { field_name: '结束时间', type: FIELD_TYPE.DATE },
  { field_name: '组织者', type: FIELD_TYPE.TEXT },
  { 
    field_name: '处理状态', 
    type: FIELD_TYPE.SINGLE_SELECT,
    property: {
      options: FEISHU_STATUS_OPTIONS
    }
  },
  { field_name: '重试次数', type: FIELD_TYPE.NUMBER },
  { field_name: '会议文字稿', type: FIELD_TYPE.TEXT },
  { field_name: '分析摘要', type: FIELD_TYPE.TEXT },
  { field_name: '报告链接', type: FIELD_TYPE.TEXT },
  { field_name: 'JSON数据', type: FIELD_TYPE.TEXT },
];

// 用户授权信息表字段定义
const AUTH_TABLE_FIELDS = [
  { field_name: '用户ID', type: FIELD_TYPE.TEXT },
  { field_name: '用户姓名', type: FIELD_TYPE.TEXT },
  { field_name: 'access_token', type: FIELD_TYPE.TEXT },
  { field_name: 'refresh_token', type: FIELD_TYPE.TEXT },
  { field_name: 'token过期时间', type: FIELD_TYPE.NUMBER },  // 使用数字存储时间戳
  { field_name: '多维表格app_token', type: FIELD_TYPE.TEXT },
  { field_name: '数据表table_id', type: FIELD_TYPE.TEXT },
  { 
    field_name: '授权状态', 
    type: FIELD_TYPE.SINGLE_SELECT,
    property: {
      options: [
        { name: '有效', color: 2 },
        { name: '已过期', color: 3 },
      ]
    }
  },
  { field_name: '创建时间', type: FIELD_TYPE.NUMBER },  // 使用数字存储时间戳
];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userToken } = body;

    console.log('[Feishu Bitable] 开始创建多维表格...');

    // 获取当前用户信息
    const authStatus = await getAuthStatus();
    const user = authStatus.identities.user;
    
    if (!user || !user.available) {
      return NextResponse.json(
        { error: '用户未授权，请先完成授权' },
        { status: 400 }
      );
    }

    console.log(`[Feishu Bitable] 当前用户: ${user.userName}`);

    // 步骤1: 创建多维表格
    let appToken: string;
    try {
      const createResult = await callLarkApi(
        'POST',
        '/open-apis/bitable/v1/apps',
        {},
        { name: '会议动力分析' }
      );
      
      // 飞书 API 返回 code: 0 表示成功
      if (createResult.code !== 0) {
        throw new Error(createResult.msg || '创建多维表格失败');
      }
      
      appToken = createResult.data.app.app_token;
      console.log(`[Feishu Bitable] 多维表格创建成功，app_token: ${appToken}`);
    } catch (error: any) {
      console.error('[Feishu Bitable] 创建多维表格失败:', error);
      return NextResponse.json(
        { error: '创建多维表格失败: ' + error.message },
        { status: 500 }
      );
    }

    // 步骤2: 创建会议信息整理表
    let meetingTableId: string;
    try {
      const tableResult = await callLarkApi(
        'POST',
        `/open-apis/bitable/v1/apps/${appToken}/tables`,
        {},
        {
          table: {
            name: '会议信息整理',
            fields: MEETING_TABLE_FIELDS,
          }
        }
      );
      
      // 飞书 API 返回 code: 0 表示成功
      if (tableResult.code !== 0) {
        throw new Error(tableResult.msg || '创建会议信息表失败');
      }
      
      meetingTableId = tableResult.data.table_id;
      console.log(`[Feishu Bitable] 会议信息表创建成功，table_id: ${meetingTableId}`);
    } catch (error: any) {
      console.error('[Feishu Bitable] 创建会议信息表失败:', error);
      return NextResponse.json(
        { error: '创建会议信息表失败: ' + error.message },
        { status: 500 }
      );
    }

    // 步骤3: 创建用户授权信息表
    let authTableId: string;
    try {
      const tableResult = await callLarkApi(
        'POST',
        `/open-apis/bitable/v1/apps/${appToken}/tables`,
        {},
        {
          table: {
            name: '用户授权信息',
            fields: AUTH_TABLE_FIELDS,
          }
        }
      );
      
      // 飞书 API 返回 code: 0 表示成功
      if (tableResult.code !== 0) {
        throw new Error(tableResult.msg || '创建授权信息表失败');
      }
      
      authTableId = tableResult.data.table_id;
      console.log(`[Feishu Bitable] 授权信息表创建成功，table_id: ${authTableId}`);
    } catch (error: any) {
      console.error('[Feishu Bitable] 创建授权信息表失败:', error);
      return NextResponse.json(
        { error: '创建授权信息表失败: ' + error.message },
        { status: 500 }
      );
    }

    // 步骤4: 存储用户授权信息到【全局用户注册表】
    // 所有用户的配置都写入这个固定的表格，方便事件处理时查询
    try {
      // 飞书多维表格日期字段需要毫秒级时间戳
      const expiresAtMs = user.expiresAt ? Date.parse(user.expiresAt) : Date.now() + 7200000; // 默认2小时后
      const createdAtMs = Date.now();
      
      const recordData: Record<string, any> = {
        '用户ID': user.openId,
        '用户姓名': user.userName,
        'access_token': '[已授权]',  // 实际 token 不直接存储
        'refresh_token': '[已授权]',
        '多维表格app_token': appToken,       // 用户自己的多维表格
        '数据表table_id': meetingTableId,     // 用户自己的会议信息表
        '授权状态': '有效',
      };
      
      // 日期字段需要毫秒时间戳
      if (expiresAtMs) {
        recordData['token过期时间'] = expiresAtMs;
      }
      recordData['创建时间'] = createdAtMs;
      
      // 写入全局用户注册表（使用应用身份，因为全局注册表对所有用户开放）
      await addRecord(GLOBAL_USER_REGISTRY.appToken, GLOBAL_USER_REGISTRY.tableId, recordData, true);
      console.log('[Feishu Bitable] 授权信息已写入全局注册表');
    } catch (error: any) {
      console.error('[Feishu Bitable] 存储授权信息失败:', error);
      // 不返回错误，因为表格已创建成功
    }

    // 返回结果
    const bitableUrl = `https://feishu.cn/base/${appToken}`;
    
    return NextResponse.json({
      success: true,
      appToken,
      meetingTableId,
      authTableId,
      bitableUrl,
      userName: user.userName,
    });

  } catch (error: any) {
    console.error('[Feishu Bitable] 创建失败:', error);
    return NextResponse.json(
      { error: error.message || '创建多维表格失败' },
      { status: 500 }
    );
  }
}
