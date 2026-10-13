# ADR 0001 — 独立子项目 + Hono/React 分离栈，而非并入父应用

- 状态：已接受
- 日期：2026-09-11

## 背景

父仓库 `ai-coding-crash-course` 已是一个 React Router v7 + Vite + Drizzle 的应用。
Prompt Viewer 需要展示 `request-logger/logs/` 下的 wire 日志，用户明确要求
"功能完整的前后端服务器，用最新最常用的框架"。

## 决策

在 `prompt-viewer/` 建立**独立子项目**（自带 package.json，npm workspaces 管理
`server/` + `web/` 两个包），不并入父应用构建：

- 后端：Hono + TypeScript（`@hono/node-server`），负责把 wire 日志解析成结构化 JSON
- 前端：Vite + React 19 + Tailwind CSS 4，纯渲染 Parsed Log
- 一条 `npm run dev` 同时拉起两端（concurrently），Vite dev proxy `/api` → `:3001`

## 备选方案

1. **Next.js 15 全栈**：单一框架最流行，但"前后端分离"诉求下结构不如 A 清晰，
   且引入与父仓库重复的第二套全栈框架。
2. **并入父应用（React Router v7）**：技术栈一致，但 Viewer 与父应用业务无关，
   混入会污染父应用依赖与路由，且用户明确要"前后端服务器"形态。

## 后果

- 仓库中出现第二个 package.json（本 ADR 即为此存在的解释）。
- 后端解析逻辑集中、可独立测试；前端拿到的是干净渲染模型。
- 生产模式可由 Hono 直接静态托管 `web/dist`，单进程部署。
