'use client';

import { FormEvent, Suspense, useMemo, useState } from 'react';
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

function LoginPageContent() {
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

			setMessage('登录邮件已发送，请查收并点击链接完成登录。');
		} catch (submitError) {
			setError(submitError instanceof Error ? submitError.message : '发送失败，请稍后重试。');
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Layout>
			<div className="mx-auto max-w-md">
				<Card>
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100">
							<Mail className="h-6 w-6 text-indigo-600" />
						</div>
						<CardTitle className="text-xl">登录</CardTitle>
						<CardDescription>输入邮箱，我们会发送一个登录链接给你</CardDescription>
					</CardHeader>
					<CardContent>
						<form className="space-y-4" onSubmit={handleSubmit}>
							<div className="space-y-2">
								<Label htmlFor="email">邮箱地址</Label>
								<Input
									id="email"
									type="email"
									placeholder="your@email.com"
									autoComplete="email"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									required
								/>
							</div>

							<Button type="submit" className="w-full" disabled={isSubmitting || !email.trim()}>
								{isSubmitting ? '发送中...' : '发送登录链接'}
							</Button>
						</form>

						{message ? (
							<Alert className="mt-4 border-emerald-200 bg-emerald-50">
								<CheckCircle2 className="h-4 w-4 text-emerald-600" />
								<AlertTitle className="text-emerald-900">邮件已发送</AlertTitle>
								<AlertDescription className="text-emerald-700">{message}</AlertDescription>
							</Alert>
						) : null}

						{error ? (
							<Alert className="mt-4 border-red-200 bg-red-50">
								<AlertCircle className="h-4 w-4 text-red-600" />
								<AlertTitle className="text-red-900">发送失败</AlertTitle>
								<AlertDescription className="text-red-700">{error}</AlertDescription>
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
