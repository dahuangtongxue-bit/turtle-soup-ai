'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, RotateCw, ChevronRight, Sparkles, Search, Trophy } from 'lucide-react';

// 与狼人杀/谁是卧底同后端契约:调用 /api/turtlesoup
const API_PATH = '/api/turtlesoup';

// 槽位号(PLAYER_N) → 显示名,写死在前端(中文环境变量易乱码),与后端 PLAYER_1~6 严格对应
const SLOT_NAMES = { 1: '智谱', 2: 'DeepSeek', 3: '千问', 4: 'Kimi', 5: '豆包', 6: 'MiniMax' };
function slotName(i) { return SLOT_NAMES[i] || ('模型' + i); }

// 人设 / 配色(按显示名匹配)。人设决定提问风格,是节目的看点,随意改。
const ROSTER_STYLE = {
  '智谱':     { color: '#62b87f', persona: '稳健派', desc: '顺着别人的线索顺藤摸瓜,稳扎稳打。' },
  'DeepSeek': { color: '#5b8cff', persona: '逻辑流', desc: '冷静严谨,用排除法一步步缩小范围。' },
  '千问':     { color: '#8a6cff', persona: '细节控', desc: '死磕时间、地点、物品等具体细节,不放过边角。' },
  'Kimi':     { color: '#37c2c2', persona: '脑洞流', desc: '天马行空,爱从意想不到的角度发问。' },
  '豆包':     { color: '#ef9a4a', persona: '急先锋', desc: '性子急,信息够了就想冲解题,爱赌一把。' },
  'MiniMax':  { color: '#e0607a', persona: '老六',   desc: '专挑别人不会问的反向、刁钻问题。' },
};
const PALETTE = ['#5b8cff', '#62b87f', '#8a6cff', '#37c2c2', '#ef9a4a', '#e0607a'];
const PERSONAS = ['逻辑流', '稳健派', '细节控', '脑洞流', '急先锋', '老六'];
function styleFor(name, i) {
  if (ROSTER_STYLE[name]) return ROSTER_STYLE[name];
  for (const k in ROSTER_STYLE) if (name && name.includes(k)) return ROSTER_STYLE[k];
  return { color: PALETTE[i % 6], persona: PERSONAS[i % 6], desc: '按自己的风格推理。' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 调用后端(完全沿用狼人杀的契约:system/user 分离 + resp.text() 后 JSON.parse)----------
// 海龟汤每步输出 JSON,故 allowLong 一律 true(只剥 think 标签、保留完整内容,避免被砍成最后一句)
async function callModel(playerIndex, system, user, maxTokens, password) {
  const resp = await fetch(API_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerIndex, system, user, maxTokens, password, allowLong: true }),
  });
  const rawText = await resp.text();
  let data;
  try { data = JSON.parse(rawText); }
  catch (e) {
    const snippet = rawText.replace(/\s+/g, ' ').slice(0, 120);
    throw new Error('模型 ' + playerIndex + ' 返回异常(HTTP ' + resp.status + '):' + (snippet || '空响应'));
  }
  if (!resp.ok || data.error) throw new Error((data.error && data.error.message) || ('模型 ' + playerIndex + ' 调用失败'));
  return data.text || '';
}

// ---------- JSON 容错提取 ----------
function extractJSON(text) {
  if (!text) return null;
  const t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const tryParse = (s, e) => { if (s === -1 || e === -1 || e < s) return null; try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; } };
  return tryParse(t.indexOf('{'), t.lastIndexOf('}')) || tryParse(t.lastIndexOf('{'), t.lastIndexOf('}'));
}

// ---------- Prompt(返回 {system, user})----------
function fmtClues(clues, withEssential) {
  return JSON.stringify(clues.map((c) => (withEssential ? { id: c.id, fact: c.fact, essential: !!c.essential } : { id: c.id, fact: c.fact })));
}
function fmtHistory(history) {
  if (!history.length) return '(还没有人提问)';
  return history.map((h, i) => `${i + 1}. ${h.name}问:「${h.q}」 → 主持人:${h.a}`).join('\n');
}

