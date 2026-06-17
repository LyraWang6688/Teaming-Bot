/**
 * 飞书 CLI 工具封装
 * 用于执行飞书 CLI 命令
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

// 飞书 CLI 配置文件路径
const LARK_CONFIG_DIR = '/root/.config/lark-cli';
const LARK_CONFIG_FILE = path.join(LARK_CONFIG_DIR, 'profiles.json');

export interface LarkAuthStatus {
  appId: string;
  brand: string;
  identities: {
    bot?: {
      status: string;
      available: boolean;
    };
    user?: {
      status: string;
      available: boolean;
      openId?: string;
      userName?: string;
      scope?: string;
      expiresAt?: string;
    };
  };
}

export interface DeviceAuthResult {
  deviceCode: string;
  verificationUrl: string;
  userCode: string;
  expiresIn: number;
}

export interface AuthResult {
  success: boolean;
  user?: {
    openId: string;
    userName: string;
    scope: string;
    expiresAt: string;
  };
  error?: string;
}

/**
 * 执行飞书 CLI 命令
 */
export async function execLarkCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(`npx @larksuite/cli ${command}`, {
      timeout: 30000,
      env: { ...process.env },
    });
    return { stdout, stderr };
  } catch (error: any) {
    // 如果命令返回非零退出码，但 stdout 有内容，也返回
    if (error.stdout) {
      return { stdout: error.stdout, stderr: error.stderr || '' };
    }
    throw error;
  }
}

/**
 * 配置飞书 CLI 凭证
 * 为指定的 appId 创建配置
 */
export async function configureLarkProfile(appId: string, appSecret: string): Promise<void> {
  // 确保配置目录存在
  await mkdir(LARK_CONFIG_DIR, { recursive: true });

  // 读取现有配置
  let profiles: Record<string, any> = {};
  try {
    const { stdout } = await execAsync(`cat ${LARK_CONFIG_FILE} 2>/dev/null || echo '{}'`);
    profiles = JSON.parse(stdout);
  } catch {
    // 配置文件不存在，使用空对象
  }

  // 更新配置
  profiles[appId] = {
    app_id: appId,
    app_secret: appSecret,
    brand: 'feishu',
  };

  // 写入配置
  await writeFile(LARK_CONFIG_FILE, JSON.stringify(profiles, null, 2));
}

/**
 * 初始化飞书 CLI 配置
 * 使用 config init 命令配置 app_id 和 app_secret
 */
export async function initLarkConfig(appId: string, appSecret: string): Promise<{ success: boolean; error?: string }> {
  try {
    // 使用 config init 命令初始化配置，通过 stdin 传入 app_secret
    const { stdout, stderr } = await execAsync(
      `echo '${appSecret}' | npx @larksuite/cli config init --app-id "${appId}" --app-secret-stdin --brand feishu 2>&1`
    );
    
    // 检查是否成功
    if (stdout.includes('OK: Configuration saved') || stdout.includes('"appId"')) {
      return { success: true };
    }
    
    return { success: false, error: stderr || stdout };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * 启动 Device Flow 授权流程
 */
export async function startDeviceAuth(appId: string, appSecret: string): Promise<DeviceAuthResult> {
  // 初始化配置
  const initResult = await initLarkConfig(appId, appSecret);
  if (!initResult.success) {
    throw new Error(`配置初始化失败: ${initResult.error}`);
  }
  
  // 启动 Device Flow
  const { stdout, stderr } = await execLarkCommand(
    `auth login --no-wait --json --domain vc,base,docs,contact`
  );

  // 解析输出
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    // 尝试从输出中提取 JSON
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`解析授权响应失败: ${stdout || stderr}`);
    }
  }
  
  return {
    deviceCode: result.device_code || result.deviceCode,
    verificationUrl: result.verification_url || result.verificationUrl,
    userCode: result.user_code || result.userCode,
    expiresIn: result.expires_in || result.expiresIn || 300,
  };
}

