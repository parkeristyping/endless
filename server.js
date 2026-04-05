import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import { parse } from 'acorn';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.urlencoded({ extended: true }));
const server = createServer(app);
const wss = new WebSocketServer({ server });
const anthropic = new Anthropic();

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin';
const LOOP_INTERVAL = 30_000;
const MAX_SUGGESTIONS = 50;

// Admin-togglable settings (persisted)
const SETTINGS_FILE = join(__dirname, 'settings.json');
const AVAILABLE_MODELS = {
  'claude-sonnet-4-20250514': 'Sonnet (balanced)',
  'claude-opus-4-20250514': 'Opus (best)',
  'claude-haiku-3-20250709': 'Haiku (cheap)',
};

function loadSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return { suggestionsEnabled: false, themeUiEnabled: false, model: 'claude-sonnet-4-20250514' };
  }
}
function saveSettings() {
  writeFileSync(SETTINGS_FILE, JSON.stringify(adminSettings, null, 2), 'utf-8');
}
let adminSettings = loadSettings();

// Token usage tracking (persisted)
const USAGE_FILE = join(__dirname, 'usage.json');
function loadUsage() {
  try { return JSON.parse(readFileSync(USAGE_FILE, 'utf-8')); } catch { return {}; }
}
function saveUsage() {
  writeFileSync(USAGE_FILE, JSON.stringify(tokenUsage, null, 2), 'utf-8');
}
let tokenUsage = loadUsage(); // { "2026-04-05": { input: N, output: N, requests: N } }
const SAMPLE_SIZE = 20;
const MAX_PATTERN_LENGTH = 1500;
const MAX_PATTERN_LINES = 20;
const MAX_NESTING_DEPTH = 6;

const STATE_FILE = join(__dirname, 'state.json');
const LOG_FILE = join(__dirname, 'patterns.log');
const HISTORY_SIZE = 8;
const SUGGESTION_TTL = 3; // turns a suggestion survives
const THEME_INTERVAL = 20; // turns between theme changes

const DICTIONARY = JSON.parse(readFileSync(join(__dirname, 'words.json'), 'utf-8'));

function generateTheme() {
  const words = [];
  for (let i = 0; i < 5; i++) {
    words.push(DICTIONARY[Math.floor(Math.random() * DICTIONARY.length)]);
  }
  return words.join(' ');
}

const DEFAULT_PATTERN = `note("<c3 e3 g3 b3>/4")
  .s("piano")
  .legato(0.9)
  .stack(
    s("bd sd:2 bd sd:2").gain(0.8),
    s("hh*8").gain(0.4)
  )`;

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { pattern: DEFAULT_PATTERN, plan: '', history: [], theme: generateTheme() };
  }
}

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify({
    pattern: currentPattern,
    plan: currentPlan,
    history: turnHistory,
    theme: currentTheme,
  }, null, 2), 'utf-8');
}

function logPattern(turn, plan, code, theme) {
  const entry = `\n--- Turn ${turn} | ${new Date().toISOString()} | Theme: "${theme}" ---\nPlan: ${plan}\n\n${code}\n`;
  appendFileSync(LOG_FILE, entry, 'utf-8');
}

const saved = loadState();
let currentPattern = saved.pattern;
let currentPlan = saved.plan || '';
let turnHistory = saved.history || [];
let currentTheme = saved.theme || generateTheme();

// Suggestions now have an age (turns remaining)
let pendingSuggestions = []; // { text, turnsLeft }
let lastEvalError = null; // { error, code } from client
let activeClients = 0;
let loopTimer = null;
let turnNumber = turnHistory.length;

