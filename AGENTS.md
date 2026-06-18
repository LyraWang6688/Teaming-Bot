# 项目开发规范 (AGENTS.md)

## 项目概述

- **项目名称**：组队会议动力分析
- **技术栈**：Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, shadcn/ui, Recharts
- **核心功能**：基于 Amy Edmondson Teaming 框架 + Bion 群体动力学理论的会议纪要 AI 分析工具
- **支持格式**：.txt, .docx 文件

---

## 文档同步规范 [IMPORTANT]

### 必读文档

| 文档 | 路径 | 更新时机 |
|-----|------|---------|
| 项目结构说明 | `docs/项目结构说明.md` | 新增/删除/移动文件时 |
| 后台分析逻辑说明 | `docs/后台分析逻辑说明.md` | 修改分析逻辑时 |
| 输出报告说明 | `docs/输出报告的内容与形式说明.md` | 修改报告显示逻辑时 |
| 飞书集成设计 | `docs/飞书集成设计.md` | 修改飞书集成相关功能时 |

### 文档更新触发条件

当修改以下文件时，**必须同步更新** `docs/后台分析逻辑说明.md`：

| 修改内容 | 需同步更新的章节 |
|---------|----------------|
| 修改 `teamingRules.ts` 提示词 | docs/后台分析逻辑说明.md 第3、5、6、7、8、10、11章 |
| 修改 `zoneConfig.ts` Zone计算逻辑 | docs/后台分析逻辑说明.md 第4、7、8章 |
| 修改 `route.ts` 后端验证逻辑 | docs/后台分析逻辑说明.md 第2、8、12章 |
| 修改 `types/index.ts` 数据结构 | docs/后台分析逻辑说明.md 第1、附录章节 |

当修改以下文件时，**必须同步更新** `docs/输出报告的内容与形式说明.md`：

| 修改内容 | 需同步更新的章节 |
|---------|----------------|
| 修改 `AnalysisDashboard.tsx` 组件结构 | 第1、2、3、4、5、6、8章 |
| 修改 `TeamStateChart.tsx` 四象限图 | 第3、7.1章 |
| 修改 `BehaviorRadar.tsx` 雷达图 | 第4、7.2章 |
| 修改 PDF 导出逻辑 | 第9章 |
| 修改 `types/index.ts` 数据结构 | 附录章节 |

当修改以下文件时，**必须同步更新** `docs/飞书集成设计.md`：

| 修改内容 | 需同步更新的章节 |
|---------|----------------|
| 修改飞书权限配置 | 第4章 |
| 修改事件订阅列表 | 第3章 |
| 修改多维表格结构 | 第6章 |
| 修改前端配置页设计 | 第5章 |
| 修改初始化或分析流程 | 第7章 |

### 文档同步检查清单

修改上述文件后，检查是否需要更新文档：

- [ ] 分析流程是否变化？
- [ ] Zone判断规则是否调整？
- [ ] Behavior评估维度或标准是否改变？
- [ ] 验证逻辑是否修改？
- [ ] JSON Schema 是否变化？
- [ ] 新的业务规则是否需要记录？

---

## 核心文件索引

### 后台分析逻辑

| 文件 | 作用 | 修改频率 |
|-----|------|---------|
| `src/app/api/analyze/route.ts` | API入口、后端验证 | 低 |
| `src/constants/teamingRules.ts` | LLM系统提示词 | 中 |
| `src/constants/zoneConfig.ts` | Zone计算、验证函数 | 低 |

### 前端组件

| 文件 | 作用 |
|-----|------|
| `src/app/page.tsx` | 首页、上传、列表 |
| `src/components/AnalysisDashboard.tsx` | 报告详情页 |
| `src/components/charts/*.tsx` | 图表组件 |

### 类型定义

| 文件 | 作用 |
|-----|------|
| `src/types/index.ts` | TypeScript类型定义 |

### 飞书集成

| 文件 | 作用 | 修改频率 |
|-----|------|---------|
| `src/app/feishu-config/page.tsx` | 飞书配置页面 | 中 |
| `src/app/api/feishu/*/route.ts` | 飞书相关 API | 中 |
| `src/lib/feishu/*.ts` | 飞书工具函数 | 中 |

---

## 开发注意事项

### 1. Zone判定原则

```
Zone 由决策树从四个行为色标判定，不由分数判定：
  S=H/M → E≥M且R≥M? 学习区 : 舒适区
  S=L   → E≥M或R≥M? 焦虑区 : 冷漠区
协同(C)不参与决策树分叉，但影响报告文字质地

PS/WS 分数不参与 Zone 判定，作为 analysis 书写的解读透镜
```

### 2. 项目阶段影响

```
启动期（Start-up）：
- speakingUp/collaboration: 降低期望
- experimentation/reflection: 有数据则正常评估，无数据标 Grey

启动期以后（Post-startup）：
- 所有维度标准期望
```

### 3. PDF导出

- 使用 `html-to-image` 库
- filter配置排除外部样式表
- 批量下载与单独下载使用相同组件

---

## 测试命令

```bash
# TypeScript检查
pnpm tsc --noEmit

# ESLint检查
pnpm lint

# 启动开发服务
pnpm dev

# 构建生产版本
pnpm build
```

---

## 日志位置

- 开发日志：`/app/work/logs/bypass/dev.log`
- 应用日志：`/app/work/logs/bypass/app.log`
- 控制台日志：`/app/work/logs/bypass/console.log`

---

*最后更新：随代码变更同步更新*
