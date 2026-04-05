const editor = document.getElementById('strudel');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const suggestionsList = document.getElementById('suggestions-list');
const countdownEl = document.getElementById('countdown');
const listenersEl = document.getElementById('listeners');
const splash = document.getElementById('splash');
const appEl = document.getElementById('app');

let ws;
let nextUpdateTime = null;
let countdownInterval = null;
let started = false;
let pendingCode = null;

function startAudio() {
  if (started) return;
  started = true;
  splash.classList.add('hidden');
  appEl.classList.remove('hidden');

  // If we received a pattern before the user clicked, apply it now
  if (pendingCode) {
    updatePattern(pendingCode);
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
        setNextUpdate(msg.nextUpdate);
        break;
      case 'pattern':
        updatePattern(msg.code);
        clearSuggestions();
        break;
      case 'tick':
        setNextUpdate(msg.nextUpdate);
        break;
    }
  };

  ws.onclose = () => {
    console.log('Disconnected, reconnecting in 3s...');
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();
}

function updatePattern(code) {
  // If user hasn't clicked to start yet, queue the pattern
  if (!started) {
    pendingCode = code;
    return;
  }

  if (!editor) return;

  // Wait for strudel-editor to be ready
  if (editor.editor) {
    editor.editor.setCode(code);
    editor.editor.evaluate();
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

function setNextUpdate(timestamp) {
  nextUpdateTime = timestamp;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(updateCountdown, 1000);
  updateCountdown();
}

function updateCountdown() {
  if (!nextUpdateTime) return;
  const remaining = Math.max(0, Math.ceil((nextUpdateTime - Date.now()) / 1000));
  countdownEl.textContent = `next update in ${remaining}s`;
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
