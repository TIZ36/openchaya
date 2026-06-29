# 供应商图标说明

本目录用于存放主流 LLM 供应商的图标文件，支持明亮和暗色主题。

## 文件命名规则

- `{provider}_light.png` - 明亮主题图标
- `{provider}_dark.png` - 暗色主题图标

## 支持的供应商

- `openai` - OpenAI
- `anthropic` - Anthropic (Claude)
- `gemini` - Google Gemini
- `google` - Google (通用)
- `deepseek` - DeepSeek
- `ollama` - Ollama

## 图标要求

- 格式：PNG
- 推荐尺寸：64x64 或 128x128 像素
- 背景：透明
- 明亮主题图标：适合在浅色背景上显示
- 暗色主题图标：适合在深色背景上显示

## 使用方式

代码会自动从 `/assets/providers/` 目录加载图标，如果图标文件不存在，会回退到 emoji 图标。