const SYSTEM_PROMPT = `You are a Strudel live coder performing an endless evolving musical piece for a live audience.

You have MEMORY across turns. You'll see your recent history and your own plan notes. Use them to create coherent musical arcs — build toward something over several turns, then shift direction.

You are given a THEME — 5 evocative words that set the mood and direction. Let the theme loosely guide your choices (sound selection, rhythm, effects, note patterns). Don't be too literal — interpret the words as abstract musical inspiration. The theme changes every ~20 turns; when it does, transition gradually into the new vibe over several turns.

OUTPUT FORMAT (you MUST follow this exactly):
<plan>
Your internal notes: what you're working toward, what to try next, which suggestions to incorporate over the next few turns. 2-3 sentences max.
</plan>
<code>
the strudel pattern here
</code>

RULES:
- Evolve the pattern GRADUALLY - change 1-2 things at a time, don't rewrite everything.
- Maximum 6 voices/layers at a time. If the pattern has more, REMOVE some before adding.
- When evolving, consider REMOVING or REPLACING elements — not just adding. Subtraction is musical.
- Favor slow evolution: change a note, swap a sound, adjust a filter. Not everything at once.
- Keep patterns under 18 lines and under 1200 characters.
- Use Strudel functions: note(), s(), stack(), cat(), seq(), .jux(), .rev(), .slow(), .fast(), .lpf(), .hpf(), .gain(), .delay(), .room(), .pan(), .struct(), .euclid(), .sometimes(), .every(), etc.
- Available sounds include: piano, sawtooth, sine, square, triangle, bd, sd, hh, cp, oh, cr, cy, tom, rim, click, noise
- Mini-notation patterns go in quotes: "c3 e3 g3", "bd sd", "<c3 e3 g3>/4"
- IMPORTANT: Mini-notation strings must ONLY contain note names, numbers, spaces, and mini-notation operators (< > / * [ ] , ~). NEVER put dots, method calls, or JS expressions inside quoted mini-notation strings.
- The code must be a single valid JavaScript expression (no variable declarations, no semicolons at the end).
- NEVER use import statements or require().`;

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function getComplexity(code) {
  const lines = code.split('\n').length;
  const chars = code.length;
  const depth = Math.max(...code.split('').reduce((acc, c) => {
    const last = acc[acc.length - 1] || 0;
    if (c === '(' || c === '{' || c === '[') acc.push(last + 1);
    else if (c === ')' || c === '}' || c === ']') acc.push(Math.max(0, last - 1));
    else acc.push(last);
    return acc;
  }, [0]));
  const stacks = (code.match(/\.stack\(|stack\(/g) || []).length;
  return { lines, chars, depth, stacks };
}

function validatePattern(code) {
  if (!code || typeof code !== 'string') return false;
  if (code.trim().length === 0) return false;
  if (code.length > MAX_PATTERN_LENGTH) return false;

  const { lines, depth } = getComplexity(code);
  if (lines > MAX_PATTERN_LINES) return false;
  if (depth > MAX_NESTING_DEPTH) return false;

  // Reject obvious non-strudel code
  if (code.includes('import ') || code.includes('require(') || code.includes('process.')) {
    return false;
  }

  try {
    parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    return true;
  } catch {
    // Strudel patterns are expressions - try wrapping
    try {
      parse(`(${code})`, { ecmaVersion: 'latest', sourceType: 'module' });
      return true;
    } catch {
      return false;
    }
  }
}

function parseResponse(text) {
  const planMatch = text.match(/<plan>([\s\S]*?)<\/plan>/);
  const codeMatch = text.match(/<code>([\s\S]*?)<\/code>/);

  let code = codeMatch ? codeMatch[1].trim() : text.trim();
  // Strip markdown fences if present
  code = code.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/i, '').trim();

  return {
    plan: planMatch ? planMatch[1].trim() : '',
    code,
  };
}

function buildMessages() {
  const messages = [];

  // Build conversation from history
  for (const turn of turnHistory.slice(-HISTORY_SIZE)) {
    // Reconstruct what the user message looked like
    let userContent = `Turn ${turn.turn}.\nCurrent pattern:\n\`\`\`\n${turn.code}\n\`\`\`\n`;
    if (turn.suggestions?.length > 0) {
      userContent += `\nSuggestions:\n${turn.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    }
    messages.push({ role: 'user', content: userContent });
    messages.push({
      role: 'assistant',
      content: `<plan>\n${turn.plan || 'Continuing evolution.'}\n</plan>\n<code>\n${turn.code}\n</code>`,
    });
  }

  // Current turn
  const complexity = getComplexity(currentPattern);
  const isComplex = complexity.lines > 15 || complexity.chars > 1000 || complexity.stacks > 3;

  const turnsUntilThemeChange = THEME_INTERVAL - (turnNumber % THEME_INTERVAL);

  let userMessage = `Turn ${turnNumber + 1}.\nTheme: "${currentTheme}" (changes in ${turnsUntilThemeChange} turns)\n\nCurrent pattern (${complexity.lines} lines, ${complexity.chars} chars, ${complexity.stacks} stack layers):\n\`\`\`\n${currentPattern}\n\`\`\`\n`;

  if (currentPlan) {
    userMessage += `\nYour plan from last turn:\n${currentPlan}\n`;
  }

  if (lastEvalError) {
    userMessage += `\nERROR: Your last pattern failed to play in the browser. The error was:\n"${lastEvalError.error}"\nFor the code:\n\`\`\`\n${lastEvalError.code}\n\`\`\`\nFix this issue in your next pattern. Avoid putting JS syntax (dots, method calls) inside mini-notation strings.\n`;
    lastEvalError = null;
  }

  if (isComplex) {
    userMessage += `\nWARNING: The pattern is getting complex. SIMPLIFY — remove layers, reduce nesting, strip effects. Less is more.\n`;
  }

  // Age suggestions and collect active ones
  const activeSuggestions = [];
  const surviving = [];
  for (const s of pendingSuggestions) {
    activeSuggestions.push({ text: s.text, age: SUGGESTION_TTL - s.turnsLeft + 1 });
    s.turnsLeft--;
    if (s.turnsLeft > 0) surviving.push(s);
  }
  pendingSuggestions = surviving;

  if (activeSuggestions.length > 0) {
    userMessage += `\nAudience suggestions:\n`;
    activeSuggestions.forEach((s, i) => {
      const label = s.age === 1 ? 'new' : `${s.age} turns ago`;
      userMessage += `${i + 1}. [${label}] ${s.text}\n`;
    });
    userMessage += `\nIncorporate these gradually over multiple turns. You don't have to address all at once.`;
  } else {
    userMessage += `\nNo audience suggestions. Evolve the pattern on your own — surprise us!`;
  }

  messages.push({ role: 'user', content: userMessage });
  return messages;
}

async function generateNextPattern() {
  const messages = buildMessages();

  try {
    const response = await anthropic.messages.create({
      model: adminSettings.model || 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    // Track token usage by model
    const today = new Date().toISOString().slice(0, 10);
    const usedModel = adminSettings.model || 'claude-sonnet-4-20250514';
    if (!tokenUsage[today]) tokenUsage[today] = {};
    if (!tokenUsage[today][usedModel]) tokenUsage[today][usedModel] = { input: 0, output: 0, requests: 0 };
    tokenUsage[today][usedModel].input += response.usage?.input_tokens || 0;
    tokenUsage[today][usedModel].output += response.usage?.output_tokens || 0;
    tokenUsage[today][usedModel].requests += 1;
    saveUsage();

    const { plan, code } = parseResponse(response.content[0].text);

    if (validatePattern(code)) {
      // Record this turn
      const turnSuggestions = pendingSuggestions
        .filter(s => s.turnsLeft === SUGGESTION_TTL - 1)
        .map(s => s.text);

      turnNumber++;
      currentPlan = plan;
      currentPattern = code;

      turnHistory.push({
        turn: turnNumber,
        code: currentPattern,
        plan: currentPlan,
        suggestions: turnSuggestions,
      });
      // Trim history
      if (turnHistory.length > HISTORY_SIZE) {
        turnHistory = turnHistory.slice(-HISTORY_SIZE);
      }

      // Rotate theme every N turns
      if (turnNumber % THEME_INTERVAL === 0) {
        const oldTheme = currentTheme;
        currentTheme = generateTheme();
        console.log(`[${new Date().toISOString()}] Theme changed: "${oldTheme}" → "${currentTheme}"`);
      }

      saveState();
      logPattern(turnNumber, currentPlan, currentPattern, currentTheme);
      console.log(`[${new Date().toISOString()}] Turn ${turnNumber} — pattern updated (theme: "${currentTheme}", plan: ${plan.slice(0, 60)}...)`);
      broadcast('pattern', { code: currentPattern, theme: currentTheme, plan: currentPlan });
    } else {
      console.log(`[${new Date().toISOString()}] Invalid pattern rejected, keeping current`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] LLM error:`, err.message);
  }

}

function startLoop() {
  if (loopTimer) return;
  console.log('Starting LLM loop (active clients connected)');
  loopTimer = setInterval(generateNextPattern, LOOP_INTERVAL);
}

function stopLoop() {
  if (!loopTimer) return;
  console.log('Stopping LLM loop (no active clients)');
  clearInterval(loopTimer);
  loopTimer = null;
}

// WebSocket handling
wss.on('connection', (ws) => {
  activeClients++;
  console.log(`Client connected (${activeClients} active)`);

  // Send current state
  ws.send(JSON.stringify({
    type: 'init',
    code: currentPattern,
    theme: currentTheme,
    plan: currentPlan,
    suggestionsEnabled: adminSettings.suggestionsEnabled,
    themeUiEnabled: adminSettings.themeUiEnabled,
  }));

  if (activeClients === 1) startLoop();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'eval_error' && msg.error) {
        lastEvalError = { error: msg.error.slice(0, 200), code: (msg.code || '').slice(0, 500) };
        console.log(`[${new Date().toISOString()}] Client eval error: ${msg.error}`);
      } else if (msg.type === 'suggestion' && typeof msg.text === 'string') {
        const text = msg.text.trim().slice(0, 280);
        if (adminSettings.suggestionsEnabled && text.length > 0 && pendingSuggestions.length < MAX_SUGGESTIONS) {
          pendingSuggestions.push({ text, turnsLeft: SUGGESTION_TTL });
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    activeClients--;
    console.log(`Client disconnected (${activeClients} active)`);
    if (activeClients === 0) stopLoop();
  });
});

// Admin auth middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Endless Admin"');
  res.status(401).send('Unauthorized');
}

// Admin page
app.get('/admin', requireAuth, (req, res) => {
  // Pricing per million tokens
  const PRICING = {
    'claude-sonnet-4-20250514': { input: 3, output: 15 },
    'claude-opus-4-20250514': { input: 15, output: 75 },
    'claude-haiku-3-20250709': { input: 0.25, output: 1.25 },
  };
  function modelShort(m) {
    if (m.includes('opus')) return 'Opus';
    if (m.includes('sonnet')) return 'Sonnet';
    if (m.includes('haiku')) return 'Haiku';
    return m;
  }
  function estimateCost(model, input, output) {
    const p = PRICING[model] || PRICING['claude-sonnet-4-20250514'];
    return (input / 1_000_000) * p.input + (output / 1_000_000) * p.output;
  }

  // Last 7 days usage — flatten by day+model
  const rows = [];
  let totalInput = 0, totalOutput = 0, totalRequests = 0, totalCost = 0;
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const dayData = tokenUsage[d];
    if (!dayData) continue;
    for (const [key, u] of Object.entries(dayData)) {
      // Skip flat legacy fields (input, output, requests) — only process model-keyed entries
      if (typeof u !== 'object' || u === null) continue;
      const cost = estimateCost(key, u.input, u.output);
      rows.push({ date: d, model: modelShort(key), requests: u.requests, input: u.input, output: u.output, cost });
      totalInput += u.input; totalOutput += u.output; totalRequests += u.requests; totalCost += cost;
    }
  }

  const modelOptions = Object.entries(AVAILABLE_MODELS).map(([id, label]) =>
    `<option value="${id}" ${adminSettings.model === id ? 'selected' : ''}>${label}</option>`
  ).join('');

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>endless admin</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #111; color: #eee; padding: 20px; max-width: 700px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 20px; }
  h2 { font-size: 16px; color: #aaa; margin: 24px 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: right; border-bottom: 1px solid #333; }
  th { color: #888; font-weight: 500; }
  td:first-child, th:first-child { text-align: left; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  label { display: flex; align-items: center; gap: 10px; color: #ccc; font-size: 14px; margin-bottom: 12px; }
  select { background: #222; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 6px 10px; font-size: 14px; }
  button { background: #333; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 8px 16px; font-size: 14px; cursor: pointer; }
  button:hover { background: #444; }
  .toggle { width: 18px; height: 18px; }
  .stat { color: #4f9; font-size: 24px; font-weight: 600; }
  .stat-label { color: #888; font-size: 12px; }
  .stats-row { display: flex; gap: 24px; margin-bottom: 16px; }
  .stats-row > div { flex: 1; }
</style>
</head><body>
<h1>🎵 endless admin</h1>

<div class="card">
  <h2 style="margin-top:0">Settings</h2>
  <form method="POST" action="/admin/settings">
    <label>
      <select name="model">${modelOptions}</select>
      Model
    </label>
    <label><input type="checkbox" name="suggestionsEnabled" class="toggle" ${adminSettings.suggestionsEnabled ? 'checked' : ''}> Suggestions</label>
    <label><input type="checkbox" name="themeUiEnabled" class="toggle" ${adminSettings.themeUiEnabled ? 'checked' : ''}> Theme UI</label>
    <button type="submit">Save</button>
  </form>
</div>

<div class="card">
  <h2 style="margin-top:0">Status</h2>
  <div class="stats-row">
    <div><div class="stat">${activeClients}</div><div class="stat-label">Connected</div></div>
    <div><div class="stat">${turnNumber}</div><div class="stat-label">Turns</div></div>
    <div><div class="stat">${adminSettings.model?.split('-')[1] || '?'}</div><div class="stat-label">Model</div></div>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Current Theme</h2>
  <p style="font-size:18px;color:#f0c040;margin:0">"${currentTheme}"</p>
  <p style="font-size:12px;color:#666;margin-top:8px">Changes every ${THEME_INTERVAL} turns (${THEME_INTERVAL - (turnNumber % THEME_INTERVAL)} turns remaining)</p>
</div>

<div class="card">
  <h2 style="margin-top:0">Plan</h2>
  <p style="font-size:13px;color:#aaa;margin:0;font-style:italic">${currentPlan || '(none yet)'}</p>
</div>

<div class="card">
  <h2 style="margin-top:0">Send Suggestion</h2>
  <form method="POST" action="/admin/suggest" style="display:flex;gap:8px">
    <input type="text" name="text" placeholder="e.g. make it more jazzy..." maxlength="280" style="flex:1;background:#222;color:#eee;border:1px solid #444;border-radius:4px;padding:8px 12px;font-size:14px">
    <button type="submit">Send</button>
  </form>
  <p style="font-size:12px;color:#666;margin-top:8px">${pendingSuggestions.length} pending suggestion${pendingSuggestions.length !== 1 ? 's' : ''}</p>
</div>

<div class="card">
  <h2 style="margin-top:0">Token Usage (7 days)</h2>
  <table>
    <tr><th>Date</th><th>Model</th><th>Reqs</th><th>Input</th><th>Output</th><th>Cost</th></tr>
    ${rows.map(r => `<tr><td>${r.date}</td><td>${r.model}</td><td>${r.requests.toLocaleString()}</td><td>${r.input.toLocaleString()}</td><td>${r.output.toLocaleString()}</td><td>$${r.cost.toFixed(4)}</td></tr>`).join('')}
    ${rows.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:#666">No usage yet</td></tr>' : ''}
    <tr style="border-top:2px solid #555;font-weight:600"><td>Total</td><td></td><td>${totalRequests.toLocaleString()}</td><td>${totalInput.toLocaleString()}</td><td>${totalOutput.toLocaleString()}</td><td>$${totalCost.toFixed(4)}</td></tr>
  </table>
</div>

</body></html>`);
});

// Admin suggestion (always works regardless of public toggle)
app.post('/admin/suggest', requireAuth, (req, res) => {
  const text = (req.body.text || '').trim().slice(0, 280);
  if (text.length > 0 && pendingSuggestions.length < MAX_SUGGESTIONS) {
    pendingSuggestions.push({ text, turnsLeft: SUGGESTION_TTL });
  }
  res.redirect('/admin');
});

// Admin settings update
app.post('/admin/settings', requireAuth, (req, res) => {
  adminSettings.model = req.body.model || adminSettings.model;
  adminSettings.suggestionsEnabled = req.body.suggestionsEnabled === 'on';
  adminSettings.themeUiEnabled = req.body.themeUiEnabled === 'on';
  saveSettings();
  res.redirect('/admin');
});

// Serve static files
app.use(express.static(join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log(`Endless Song running at http://localhost:${PORT}`);
});