function solverPrompt(model, soup, history, hit, total) {
  const system =
`你正在玩文字推理游戏「海龟汤」。主持人给出一个离奇的【汤面】,真相(汤底)藏在背后,你要通过提问一步步把它还原出来。主持人只会回答:是 / 不是 / 不重要。

你的身份:${model.name}(${model.persona})—— ${model.desc}

只输出一个 JSON,不要任何额外文字、不要 markdown:
{
  "thought": "你此刻的推理,一句话,不超过25字",
  "action": "提问" 或 "解题",
  "content": "你的是非问题,或你对汤底的完整还原"
}

规则:
- 默认「提问」。问题必须能用 是/不是 回答,要在已有信息上推进,不要重复别人问过的。
- 只有当你能把整个汤底讲清楚时才「解题」;押注失败不影响别人继续。
- 始终保持你的人设风格。`;
  const user =
`【汤面】\n${soup.surface}\n\n【已发生的问答】\n${fmtHistory(history)}\n\n【线索进度】全场已确认 ${hit}/${total} 条关键线索(不告诉你具体是什么)。\n\n轮到你了,只输出 JSON。`;
  return { system, user };
}

function hostQuestionPrompt(soup, question) {
  const system =
`你是海龟汤的主持人兼判定官。你掌握【汤底】和【关键线索清单】,玩家看不到,只能用是非问题来还原真相。

【汤面】(玩家可见)\n${soup.surface}\n\n【汤底】(完整真相,严禁泄露)\n${soup.bottom}\n\n【关键线索清单】\n${fmtClues(soup.clues, false)}

针对玩家提出的一个问题,严格依据【汤底】判定,只输出 JSON,不要任何额外文字:
{
  "valid": true 或 false,
  "answer": "是" 或 "不是" 或 "不重要",
  "hit_clues": ["命中的线索ID"],
  "host_line": "一句主持人台词,不超过15字"
}

规则:
- 非是非题(如"为什么…""他是谁")→ valid 设为 false,answer 留空,host_line 提示玩家改成是非问句。
- 只依据汤底回答,不得编造;模棱两可时优先用"不重要"。
- "不重要"表示该问题与汤底无关。hit_clues 只填这个问题明确确认到的线索,没有就空数组。
- host_line 绝对不能透露汤底内容或线索原文。`;
  return { system, user: `玩家的问题:「${question}」` };
}

function hostSolutionPrompt(soup, solution) {
  const system =
`你是海龟汤主持人。玩家提交了对【汤底】的完整还原,请对照判定。

【汤底】\n${soup.bottom}\n\n【关键线索清单(essential=true 为必要线索)】\n${fmtClues(soup.clues, true)}

只输出 JSON,不要任何额外文字:
{
  "matched_clues": ["命中的线索ID"],
  "verdict": "通关" 或 "接近" 或 "不对",
  "host_line": "一句揭晓/点评,不超过30字"
}

判定标准:命中全部 essential=true 的线索 → "通关";命中其中一部分 → "接近";几乎没命中 → "不对"。`;
  return { system, user: `玩家的还原:「${solution}」` };
}

function hostHintPrompt(soup, history) {
  const system =
`你是海龟汤主持人。玩家卡住了。请在【绝对不直接说出汤底】的前提下,根据目前进展,给一句不超过30字、把他们往关键方向轻推的提示。只输出这句提示文本,不要引号、不要任何额外内容。

【汤底】\n${soup.bottom}`;
  return { system, user: `目前的问答:\n${fmtHistory(history)}` };
}

