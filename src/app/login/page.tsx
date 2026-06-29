'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Layout from '@/components/Layout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, Loader2, LogIn } from 'lucide-react';

function LoginPageContent() {
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextPath = searchParams.get('next') || '/feishu-config';
  const errorParam = searchParams.get('error');

  const errorMessages: Record<string, string> = useMemo(() => ({
    'invalid_callback': '回调参数不完整，请重新登录。',
    'invalid_state': '安全验证失败，请重新登录。',
    'auth_failed': '飞书授权失败，请重试。',
  }), []);

  const handleFeishuLogin = () => {
    setIsLoading(true);
    setError(null);
    window.location.href = `/api/auth/login?next=${encodeURIComponent(nextPath)}`;
  };

  const displayError = error || (errorParam ? errorMessages[errorParam] || '登录失败，请重试。' : null);

  return (
    <Layout>
      <div className="mx-auto max-w-md">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100">
              <LogIn className="h-6 w-6 text-indigo-600" />
            </div>
            <CardTitle className="text-xl">登录</CardTitle>
            <CardDescription>使用飞书账号登录，开启智能会议分析</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={handleFeishuLogin}
              className="w-full"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  跳转中...
                </>
              ) : (
                '使用飞书登录'
              )}
            </Button>

            {displayError ? (
              <Alert className="border-red-200 bg-red-50">
                <AlertCircle className="h-4 w-4 text-red-600" />
                <AlertTitle className="text-red-900">登录失败</AlertTitle>
                <AlertDescription className="text-red-700">{displayError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="mt-6 text-center text-sm text-slate-500">
              <Link className="text-indigo-600 hover:underline" href={nextPath}>
                返回
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}
