import { Suspense } from 'react';
import FeishuConfigWorkspace from '@/components/FeishuConfigWorkspace';

export default function FeishuConfigPage() {
  return (
    <Suspense fallback={null}>
      <FeishuConfigWorkspace />
    </Suspense>
  );
}
