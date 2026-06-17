export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[Instrumentation] Next.js 服务启动，自动启动事件监听...');
    
    // 延迟启动，等待服务完全就绪
    setTimeout(async () => {
      try {
        // 动态导入避免 Edge Runtime 编译错误
        const { getEventService } = await import('@/lib/feishu/events');
        const eventService = getEventService();
        const result = await eventService.start();
        console.log('[Instrumentation] 事件监听服务自动启动:', result);
      } catch (error) {
        console.error('[Instrumentation] 事件监听服务自动启动失败:', error);
      }
    }, 5000);
  }
}
