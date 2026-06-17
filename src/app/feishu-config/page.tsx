'use client';

import { useState } from 'react';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ExternalLink, AlertCircle, Copy, Check } from 'lucide-react';

const REQUIRED_EVENTS = [
  { id: 'vc.bot.meeting_ended_v1', name: '会议结束', desc: '会议整体结束时触发' },
  { id: 'vc.meeting.participant_meeting_ended_v1', name: '参与的会议结束', desc: '用户参与的会议结束时触发' },
  { id: 'vc.note.generated_v1', name: '纪要生成', desc: '智能纪要/转录稿生成完成时触发' },
];

const REQUIRED_ENV_VARS = [
  { key: 'FEISHU_APP_ID', desc: '飞书应用凭证，用于服务端换取 tenant_access_token' },
  { key: 'FEISHU_APP_SECRET', desc: '飞书应用密钥' },
  { key: 'FEISHU_WEBHOOK_VERIFICATION_TOKEN', desc: 'Webhook 验签 token，需与飞书开放平台保持一致' },
  { key: 'PROJECT_PUBLIC_URL', desc: '公网访问域名，用于生成报告链接' },
  { key: 'FEISHU_BASE_APP_TOKEN', desc: '当前运行时使用的多维表格 app_token' },
  { key: 'FEISHU_MEETING_TABLE_ID', desc: '当前运行时使用的会议信息表 table_id' },
];

export default function FeishuConfigPage() {
  const [origin] = useState(() =>
    typeof window !== 'undefined' ? window.location.origin : ''
  );
  const [copied, setCopied] = useState(false);

  const webhookUrl = `${origin || 'https://your-domain.com'}/api/feishu/webhook`;

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">飞书集成配置</h1>
          <p className="text-slate-600 mt-2">当前正式链路为 Webhook + OpenAPI。本页用于指引生产环境接入，不再触发旧版 CLI 授权初始化。</p>
        </div>

        <Alert className="mb-6 border-amber-200 bg-amber-50">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-800">迁移说明</AlertTitle>
          <AlertDescription className="text-amber-700">
            旧版 <strong>listener + CLI</strong> 链路已标记为废弃，仅保留作历史参考；当前请统一按 <strong>Webhook + OpenAPI</strong> 方案接入。
          </AlertDescription>
        </Alert>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg">第一步：创建飞书应用</CardTitle>
            <CardDescription>在飞书开放平台创建企业自建应用，并开通当前链路需要的权限。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                点击下方链接，在飞书开放平台创建一个<strong>企业自建应用</strong>。
                创建完成后，将 <strong>App ID</strong> 和 <strong>App Secret</strong> 写入服务端环境变量。
              </p>
              <Button variant="outline" asChild>
                <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-4 h-4 mr-2" />
                  打开飞书开放平台
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg">第二步：配置事件订阅</CardTitle>
            <CardDescription>当前正式方案使用 Webhook 接收会议事件。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <Alert className="mb-4">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Webhook 回调地址</AlertTitle>
                <AlertDescription>
                  <div className="mt-2 space-y-3">
                    <p>在飞书开放平台中选择 <strong>Webhook</strong> 订阅方式，并配置以下回调地址：</p>
                    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <code className="break-all text-xs text-slate-700">{webhookUrl}</code>
                      <Button variant="outline" size="sm" onClick={() => copyToClipboard(webhookUrl)}>
                        {copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
                        {copied ? '已复制' : '复制地址'}
                      </Button>
                    </div>
                    <p className="text-sm text-slate-600">
                      同时请在飞书后台填写与服务端环境变量 <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 text-xs">FEISHU_WEBHOOK_VERIFICATION_TOKEN</code> 一致的 Verification Token。
                    </p>
                  </div>
                </AlertDescription>
              </Alert>

              <h4 className="font-medium text-slate-900 mb-3">在「事件订阅」中添加以下事件：</h4>
              <Alert className="mb-3 bg-amber-50 border-amber-200">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                <AlertTitle className="text-amber-800">重要提示</AlertTitle>
                <AlertDescription className="text-amber-700">
                  `vc.bot.meeting_ended_v1` 用于覆盖“用户被邀请但未实际参会”的场景，这是当前从 CLI 切到 Webhook 的核心原因。
                </AlertDescription>
              </Alert>
              <div className="space-y-2">
                {REQUIRED_EVENTS.map((event) => (
                  <div key={event.id} className="flex items-start gap-2">
                    <Checkbox checked className="mt-0.5" />
                    <div>
                      <div className="text-sm font-medium">{event.name}</div>
                      <div className="text-xs text-slate-500 font-mono">{event.id}</div>
                      <div className="text-xs text-slate-400">{event.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg">第三步：配置服务端环境变量</CardTitle>
            <CardDescription>当前运行时通过服务端环境变量读取飞书凭证、Webhook 验签信息和 Base 配置。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="space-y-3">
                {REQUIRED_ENV_VARS.map((item) => (
                  <div key={item.key} className="rounded-lg border border-slate-200 p-3">
                    <div className="text-sm font-mono font-semibold text-slate-900">{item.key}</div>
                    <div className="mt-1 text-sm text-slate-600">{item.desc}</div>
                  </div>
                ))}
              </div>

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>当前状态说明</AlertTitle>
                <AlertDescription>
                  本页已不再调用旧版 CLI Device Flow 授权接口。当前请先在飞书后台完成应用配置，再由运维或开发在部署环境中写入上述变量。
                </AlertDescription>
              </Alert>

              <div className="flex gap-3">
                <Button variant="outline" asChild>
                  <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    打开飞书开放平台
                  </a>
                </Button>
                <Button variant="outline" asChild>
                  <a href="/api/feishu/webhook" target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    检查 Webhook 接口
                  </a>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