// ---------- 归一化(容错)----------
function normAction(j, raw) {
  if (!j || typeof j !== 'object') return { thought: '', action: '提问', content: (raw || '').trim().slice(0, 60) || '这件事和某个人当时的身体状况有关吗？' };
  let action = j.action === '解题' ? '解题' : '提问';
  let content = (j.content || '').toString().trim();
  if (!content) { action = '提问'; content = '这件事的关键和某个物品有关吗？'; }
  return { thought: (j.thought || '').toString().slice(0, 40), action, content };
}
function normAnswer(j, clueIds) {
  if (!j || typeof j !== 'object') return { valid: true, answer: '不重要', hit: [], line: '' };
  if (j.valid === false) return { valid: false, answer: '', hit: [], line: (j.host_line || '请换成能用是/不是回答的问题').toString().slice(0, 20) };
  const answer = ['是', '不是', '不重要'].includes(j.answer) ? j.answer : '不重要';
  const hit = Array.isArray(j.hit_clues) ? j.hit_clues.filter((x) => clueIds.has(x)) : [];
  return { valid: true, answer, hit, line: (j.host_line || '').toString().slice(0, 20) };
}
function normSolution(j, clueIds) {
  if (!j || typeof j !== 'object') return { matched: [], verdict: '不对', line: '' };
  const verdict = ['通关', '接近', '不对'].includes(j.verdict) ? j.verdict : '不对';
  const matched = Array.isArray(j.matched_clues) ? j.matched_clues.filter((x) => clueIds.has(x)) : [];
  return { matched, verdict, line: (j.host_line || '').toString().slice(0, 30) };
}

