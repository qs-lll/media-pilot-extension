# MediaPilot Extension

一个面向自媒体创作者的 Chrome 侧边栏插件，帮助你在浏览小红书、抖音等内容平台时，快速识别页面内容、总结核心信息、提取评论洞察，并生成 AI 辅助回复。

> 本项目不内置任何 API Key。使用前请先在 [new.aicontrol.top](https://new.aicontrol.top/) 注册并获取自己的 API Key。

## 功能特点

- Chrome 原生侧边栏体验，不遮挡当前网页
- 自动识别小红书笔记内容，包括标题、作者、正文、媒体和部分评论
- 基于当前页面上下文进行 AI 对话
- 支持快捷提问，例如总结页面、提取评论痛点、整理素材卡片
- 支持截图后带图提问
- 支持评论场景下的 AI 回复辅助
- 支持抖音页面识别，并适配平台内评论回复入口
- 提供设置页，可配置 API Key、API 地址、模型和提示词

## 支持平台

### 小红书

打开 `xiaohongshu.com` 笔记页面后，插件会尝试读取当前页面 DOM，提取页面上下文，并带入侧边栏 AI 对话。

### 抖音

打开 `douyin.com` 或 `iesdouyin.com` 页面后，插件会识别页面环境，并适配评论区域的 AI 回复能力。抖音页面侧边栏主要提供识别状态和平台功能入口。

## 安装方式

1. 下载或克隆本仓库。
2. 打开 Chrome，进入 `chrome://extensions/`。
3. 开启右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择本项目目录。
6. 打开小红书或抖音页面，点击浏览器扩展图标打开侧边栏。

## 使用方式

1. 前往 [https://new.aicontrol.top/](https://new.aicontrol.top/) 注册账号并获取 API Key。
2. 打开一个小红书笔记页面。
3. 点击扩展图标，打开右侧边栏。
4. 点击右下角设置按钮，填写 API Key 并保存。
5. 等待插件自动识别当前页面。
6. 使用快捷问题，或在输入框中直接提问。
7. 如需评论回复，可在支持的平台评论区域使用 AI 回复入口。

## 配置说明

在侧边栏右下角点击设置按钮，可以配置：

- API Key
- API Base URL
- 模型名称
- 小红书评论回复提示词
- 主人公视角评论回复提示词
- 路人视角评论回复提示词

配置会保存在 Chrome 本地存储中。

API Key 获取地址：[https://new.aicontrol.top/](https://new.aicontrol.top/)

## 项目结构

```text
.
├── manifest.json      # Chrome 插件配置
├── background.js      # 扩展后台脚本，负责打开侧边栏
├── content.js         # 页面内容识别与平台功能注入
├── panel.html         # 侧边栏页面结构
├── panel.css          # 侧边栏样式
├── panel.js           # 侧边栏交互、AI 对话和设置逻辑
├── demo.html          # 本地演示页面
└── README.md
```

## 权限说明

插件使用以下主要权限：

- `sidePanel`：使用 Chrome 原生侧边栏
- `storage`：保存用户配置
- `tabs`：读取当前标签页信息
- `scripting`：向页面注入必要脚本
- `activeTab`：访问当前活动页面
- `debugger`：支持截图等页面能力

插件声明了小红书、抖音及 AI 服务地址的访问权限，用于页面识别和请求 AI 服务。

## 开发说明

本项目使用原生 HTML、CSS 和 JavaScript 编写，无需构建步骤。

修改代码后，在 `chrome://extensions/` 中点击插件卡片的刷新按钮，然后重新打开侧边栏即可查看效果。

## License

MIT
