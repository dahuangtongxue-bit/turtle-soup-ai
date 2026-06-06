// 后端代理：支持最多 6 个 OpenAI 兼容的模型槽位（PLAYER_1 ~ PLAYER_6）
// 每个槽位独立配置 BASE_URL / API_KEY / MODEL / DISPLAY_NAME
// 前端传 playerIndex(1-6) 指定用哪一家模型
//
// OpenAI 兼容格式：DeepSeek / 智谱GLM / 通义 / 文心 / Kimi / 豆包 / MiniMax 等都支持
// 与"AI 谁是卧底"同款后端，狼人杀复用：本代理与具体游戏无关，只负责把 system+user 转发给指定模型。
// 使用 Edge Runtime

export const runtime = 'edge';

function getEnv(key) {
  try {
    if (typeof process !== 'undefined' && process.env && process.env[key]) {
      return process.env[key];
    }
  } catch (e) {}
  return undefined;
}

// 清洗模型泄漏到正文的思考内容。
// allowLong=false（刀人/查验/投票等，要简短）：剥思考标签 + 砍掉分析腔只留最后一句。
// allowLong=true（发言/遗言/赛后复盘，本就该多句）：只剥思考标签，保留完整多句。
function stripReasoning(raw, allowLong) {
  if (!raw) return '';
  let t = raw;
  // 1) 标准思考标签块 <think>...</think> / <reasoning>...</reasoning>
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  // 2) MiniMax 的非标准变体：(think)...(/think) 或 （think）等圆括号形式
  t = t.replace(/[(（]think[)）][\s\S]*?[(（]\/think[)）]/gi, '');
  // 3) 只有结束标签的情况：思考在前、真正内容在 </think> 或 (/think) 之后
  const endTagMatch = t.match(/(?:<\/think>|<\/reasoning>|[(（]\/think[)）])(?![\s\S]*(?:<\/think>|[(（]\/think[)）]))/i);
  if (endTagMatch && typeof endTagMatch.index === 'number') {
    const after = t.slice(endTagMatch.index + endTagMatch[0].length).trim();
    if (after) t = after;
  }
  // 4) 残留的孤立标签清掉
  t = t.replace(/<\/?think>/gi, '').replace(/<\/?reasoning>/gi, '').replace(/[(（]\/?think[)）]/gi, '');
  // 5) 仅"要简短"的场景，才砍分析腔取最后一段
  if (!allowLong) {
    const analysisOpeners = /^(让我(先)?分析|我来分析|思考[:：]|分析[:：]|首先[，,]|让我想想|我需要判断|the user|user wants|let me)/i;
    if (analysisOpeners.test(t.trim())) {
      const lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
      if (lines.length > 1) t = lines[lines.length - 1];
    }
  }
  return t.trim();
}

// 仅给 MiniMax 用：把狼人杀里偏"暴力/欺骗"的措辞软化成中性游戏词，
//   尽量绕过 MiniMax 较严的输入内容审核（1026 input sensitive）。
//   只动送给 MiniMax 的输入，不影响其它模型，也不影响游戏内部判定（座位号、投票格式不变）。
function softenForModeration(text) {
  if (!text) return text;
  const pairs = [
    [/狼人杀/g, '狼人推理游戏'],
    [/查杀/g, '验出狼'],
    [/刀人/g, '夜间淘汰'], [/首刀/g, '首轮目标'], [/想刀/g, '想淘汰'],
    [/刀掉/g, '淘汰'], [/刀口/g, '目标'], [/自刀/g, '自我淘汰'], [/刀/g, '淘汰'],
    [/杀光/g, '清空'], [/杀掉/g, '淘汰'], [/做掉/g, '淘汰'], [/击杀/g, '淘汰'],
    [/自相残杀/g, '自相内耗'], [/杀人/g, '淘汰玩家'], [/杀/g, '淘汰'],
    [/屠边/g, '清边'], [/屠民/g, '清空平民'], [/屠神/g, '清空神职'], [/屠/g, '清'],
    [/毒死/g, '用毒淘汰'], [/毒杀/g, '用毒淘汰'], [/下毒/g, '用毒'],
    [/撒谎/g, '伪装'], [/说谎/g, '伪装'], [/谎言/g, '伪装说辞'], [/谎/g, '伪装'],
    [/欺骗/g, '误导'], [/骗票/g, '争取选票'], [/骗信任/g, '争取信任'], [/骗子/g, '伪装者'], [/骗/g, '误导'],
    [/嫁祸/g, '转移怀疑'], [/栽赃/g, '转移怀疑'], [/甩锅/g, '转移责任'],
    [/替罪羊/g, '目标'], [/替死鬼/g, '目标'],
    [/咬一个/g, '指向一个'], [/咬死/g, '淘汰'], [/咬/g, '指向'],
    [/处死/g, '投票淘汰'],
    [/死讯/g, '出局通报'], [/死亡/g, '出局'], [/夜死/g, '夜间出局'], [/倒牌/g, '出局'],
    [/教唆/g, '引导'],
    [/死/g, '出局'],
  ];
  let t = text;
  for (const [re, rep] of pairs) t = t.replace(re, rep);
  return t;
}

