'use client';

import { FormEvent, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import Layout from '@/components/Layout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { AlertCircle, CheckCircle2, Mail } from 'lucide-react';

export default function LoginPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nextPath = searchParams.get('next') || '/feishu-config';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsSubmitting(true);

    try {
      const origin = window.location.origin;
      const { error: authError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
        },
      });

      if (authError) {
        throw authError;
      }

      setMessage('登录邮件已发送，请打开邮箱点击登录链接后返回本页面。');
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : '发送登录邮件失败，请稍后重试。'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Layout>
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-slate-900">登录平台账号</h1>
          <p className="text-slate-600">
            这里登录的是你的产品账号，底层使用 Supabase Auth 处理身份验证，不需要用户登录 Supabase 后台。
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <Card>
            <CardHeader>
              <CardTitle>邮箱魔法链接登录</CardTitle>
              <CardDescription>
                输入你的邮箱，系统会发送一封登录邮件。点击邮件中的链接后，将自动返回产品并建立会话。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div className="space-y-2">
                  <Label htmlFor="email">邮箱地址</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="name@example.com"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </div>

                <div className="flex gap-3">
                  <Button type="submit" disabled={isSubmitting || !email.trim()}>
                    <Mail className="w-4 h-4" />
                    {isSubmitting ? '发送中...' : '发送登录链接'}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => router.push(nextPath)}>
                    返回上一页
                  </Button>
                </div>
              </form>

              {message ? (
                <Alert className="mt-4 border-emerald-200 bg-emerald-50">
                  <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                  <AlertTitle className="text-emerald-900">邮件已发送</AlertTitle>
                  <AlertDescription className="text-emerald-800">{message}</AlertDescription>
                </Alert>
              ) : null}

              {error ? (
                <Alert className="mt-4 border-red-200 bg-red-50">
                  <AlertCircle className="h-4 w-4 text-red-700" />
                  <AlertTitle className="text-red-900">发送失败</AlertTitle>
                  <AlertDescription className="text-red-800">{error}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>登录后你能做什么</CardTitle>
              <CardDescription>
                登录后，每个账号会拥有自己独立的飞书集成配置、OAuth 授权记录、检查状态和审计日志。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-600">
              <div>- 保存自己的 App ID / App Secret / Webhook Token</div>
              <div>- 绑定自己的 Base 与会议信息表</div>
              <div>- 发起自己的 OAuth 授权并自动落库</div>
              <div>- 查看权限、Webhook、OAuth、Base 的检查状态</div>
              <div>- 在同一域名下安全隔离不同用户的数据</div>
              <div className="pt-2">
                <Link className="text-indigo-600 hover:underline" href={nextPath}>
                  返回飞书配置页
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
