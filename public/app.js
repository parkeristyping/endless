const editor = document.getElementById('strudel');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const suggestionsList = document.getElementById('suggestions-list');
const themeEl = document.getElementById('theme');
const planTextEl = document.getElementById('plan-text');
const splash = document.getElementById('splash');
const appEl = document.getElementById('app');

let ws;
let started = false;
let isPlaying = false;
let pendingCode = null;

function waitForEditor() {
  return new Promise((resolve) => {
    function check() {
      if (editor && editor.editor) resolve();
      else setTimeout(check, 200);
    }
    check();
  });
}

async function startAudio() {
  if (started) return;
  started = true;
  splash.classList.add('hidden');
  appEl.classList.remove('hidden');

  await waitForEditor();

  // If we received a pattern before the user clicked, apply it now
  if (pendingCode) {
    await updatePattern(pendingCode);
    pendingCode = null;
  }
}

// Expose globally for the onclick handler
window.startAudio = startAudio;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    console.log('Connected to server');
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'init':
        updatePattern(msg.code);
        if (msg.theme) themeEl.textContent = msg.theme;
        if (msg.plan) planTextEl.textContent = msg.plan;
        if (!msg.suggestionsEnabled) {
          const chatPanel = document.getElementById('chat-panel');
          if (chatPanel) chatPanel.style.display = 'none';
        }
        if (!msg.themeUiEnabled) {
          const themeSpan = document.getElementById('theme');
          if (themeSpan) themeSpan.style.display = 'none';
        }
        break;
      case 'pattern':
        updatePattern(msg.code);
        if (msg.theme) themeEl.textContent = msg.theme;
        if (msg.plan) planTextEl.textContent = msg.plan;
        clearSuggestions();
        break;
    }
  };

  ws.onclose = () => {
    console.log('Disconnected, reconnecting in 3s...');
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();
}

async function tryEvaluate(code, retries = 3) {
  editor.editor.setCode(code);
  for (let i = 0; i < retries; i++) {
    try {
      await editor.editor.evaluate();
      return true;
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw e;
      }
    }
  }
}

async function updatePattern(code) {
  // If user hasn't clicked to start yet, queue the pattern
  if (!started) {
    pendingCode = code;
    return;
  }

  if (!editor) return;

  // Wait for strudel-editor to be ready
  if (editor.editor) {
    const previousCode = editor.editor.code;
    try {
      if (!isPlaying) {
        editor.editor.toggle();
        isPlaying = true;
        // Small delay to let the audio context initialize before evaluating
        await new Promise(r => setTimeout(r, 200));
      }
      await tryEvaluate(code);
    } catch (e) {
      console.warn('Pattern eval failed, reverting:', e.message);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'eval_error', error: e.message, code }));
      }
      if (previousCode) {
        await tryEvaluate(previousCode).catch(() => {});
      }
    }
  } else {
    setTimeout(() => updatePattern(code), 500);
  }
}

function clearSuggestions() {
  suggestionsList.innerHTML = '';
}

function addSuggestion(text) {
  const div = document.createElement('div');
  div.className = 'suggestion';
  div.textContent = text;
  suggestionsList.appendChild(div);
  suggestionsList.scrollTop = suggestionsList.scrollHeight;
}

// Chat form
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({ type: 'suggestion', text }));
  addSuggestion(text);
  chatInput.value = '';
});

// Start
connect();