// ============================================================
export default function TurtleSoup() {
  const [models, setModels] = useState([]);            // [{index,name,color,persona,desc}]
  const [hostIndex, setHostIndex] = useState(null);
  const [soups, setSoups] = useState([]);
  const [soupIdx, setSoupIdx] = useState(0);
  const [maxRounds, setMaxRounds] = useState(6);
  const [allowHints, setAllowHints] = useState(true);
  const [manual, setManual] = useState(false);
  const [speed, setSpeed] = useState(3000);
  const [password, setPassword] = useState('');

  const [stage, setStage] = useState('setup');         // setup | playing | ended
  const [soup, setSoup] = useState(null);
  const [feed, setFeed] = useState([]);
  const [litClues, setLitClues] = useState(new Set());
  const [activeIdx, setActiveIdx] = useState(null);
  const [paused, setPaused] = useState(false);
  const [winner, setWinner] = useState(null);
  const [scoreboard, setScoreboard] = useState([]);
  const [setupErr, setSetupErr] = useState('');

  const abortRef = useRef(false);
  const pausedRef = useRef(false);
  const pauseResolvers = useRef([]);
  const stepResolveRef = useRef(null);
  const speedRef = useRef(3000);
  const hitMapRef = useRef(new Map());                 // clueId -> playerIndex(首位命中者)
  const logEndRef = useRef(null);

  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [feed, activeIdx]);

  // 题库
  useEffect(() => {
    fetch('/soups.json').then((r) => r.json()).then((d) => setSoups(d.soups || [])).catch(() => {});
  }, []);

  // 后端可用模型
  useEffect(() => {
    fetch(API_PATH).then((r) => r.json()).then((d) => {
      if (!d.players) return;
      const ms = d.players.filter((p) => p.configured).map((p, i) => {
        const st = styleFor(slotName(p.index), i);
        return { index: p.index, name: slotName(p.index), color: st.color, persona: st.persona, desc: st.desc };
      });
      setModels(ms);
      const ds = ms.find((m) => m.name.includes('DeepSeek'));
      setHostIndex(ds ? ds.index : (ms[0] ? ms[0].index : null));
    }).catch(() => {});
  }, []);

  const push = (item) => setFeed((f) => [...f, item]);

  function lightClues(ids, playerIndex, cluesTotalIds) {
    const newly = [];
    ids.forEach((id) => {
      if (!hitMapRef.current.has(id)) { hitMapRef.current.set(id, playerIndex); newly.push(id); }
    });
    if (newly.length) setLitClues((prev) => { const ns = new Set(prev); newly.forEach((x) => ns.add(x)); return ns; });
    return newly;
  }

  const waitIfPaused = () => (pausedRef.current ? new Promise((r) => pauseResolvers.current.push(r)) : Promise.resolve());
  const waitForStep = () => new Promise((r) => { stepResolveRef.current = r; });
  const pacing = async () => { if (!manualLocal()) await sleep(speedRef.current); };
  let _manual = false;
  const manualLocal = () => _manual;

  function buildScoreboard(solvers) {
    const counts = {};
    solvers.forEach((m) => (counts[m.index] = 0));
    for (const pid of hitMapRef.current.values()) if (counts[pid] != null) counts[pid]++;
    return solvers.map((m) => ({ m, pts: counts[m.index] })).sort((a, b) => b.pts - a.pts);
  }

  // ---------- 开局 ----------
  function startGame() {
    setSetupErr('');
    if (models.length < 2) { setSetupErr('可用模型不足 2 个,请检查 Netlify 环境变量(PLAYER_N_*)。'); return; }
    if (!soups.length) { setSetupErr('题库为空,请检查 public/soups.json。'); return; }

    const curSoup = soups[soupIdx];
    const host = models.find((m) => m.index === hostIndex) || models[0];
    const solvers = models.filter((m) => m.index !== host.index);

    abortRef.current = false; pausedRef.current = false; setPaused(false);
    hitMapRef.current = new Map();
    setSoup(curSoup); setFeed([]); setLitClues(new Set()); setWinner(null); setScoreboard([]); setActiveIdx(null);
    _manual = manual;
    setStage('playing');

    runGame(curSoup, host, solvers, password);
  }

  // ---------- 主循环 ----------
  async function runGame(curSoup, host, solvers, pw) {
    const clueIds = new Set(curSoup.clues.map((c) => c.id));
    const history = [];
    let roundsSinceHit = 0;

    for (let round = 1; round <= maxRounds && !abortRef.current; round++) {
      push({ kind: 'round', text: `第 ${round} 轮` });
      for (const player of solvers) {
        if (abortRef.current) return;
        await waitIfPaused();
        if (_manual) await waitForStep();

        // 取动作
        setActiveIdx(player.index);
        let act;
        try {
          const p = solverPrompt(player, curSoup, history, hitMapRef.current.size, curSoup.clues.length);
          const txt = await callModel(player.index, p.system, p.user, 500, pw);
          act = normAction(extractJSON(txt), txt);
        } catch (e) { push({ kind: 'error', model: player, text: e.message }); setActiveIdx(null); await pacing(); continue; }
        setActiveIdx(null);

        if (act.action === '解题') {
          let judged;
          try {
            const p = hostSolutionPrompt(curSoup, act.content);
            const txt = await callModel(host.index, p.system, p.user, 400, pw);
            judged = normSolution(extractJSON(txt), clueIds);
          } catch (e) { judged = { matched: [], verdict: '不对', line: '(判定出错)' }; }
          const lit = lightClues(judged.matched, player.index);
          push({ kind: 'solve', model: player, thought: act.thought, content: act.content, verdict: judged.verdict, line: judged.line, sparked: lit.length > 0 });
          if (judged.verdict === '通关') { finish(host, solvers, player); return; }
          await pacing();
        } else {
          let ans;
          try {
            const p = hostQuestionPrompt(curSoup, act.content);
            const txt = await callModel(host.index, p.system, p.user, 400, pw);
            ans = normAnswer(extractJSON(txt), clueIds);
          } catch (e) { ans = { valid: true, answer: '不重要', hit: [], line: '' }; }

          if (ans.valid === false) {
            push({ kind: 'invalid', model: player, thought: act.thought, content: act.content, line: ans.line });
          } else {
            history.push({ name: player.name, q: act.content, a: ans.answer });
            const lit = lightClues(ans.hit, player.index);
            if (lit.length) roundsSinceHit = 0; else roundsSinceHit++;
            push({ kind: 'question', model: player, thought: act.thought, content: act.content, answer: ans.answer, line: ans.line, sparked: lit.length > 0 });
          }
          await pacing();
        }

        // 冷场提示
        if (allowHints && roundsSinceHit >= solvers.length && !abortRef.current && hitMapRef.current.size < curSoup.clues.length) {
          try {
            const p = hostHintPrompt(curSoup, history);
            const hint = (await callModel(host.index, p.system, p.user, 150, pw)).trim();
            if (hint) { push({ kind: 'hint', text: hint }); roundsSinceHit = 0; await pacing(); }
          } catch { /* 提示失败跳过 */ }
        }
      }
    }
    if (!abortRef.current) finish(host, solvers, null);
  }

  function finish(host, solvers, win) {
    setActiveIdx(null);
    setWinner(win);
    setScoreboard(buildScoreboard(solvers));
    setStage('ended');
  }

  // ---------- 控制 ----------
  function togglePause() {
    const np = !pausedRef.current;
    pausedRef.current = np; setPaused(np);
    if (!np) { const rs = pauseResolvers.current; pauseResolvers.current = []; rs.forEach((r) => r()); }
  }
  function doStep() { if (stepResolveRef.current) { const r = stepResolveRef.current; stepResolveRef.current = null; r(); } }
  function resetGame() {
    abortRef.current = true; pausedRef.current = false;
    const rs = pauseResolvers.current; pauseResolvers.current = []; rs.forEach((r) => r());
    if (stepResolveRef.current) { const r = stepResolveRef.current; stepResolveRef.current = null; r(); }
    setStage('setup'); setFeed([]); setLitClues(new Set()); setWinner(null); setActiveIdx(null); setPaused(false);
  }

  // ============ 渲染 ============
  const Dot = ({ color }) => <span className="dot" style={{ color, background: color }} />;

  function renderItem(it, i) {
    if (it.kind === 'round') return <div key={i} className="sys">— {it.text} —</div>;
    if (it.kind === 'hint') return <div key={i} className="sys hint">🔮 主持人提示:{it.text}</div>;
    if (it.kind === 'error') return <div key={i} className="sys"><span className="err">⚠ {it.model.name} 调用失败:{it.text}</span></div>;

    const who = (
      <div className="who">
        <Dot color={it.model.color} />
        <span className="name" style={{ color: it.model.color }}>{it.model.name}</span>
        <span className="persona">· {it.model.persona}</span>
      </div>
    );

    if (it.kind === 'question' || it.kind === 'invalid') {
      const cls = it.kind === 'invalid' ? 'na' : it.answer === '是' ? 'yes' : it.answer === '不是' ? 'no' : 'na';
      const badgeText = it.kind === 'invalid' ? '无效' : it.answer;
      return (
        <div key={i} className="turn">
          {who}
          {it.thought ? <div className="thought">{it.thought}</div> : null}
          <div className="q">{it.content}</div>
          <div className="verdict">
            <span className={`badge ${cls}`}>{badgeText}</span>
            {it.line ? <span className={`host-line${it.sparked ? ' spark' : ''}`}>{it.line}</span> : null}
          </div>
        </div>
      );
    }
    if (it.kind === 'solve') {
      const vc = it.verdict === '通关' ? 'pass' : it.verdict === '接近' ? 'close' : 'fail';
      return (
        <div key={i} className="turn solve">
          <div className="tagline">✦ 解 题 尝 试</div>
          {who}
          {it.thought ? <div className="thought">{it.thought}</div> : null}
          <div className="q">{it.content}</div>
          <div className={`solve-verdict ${vc}`}>主持人:{it.verdict}{it.line ? ' —— ' + it.line : ''}</div>
        </div>
      );
    }
    return null;
  }

  const host = models.find((m) => m.index === hostIndex);
  const solvers = models.filter((m) => m.index !== hostIndex);

  return (
    <div className="wrap">
      <header className="masthead">
        <div className="brand">
          <h1>海龟汤 · 深夜推理</h1>
          <div className="sub"><b>六大国产 AI</b>&nbsp;&nbsp;轮流提问 · 还原真相</div>
        </div>
        <div className="tag"><Sparkles size={14} /> 多模型自动对局 · 短视频内容引擎</div>
      </header>

      {stage === 'setup' && (
        <section className="panel setup">
          <h2><Search size={18} /> 开局设置</h2>
          <div className="field">
            <label>选择谜题(汤)</label>
            <select value={soupIdx} onChange={(e) => setSoupIdx(+e.target.value)}>
              {soups.map((s, i) => <option key={i} value={i}>{`【${s.type}·${s.difficulty}】${s.surface.slice(0, 22)}…`}</option>)}
            </select>
          </div>
          <div className="row">
            <div className="field">
              <label>主持人 / 判定官</label>
              <select value={hostIndex ?? ''} onChange={(e) => setHostIndex(+e.target.value)}>
                {models.map((m) => <option key={m.index} value={m.index}>{`${m.name}（${m.persona}）`}</option>)}
              </select>
            </div>
            <div className="field">
              <label>最大轮数</label>
              <input className="num-input" type="number" min={2} max={12} value={maxRounds} onChange={(e) => setMaxRounds(Math.max(2, Math.min(12, +e.target.value || 6)))} />
            </div>
          </div>
          <div className="field">
            <label className="toggle"><input type="checkbox" checked={allowHints} onChange={(e) => setAllowHints(e.target.checked)} /> 冷场时允许主持人放提示</label>
          </div>
          <div className="field">
            <label className="toggle"><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> 手动步进模式(每步点一次,方便逐帧录制)</label>
          </div>
          <div className="field">
            <label>访问密码(若后端设了 ACCESS_PASSWORD 才需要,否则留空)</label>
            <input className="num-input" type="password" value={password} placeholder="未设密码可留空" autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="btn primary" onClick={startGame}><Play size={16} /> 开始对局</button>
          {setupErr ? <p className="err" style={{ marginTop: 12 }}>{setupErr}</p> : null}
        </section>
      )}

      {stage !== 'setup' && soup && (
        <section className="stage">
          <div className="main-col">
            <div className="panel soup-surface">
              <span className={`type-tag${soup.type === '红汤' ? ' red' : ''}`}>{soup.type}</span>
              <div className="label">汤 面</div>
              <div className="text">{soup.surface}</div>
            </div>

            <div className="controls">
              {stage === 'playing' && <button className="btn ghost" onClick={togglePause}>{paused ? <><Play size={15} /> 继续</> : <><Pause size={15} /> 暂停</>}</button>}
              {stage === 'playing' && manual && <button className="btn ghost" onClick={doStep}><ChevronRight size={15} /> 下一步</button>}
              <button className="btn ghost" onClick={resetGame}><RotateCw size={15} /> 重置</button>
              <div className="spacer" />
              {stage === 'playing' && (
                <div className="speed-pick">
                  {[['慢', 6000], ['中', 3000], ['快', 1200]].map(([label, ms]) => (
                    <button key={ms} className={speed === ms ? 'on' : ''} onClick={() => setSpeed(ms)}>{label}</button>
                  ))}
                </div>
              )}
            </div>

            <div className="feed">
              {feed.map(renderItem)}
              {stage === 'ended' && (
                <div className="panel reveal">
                  {winner ? (
                    <>
                      <div className="crown"><Trophy size={14} style={{ verticalAlign: '-2px' }} /> 本 局 胜 出</div>
                      <div className="winner">{winner.name}</div>
                    </>
                  ) : (
                    <div className="crown">无 人 通 关 · 揭 晓 汤 底</div>
                  )}
                  <div className="bottom-label">汤 底</div>
                  <div className="bottom-text">{soup.bottom}</div>
                  <div className="scoreboard">
                    <div className="crown">线 索 贡 献 榜</div>
                    {scoreboard.map(({ m, pts }, i) => (
                      <div key={m.index} className="srow">
                        <Dot color={m.color} />
                        <span className="n">{i + 1}. {m.name}</span>
                        <span className="pts">{pts} 线索</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          </div>

          <aside className="side-col">
            <div className="panel clue-wall">
              <div className="head">
                <span className="t">线 索 墙</span>
                <span className="count">{litClues.size} / {soup.clues.length}</span>
              </div>
              <div className="clue-cells">
                {soup.clues.map((c, i) => <div key={c.id} className={`cell${litClues.has(c.id) ? ' lit' : ''}`}>{i + 1}</div>)}
              </div>
            </div>
            <div className="panel roster" style={{ marginTop: 22 }}>
              <div className="t">参 战 模 型</div>
              {host && (
                <div className={`player host${activeIdx === host.index ? ' active' : ''}`}>
                  <Dot color={host.color} />
                  <span className="name">{host.name}</span>
                  {activeIdx === host.index ? <span className="thinking-tag">思考中</span> : null}
                  <span className="role">主持/判定</span>
                </div>
              )}
              {solvers.map((m) => (
                <div key={m.index} className={`player${activeIdx === m.index ? ' active' : ''}`}>
                  <Dot color={m.color} />
                  <span className="name">{m.name}</span>
                  {activeIdx === m.index ? <span className="thinking-tag">思考中</span> : null}
                  <span className="role">{m.persona}</span>
                </div>
              ))}
            </div>
          </aside>
        </section>
      )}
    </div>
  );
}
