# 海龟汤 · AI 多模型推理 🐢

六大国产 AI(智谱 / DeepSeek / 千问 / Kimi / 豆包 / MiniMax)自动玩「海龟汤」:一个模型当**主持人/判定官**握着汤底,其余模型轮流提是非问题、一步步还原真相。带**线索墙进度**、**思考字幕**、**解题判定**、**线索贡献榜**,为短视频内容录制设计。

**与你们「谁是卧底 / 狼人杀」同栈**:Next.js(App Router + Edge),后端复用同一个**与游戏无关的代理** `route.js`(一字未改),环境变量也是同一套 `PLAYER_N`。

- 后端是你们那套久经考验的 `route.js`:自带 MiniMax 思考清洗 / `reasoning_content` 兜底、各家关思考参数、MiniMax 22s 边缘超时 + 心跳保活防 504、审核拦截优雅跳过。
- 自带 4 道**清汤**种子题库,部署完直接能跑。

---

## 🎮 玩法机制

- **角色**:1 个主持人(判定官)+ 其余解谜模型。主持人在界面选,默认 DeepSeek(判定稳)。
- **回合**:每轮每个解谜模型各行动一次 —— 提一个是非问题,或尝试解题。
- **主持人只回答** `是` / `不是` / `不重要`;非是非题判「无效」要求重问。
- **线索墙**:每题预设若干关键线索,被问出来就点亮一格。
- **解题**:命中全部「必要线索」判**通关**,该模型胜出;否则「接近 / 不对」,别人继续。
- **冷场放提示**(可关)、**线索贡献榜**(按每个模型亲手问出多少条线索排名)。

---

## 🚀 部署到 Netlify

1. 推到 GitHub。
2. Netlify → **Add new site → Import an existing project** → 选这个仓库。Netlify 的 **Next.js 运行时会自动识别**并构建,无需手动配构建命令。
3. **Site settings → Environment variables → Import**,把 `.env.example` 内容粘进去、改成真实值导入(`SECRETS_SCAN_ENABLED=false` 已在 `netlify.toml` 默认关掉,避免密钥误报)。
4. **Deploy**。打开站点,选一道汤,开始对局。

> 本地:`npm install` → `npm run dev`(在项目根目录建一个 `.env.local` 放 `PLAYER_N_*`)。

---

## 🔑 环境变量(PLAYER_N,和狼人杀同款,可直接复用)

每个玩家位一组,全部 OpenAI 兼容:

| 变量 | 说明 |
|---|---|
| `PLAYER_{N}_BASE_URL` | OpenAI 兼容根地址,如 `https://api.deepseek.com/v1` |
| `PLAYER_{N}_API_KEY` | 密钥(留空 = 该位不启用,不影响其他模型) |
| `PLAYER_{N}_MODEL` | 模型串,如 `deepseek-chat` / `MiniMax-M3` / `glm-5.1`(以控制台为准) |
| `PLAYER_{N}_DISPLAY_NAME` | 后端返回用;前端实际显示名走 `SLOT_NAMES`(见下) |

`N` 取 1–6。完整可粘贴样例见 `.env.example`。另有:

| 变量 | 说明 |
|---|---|
| `ACCESS_PASSWORD` | 可选;设了之后前端要输入密码才能开局(校验在服务端) |
| `SECRETS_SCAN_ENABLED` | 设 `false`,避免 Netlify 把密钥误报为泄露导致部署失败 |

> **槽位→显示名**写死在前端 `components/TurtleSoup.jsx` 的 `SLOT_NAMES`(`1 智谱 / 2 DeepSeek / 3 千问 / 4 Kimi / 5 豆包 / 6 MiniMax`),避免中文环境变量乱码 —— 与狼人杀做法一致。必须和你的 `PLAYER_N` 实际配置对应。

---

## ⚠️ MiniMax / 关键适配

- **MiniMax 审核软化**自动生效:`route.js` 按 `baseURL` 含 `minimax` 自动把敏感词软化成中性游戏词(`softenForModeration`),并对长输出压短、空正文退回 `reasoning_content`。这些都在 `route.js` 里,无需配置。
- **海龟汤专属适配**:每步要求模型输出 JSON,所以前端所有调用都用 `allowLong: true`(`route.js` 此时只剥 `<think>` 标签、保留完整内容),再由前端 `extractJSON` 解析。若用 `allowLong:false`,多行 JSON 会被「砍成最后一句」而损坏。
- 接**红汤**时,若某些词(如「尸体/自杀」)仍触发 MiniMax 审核,把这些词补进 `route.js` 的 `softenForModeration` 映射表即可(注意该文件你三个游戏共用,改了都生效)。

---

## 🍲 加题 / 红汤

题库在 `public/soups.json`:

```json
{
  "id": "唯一标识",
  "type": "清汤",
  "difficulty": "经典",
  "surface": "汤面(玩家可见的谜题)",
  "bottom": "汤底(完整真相,只有主持人模型看得到)",
  "clues": [ { "id": "C1", "fact": "关键线索描述", "essential": true } ]
}
```

`essential:true` 是必要线索(全部命中才通关),`false` 是加分线索。建议每题 4–5 条、其中 3 条左右为必要。

---

## 🧩 改模型 / 改人设

- **加 / 减 / 换模型**:改 Netlify 环境变量 `PLAYER_N_*`,前端自动只显示已配置的。
- **改人设 / 配色**:`components/TurtleSoup.jsx` 顶部 `ROSTER_STYLE`(按显示名匹配)。人设决定提问风格,是节目看点。
- 换主持人在界面选即可。

---

## 📁 目录结构

```
turtle-soup-ai/
├── package.json
├── next.config.js
├── netlify.toml                  # 仅放 NODE_VERSION + SECRETS_SCAN_ENABLED
├── .env.example                  # PLAYER_N 环境变量样例
├── app/
│   ├── layout.js
│   ├── page.js                   # 渲染 TurtleSoup
│   ├── globals.css               # 深夜推理暗色主题
│   └── api/turtlesoup/route.js   # ★ 复用你们的通用代理(一字未改)
├── components/
│   └── TurtleSoup.jsx            # 海龟汤对局编排 + Prompt + 渲染
└── public/
    └── soups.json                # 题库(清汤种子)
```
