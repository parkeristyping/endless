import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import { parse } from 'acorn';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const anthropic = new Anthropic();

const PORT = process.env.PORT || 3000;
const LOOP_INTERVAL = 30_000;
const MAX_SUGGESTIONS = 50;
const SAMPLE_SIZE = 20;
const MAX_PATTERN_LENGTH = 2000;

let currentPattern = `note("<c3 e3 g3 b3>/4")
  .s("piano")
  .legato(0.9)
  .stack(
    s("bd sd:2 bd sd:2").gain(0.8),
    s("hh*8").gain(0.4)
  )`;

let pendingSuggestions = [];
let activeClients = 0;
let loopTimer = null;

const SYSTEM_PROMPT = `You are a Strudel live coder performing an endless evolving musical piece for a live audience.

RULES:
- Output ONLY valid Strudel/JavaScript code. No markdown fences, no explanations, no comments.
- Evolve the pattern GRADUALLY - change 1-3 things at a time, don't rewrite everything.
- Keep the music interesting and musical. Vary rhythm, melody, timbre, and effects over time.
- Use Strudel functions: note(), s(), stack(), cat(), seq(), .jux(), .rev(), .slow(), .fast(), .lpf(), .hpf(), .gain(), .delay(), .room(), .pan(), .struct(), .euclid(), .sometimes(), .every(), etc.
- Available sounds include: piano, sawtooth, sine, square, triangle, bd, sd, hh, cp, oh, cr, cy, tom, rim, click, noise
- Mini-notation patterns go in quotes: "c3 e3 g3", "bd sd", "<c3 e3 g3>/4"
- Keep patterns under 1500 characters.
- The output must be a single valid JavaScript expression (no variable declarations, no semicolons at the end).
- NEVER use import statements or require().`;

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function validatePattern(code) {
  if (!code || typeof code !== 'string') return false;
  if (code.trim().length === 0) return false;
  if (code.length > MAX_PATTERN_LENGTH) return false;

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

async function generateNextPattern() {
  // Sample suggestions
  const sampled = pendingSuggestions.slice(0, SAMPLE_SIZE);
  pendingSuggestions = [];

  let userMessage = `Current pattern:\n\`\`\`\n${currentPattern}\n\`\`\`\n\n`;

  if (sampled.length > 0) {
    userMessage += `Audience suggestions:\n`;
    sampled.forEach((s, i) => {
      userMessage += `${i + 1}. ${s}\n`;
    });
    userMessage += `\nConsider these suggestions as inspiration for evolving the pattern. You don't have to follow all of them.`;
  } else {
    userMessage += `No audience suggestions this round. Evolve the pattern on your own - surprise us!`;
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    let newPattern = response.content[0].text.trim();

    // Strip markdown fences if the model includes them despite instructions
    newPattern = newPattern.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/i, '').trim();

    if (validatePattern(newPattern)) {
      currentPattern = newPattern;
      console.log(`[${new Date().toISOString()}] Pattern updated (${sampled.length} suggestions)`);
      broadcast('pattern', { code: currentPattern });
    } else {
      console.log(`[${new Date().toISOString()}] Invalid pattern rejected, keeping current`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] LLM error:`, err.message);
  }

  // Notify clients of next update time
  broadcast('tick', { nextUpdate: Date.now() + LOOP_INTERVAL });
}

function startLoop() {
  if (loopTimer) return;
  console.log('Starting LLM loop (active clients connected)');
  broadcast('tick', { nextUpdate: Date.now() + LOOP_INTERVAL });
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
    nextUpdate: loopTimer ? Date.now() + LOOP_INTERVAL : Date.now() + LOOP_INTERVAL,
  }));

  if (activeClients === 1) startLoop();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'suggestion' && typeof msg.text === 'string') {
        const text = msg.text.trim().slice(0, 280);
        if (text.length > 0 && pendingSuggestions.length < MAX_SUGGESTIONS) {
          pendingSuggestions.push(text);
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

// Serve static files
app.use(express.static(join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log(`Endless Song running at http://localhost:${PORT}`);
});