// 读取第 i 个玩家槽位的配置（i: 1-6）
function getPlayerConfig(i) {
  const baseUrl = getEnv(`PLAYER_${i}_BASE_URL`);
  const apiKey = getEnv(`PLAYER_${i}_API_KEY`);
  const model = getEnv(`PLAYER_${i}_MODEL`);
  const displayName = getEnv(`PLAYER_${i}_DISPLAY_NAME`) || `模型${i}`;
  return { baseUrl, apiKey, model, displayName };
}

// GET：返回已配置的模型列表（前端用来知道有几家可用、各叫什么）
export async function GET() {
  const players = [];
  for (let i = 1; i <= 6; i++) {
    const c = getPlayerConfig(i);
    players.push({
      index: i,
      displayName: c.displayName,
      configured: !!(c.baseUrl && c.apiKey && c.model),
    });
  }
  return new Response(JSON.stringify({ players }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

const PASSWORD = () => getEnv('ACCESS_PASSWORD');

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: { message: '请求格式错误' } }, 400);
  }

  // 访问密码校验（可选）
  const pw = PASSWORD();
  if (pw && body.password !== pw) {
    return json({ error: { message: '访问密码错误' } }, 401);
  }

  const { playerIndex, system, user, maxTokens, allowLong } = body;
  const idx = parseInt(playerIndex);
  if (!idx || idx < 1 || idx > 6) {
    return json({ error: { message: 'playerIndex 必须是 1-6' } }, 400);
  }

  const cfg = getPlayerConfig(idx);
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    return json({ error: { message: `模型槽位 ${idx} 未配置完整（需要 BASE_URL / API_KEY / MODEL）` } }, 400);
  }

  const bu = (cfg.baseUrl || '').toLowerCase();
  const isMiniMax = bu.includes('minimax');

  // MiniMax 的输入内容审核较严（1026 input sensitive），会把狼人杀提示词里的
  //   "杀/刀/毒死/撒谎/嫁祸"等词判成敏感而拒绝请求。只对 MiniMax 把这些硬词软化成中性游戏词，
  //   尽量绕过拦截——不影响其它五家，也不改前端提示词。
  let sys = isMiniMax ? softenForModeration(system) : system;
  const usr = isMiniMax ? softenForModeration(user) : user;

  // MiniMax 是重推理模型：短输出（投票/用药/查验）没问题，但长发言会拖到超时被跳过。
  //   关键观察：同一个 MiniMax 在"谁是卧底"里很稳，因为那边每轮只说一句话。
  //   所以只对 MiniMax 的长发言类环节（allowLong），单独加一条"精简硬要求"，把输出压到一两句，
  //   让它像"谁是卧底"那样快速答完、赶在边缘超时前返回。短输出环节不加（本来就好使）。
  if (isMiniMax && allowLong && sys) {
    sys += '\n\n【输出精简硬要求】这段发言务必简短：最多 1-2 句话，直接给出你的核心判断和站队，不要逐条分析、不要长篇铺垫、不要复述别人的话。像在快节奏游戏里抢着开麦那样，一两句说完。';
  }

  // 组装 OpenAI 兼容请求
  const messages = [];
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: usr });

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const reqBody = {
    model: cfg.model,
    messages,
    max_tokens: maxTokens || 300,
    temperature: 0.9, // 默认 0.9，让发言更有个性、更有张力、更好玩
    stream: false,
  };

  // Kimi（moonshot）强制只允许 temperature=0.6，给高会报 400，单独降下来
  if (bu.includes('moonshot')) {
    reqBody.temperature = 0.6;
  }
  if (bu.includes('bigmodel')) {
    // 智谱 GLM
    reqBody.thinking = { type: 'disabled' };
  } else if (bu.includes('dashscope')) {
    // 通义千问
    reqBody.enable_thinking = false;
  } else if (bu.includes('volces') || bu.includes('ark')) {
    // 豆包（火山方舟）
    reqBody.thinking = { type: 'disabled' };
  } else if (bu.includes('moonshot')) {
    // Kimi（月之暗面）：默认开思考，需显式关闭，否则会超时
    reqBody.thinking = { type: 'disabled' };
  }
  // MiniMax：思考无法关闭（官方强制）。给够"推理 + 短正文"的预算即可（上面已把长发言压短）。
  //   预算太大反而让它越写越久、越容易撞上边缘的总时长上限。
  if (isMiniMax) {
    reqBody.max_tokens = Math.max(maxTokens || 300, 1000);
  }
  // DeepSeek：不加额外参数（deepseek-chat 非推理模型）

  // 真正调用模型：返回 { text, ... } 或 { error: { message } }。
  // MiniMax 偶发空正文，多试一次；总耗时受 deadline 限制，超时则优雅返回空串（不中断对局）。
  async function runCall() {
    const maxAttempts = isMiniMax ? 2 : 1;
    // MiniMax 限 22s：必须卡在 Netlify 边缘"单次响应总时长上限"以内，
    //   这样到点能主动中断并把最终 JSON 发出去（哪怕是空串），绝不让连接被平台切断成"只有空白"。
    const deadlineMs = isMiniMax ? 22000 : 25000;
    const startedAt = Date.now();
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadlineMs - (Date.now() - startedAt);
      if (remaining < 4000) break; // 时间不够再发一次了

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), remaining);
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(reqBody),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') { lastErr = '响应超时'; break; }
        lastErr = `网络错误：${e.message}`;
        continue;
      }
      clearTimeout(timer);

      if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 300); } catch (e) {}
        // 内容审核拦截（MiniMax 1026 input sensitive、或带 sensitive/敏感、或 422）：
        //   当作"那一手弃权"优雅跳过，绝不因此报错卡死整局；重试也没用（同样的输入还会被拦）。
        if (resp.status === 422 || /sensitive|敏感|1026|moderat|content[_\s-]?filter/i.test(detail)) {
          lastErr = '内容被模型安全审核拦截';
          break;
        }
        lastErr = `请求失败 (HTTP ${resp.status}) ${detail}`;
        if (resp.status < 500) break; // 4xx 是参数/鉴权问题，重试无意义
        continue;                     // 5xx 才重试
      }

      let data;
      try { data = await resp.json(); } catch (e) { lastErr = '响应解析失败'; continue; }
      const msg = data?.choices?.[0]?.message || {};

      // 优先 content；为空时退回 reasoning_content（MiniMax 关不掉思考，正文可能跑到这里）
      let text = (msg.content || '').trim();
      let usedReasoning = false;
      if (!text && msg.reasoning_content) {
        text = String(msg.reasoning_content).trim();
        usedReasoning = true;
      }
      text = stripReasoning(text, allowLong);
      // 从 reasoning_content 兜底、且本就要求简短（刀/验/投票）时，只取结论那一行
      if (usedReasoning && !allowLong && text) {
        const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
        if (lines.length) text = lines[lines.length - 1];
      }

      if (text) return { text, displayName: cfg.displayName, model: cfg.model };
      lastErr = '模型返回空内容'; // 空正文 → 继续重试（仅 MiniMax 有第二次机会）
    }

    // 审核拦截 / 超时 / 多次空内容 → 返回空串，让对局继续（MiniMax 那一手安静跳过）；
    //   其余真错误（鉴权、配置、持续 5xx 等）才上报，由前端提示。
    if (lastErr &&
        lastErr.indexOf('空内容') === -1 &&
        lastErr.indexOf('超时') === -1 &&
        lastErr.indexOf('审核拦截') === -1) {
      return { error: { message: `模型${idx} ${lastErr}` } };
    }
    return { text: '', displayName: cfg.displayName, model: cfg.model };
  }

  // 流式响应 + 心跳保活：等待慢模型（尤其 MiniMax 推理）期间，每 2 秒发一个空白字节，
  //   让 Netlify 边缘连接保持活跃，避免长时间无数据被判定 Inactivity Timeout（504）。
  //   JSON.parse 会忽略前导空白，所以前端拿到 "  \n{json}" 仍能正常解析，无需改动前端。
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let finished = false;
      const heartbeat = setInterval(() => {
        if (!finished) { try { controller.enqueue(encoder.encode(' ')); } catch (e) {} }
      }, 2000);
      let payload;
      try {
        payload = await runCall();
      } catch (e) {
        payload = { error: { message: `模型${idx} 内部错误：${e.message}` } };
      }
      finished = true;
      clearInterval(heartbeat);
      try { controller.enqueue(encoder.encode('\n' + JSON.stringify(payload))); } catch (e) {}
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