/**
 * 检查授权状态
 */
export async function checkAuthStatus(deviceCode: string): Promise<AuthResult> {
  try {
    const { stdout } = await execLarkCommand(
      `auth login --device-code ${deviceCode} --json`
    );

    // 如果有输出，说明授权成功
    if (stdout.trim()) {
      // 获取用户信息
      const statusResult = await getAuthStatus();
      if (statusResult.identities.user?.available) {
        return {
          success: true,
          user: {
            openId: statusResult.identities.user.openId || '',
            userName: statusResult.identities.user.userName || '',
            scope: statusResult.identities.user.scope || '',
            expiresAt: statusResult.identities.user.expiresAt || '',
          },
        };
      }
    }

    return { success: false, error: 'Authorization pending' };
  } catch (error: any) {
    // 检查是否是 "authorization pending" 错误
    if (error.message?.includes('pending') || error.stderr?.includes('pending')) {
      return { success: false, error: 'Authorization pending' };
    }
    return { success: false, error: error.message || 'Authorization failed' };
  }
}

/**
 * 获取当前授权状态
 */
export async function getAuthStatus(): Promise<LarkAuthStatus> {
  const { stdout } = await execLarkCommand('auth status');
  return JSON.parse(stdout);
}

/**
 * 使用用户身份调用 API
 */
export async function callLarkApi(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  params?: Record<string, any>,
  data?: any,
  asApp: boolean = false  // 是否使用应用身份（默认使用用户身份）
): Promise<any> {
  // 全局注册表操作使用应用身份，其他操作使用用户身份
  const identity = asApp ? 'app' : 'user';
  let command = `api ${method} "${path}" --as ${identity} --format json`;
  
  if (params && Object.keys(params).length > 0) {
    command += ` --params '${JSON.stringify(params)}'`;
  }
  
  if (data) {
    command += ` --data '${JSON.stringify(data)}'`;
  }

  const { stdout, stderr } = await execLarkCommand(command);
  
  if (stdout.trim()) {
    return JSON.parse(stdout);
  }
  
  throw new Error(stderr || 'API call failed');
}

/**
 * 获取文档内容
 */
export async function getDocumentContent(docToken: string): Promise<string> {
  const { stdout } = await execLarkCommand(`docs get-content --token ${docToken}`);
  return stdout;
}

/**
 * 创建多维表格
 */
export async function createBitable(name: string): Promise<{ appToken: string }> {
  const result = await callLarkApi('POST', '/open-apis/bitable/v1/apps', {}, { name });
  
  // 飞书 API 返回 code: 0 表示成功
  if (result.code !== 0) {
    throw new Error(result.msg || 'Failed to create bitable');
  }
  
  return { appToken: result.data.app.app_token };
}

/**
 * 在多维表格中创建数据表
 */
export async function createTable(
  appToken: string,
  table: {
    name: string;
    fields: Array<{
      field_name: string;
      type: number;
      property?: any;
    }>;
  }
): Promise<{ tableId: string }> {
  const result = await callLarkApi(
    'POST',
    `/open-apis/bitable/v1/apps/${appToken}/tables`,
    {},
    table
  );
  
  // 飞书 API 返回 code: 0 表示成功
  if (result.code !== 0) {
    throw new Error(result.msg || 'Failed to create table');
  }
  
  return { tableId: result.data.table_id };
}

/**
 * 添加记录到数据表
 * @param asApp 是否使用应用身份（全局注册表操作需要使用应用身份）
 */
export async function addRecord(
  appToken: string,
  tableId: string,
  fields: Record<string, any>,
  asApp: boolean = false
): Promise<{ recordId: string }> {
  const result = await callLarkApi(
    'POST',
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    {},
    { fields },
    asApp  // 传递身份参数
  );
  
  // 飞书 API 返回 code: 0 表示成功
  if (result.code !== 0) {
    throw new Error(result.msg || 'Failed to add record');
  }
  
  return { recordId: result.data.record.record_id };
}
