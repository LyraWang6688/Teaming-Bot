import { Loader2 } from 'lucide-react';

export default function PersistentReportLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="text-center">
        <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-blue-600" />
        <p className="text-slate-600">正在加载报告...</p>
      </div>
    </div>
  );
}
