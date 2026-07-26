import Link from 'next/link';
import { AlertCircle, ArrowLeft } from 'lucide-react';

export default function PersistentReportNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="mx-auto max-w-md p-6 text-center">
        <AlertCircle className="mx-auto mb-4 h-12 w-12 text-amber-500" />
        <h1 className="mb-2 text-xl font-semibold text-slate-800">报告不存在或尚未完成</h1>
        <p className="mb-5 text-slate-600">
          请确认报告链接完整；如果会议刚结束，请稍后再试。
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
        >
          <ArrowLeft className="h-4 w-4" />
          返回首页
        </Link>
      </div>
    </div>
  );
}
