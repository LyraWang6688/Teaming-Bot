# Debug Session: feishu-event-missing

## Status
- [OPEN]

## Symptom
- 飞书配置页初始化显示成功，`event_listener_ready` 已出现。
- 实际使用该飞书应用开会并生成妙记后，没有收到任何事件日志，也没有进入后续处理链路。

## Expected
- 妙记生成后，服务端应收到 `minutes.minute.generated_v1` 事件，并继续执行转写导出、分析与 Base 写回。

## Hypotheses
- H1: 飞书应用虽然建立了 WebSocket 连接，但目标事件 `minutes.minute.generated_v1` 实际没有成功订阅到当前应用版本。
- H2: 事件确实到达了 SDK 长连接，但 `EventDispatcher` 注册或事件体格式与当前处理逻辑不匹配，导致没有进入现有日志点。
- H3: 事件只会发送给满足特定应用可见范围/安装状态/会议归属条件的应用，当前会议不满足条件，所以飞书侧根本没有投递。
- H4: WebSocket 连接建立后发生了静默重连、订阅失效或实例切换，导致 UI 初始化成功时“ready”过，但真实事件发生时监听器已不在有效消费状态。
- H5: 服务端缺少“事件已到达但被过滤/丢弃”的关键观测日志，当前问题本质上是证据不足而不是事件一定没来。

## Evidence
- 待补充运行时日志与对照结果。

## Next Step
- 仅添加最小化观测点，确认：连接状态、原始事件到达、事件类型分发、事件入队前是否被过滤。

## Instrumentation Added
- `src/lib/feishu/events/eventListenerManager.ts`
- `src/lib/feishu/pipeline/meetingPipelineProcessor.ts`
- 新增观测点覆盖：
  - WebSocket `onReady/onError/onReconnecting/onReconnected`
  - `EventDispatcher` 命中订阅事件
  - SDK 回调进入 `enqueueSdkEvent`
  - 管线归一化入口、缺失 `event_id`、忽略事件类型、妙记事件归一化结果
