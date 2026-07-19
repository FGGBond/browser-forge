---
name: {operation-name}
description: {一句话描述，说明 skill 能做什么、适用什么系统和业务场景}
---

# {operation-name}

## 概述

{2-3 句话：操作目标是什么、适用哪个系统、完成后产出什么结果}

## 前置条件

- 京ME 桌面客户端已登录（用于鉴权，如鉴权失败会自动降级为浏览器 Cookie）
- {其他业务前置条件，如"购物车中已有商品"}

## CLI 工具列表

| 工具 | 功能 | 关键输入 | 输出 |
|------|------|---------|------|
| `scripts/{verb}-{resource}.sh` | {功能} | {参数} | {产物} |

## 典型调用流程

```bash
# Step 1: {描述第一步目的}
bash scripts/{verb}-{resource}.sh

# Step 2: {描述第二步目的，说明使用上一步哪个输出}
bash scripts/{verb2}-{resource2}.sh --{param} <上一步输出的 {字段名}>
```

## 背景知识

→ 详见 [knowledge.md](knowledge.md)

## 接口依赖链

→ 详见 [api-map.md](api-map.md)
