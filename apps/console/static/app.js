// ShopVoice simulator client: push-to-talk (Web Speech API) or typed input,
// POST /api/turn, speak the reply (Polly via /api/tts, else speechSynthesis),
// render tool calls and confirmation cards. DOM is built with textContent only.

const $ = (id) => document.getElementById(id);
const screen = $('screen');
const stateLabel = $('state-label');
const heard = $('heard');
const reply = $('reply');
const calls = $('calls');
const callsEmpty = $('calls-empty');
const confirmCard = $('confirm-card');
const doneCard = $('done-card');
const mic = $('mic');

let conversationId = null;
let accessCode = sessionStorage.getItem('shopvoice-access') ?? '';
let config = null;
let muted = false;
let busy = false;
let confirmTimer = null;
let turnIndex = 0;
const timeline = [];

const STATE_TEXT = {
  idle: 'Hold the button or press Space, then speak',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…'
};

function setState(state) {
  screen.dataset.state = state;
  stateLabel.textContent = STATE_TEXT[state] ?? '';
  mic.classList.toggle('active', state === 'listening');
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function api(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (accessCode) headers['x-sim-access'] = accessCode;
  const res = await fetch(path, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.status === 401) {
    await askAccessCode();
    return api(path, body);
  }
  return res;
}

function askAccessCode() {
  return new Promise((resolve) => {
    const dialog = $('access-dialog');
    $('access-form').onsubmit = () => {
      accessCode = $('access-code').value.trim();
      sessionStorage.setItem('shopvoice-access', accessCode);
      resolve();
    };
    dialog.showModal();
  });
}

const IRREGULAR = { loaf: 'loaves', box: 'boxes', bunch: 'bunches' };
function plural(unit, qty) {
  if (!unit || qty === 1) return unit ?? '';
  return IRREGULAR[unit] ?? (/(s|x|ch|sh)$/.test(unit) ? `${unit}es` : `${unit}s`);
}

function money(value, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: currency === 'VND' ? 0 : 2 }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

async function loadConfig() {
  try {
    const res = await api('/api/config');
    config = await res.json();
    $('chip-brain').textContent = config.brain === 'bedrock' ? `Bedrock · ${config.model}` : 'Offline rules brain';
    $('chip-brain').className = `chip ${config.brain === 'bedrock' ? 'ok' : 'warn'}`;
    $('chip-voice').textContent = config.tts === 'polly' ? `Polly · ${config.voice}` : 'Browser voice';
    $('chip-voice').className = `chip ${config.tts === 'polly' ? 'ok' : 'warn'}`;
    const ready = await fetch('/readyz');
    const readyBody = await ready.json();
    $('chip-mcp').textContent = ready.ok ? `MCP · ${readyBody.tools} tools` : 'MCP unreachable';
    $('chip-mcp').className = `chip ${ready.ok ? 'ok' : 'warn'}`;
  } catch {
    $('chip-mcp').textContent = 'Offline';
  }
}

function renderToolCalls(toolCalls) {
  if (toolCalls.length === 0) return;
  callsEmpty.hidden = true;
  turnIndex += 1;
  for (const call of toolCalls) {
    const args = JSON.stringify(call.args);
    const item = el('li', { class: `call${call.isError ? ' err' : ''}` },
      el('div', { class: 'call-top' },
        el('span', { class: 'call-name' }, call.name),
        el('span', { class: 'call-ms' }, call.blockedByHost ? 'blocked by host' : `${call.latencyMs} ms`)),
      el('pre', { class: 'call-args' }, args === '{}' ? '(no arguments)' : args),
      el('p', { class: 'call-spoken' }, call.spoken));
    if (call.structured) {
      const details = el('details', {}, el('summary', {}, 'structuredContent'), el('pre', { class: 'call-json' }, JSON.stringify(call.structured, null, 2)));
      item.append(details);
    }
    calls.prepend(item);
  }
  calls.prepend(el('li', { class: 'turn-sep' }, `Turn ${turnIndex}`));
}

function renderConfirmCard(card) {
  clearInterval(confirmTimer);
  doneCard.hidden = true;
  const body = $('confirm-body');
  body.replaceChildren();
  for (const draft of card.drafts ?? []) {
    body.append(el('p', { class: 'supplier' }, draft.supplier_name));
    const table = el('table');
    for (const line of draft.lines ?? []) {
      table.append(el('tr', {}, el('td', {}, line.name), el('td', { class: 'num' }, `${line.qty} ${plural(line.unit, line.qty)}`)));
    }
    body.append(table);
  }
  body.append(el('div', { class: 'total' }, el('span', {}, 'Estimated total'), el('span', {}, money(card.total, card.currency))));
  confirmCard.hidden = false;
  const expires = Date.parse(card.expires_at);
  const tick = () => {
    const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
    const timer = $('confirm-timer');
    timer.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} to confirm` : 'expired';
    timer.classList.toggle('low', left < 60);
    if (left === 0) clearInterval(confirmTimer);
  };
  tick();
  confirmTimer = setInterval(tick, 1000);
}

function renderOrderResult(result) {
  clearInterval(confirmTimer);
  confirmCard.hidden = true;
  if (result.status !== 'confirmed' && result.status !== 'already_confirmed') return;
  const body = $('done-body');
  body.replaceChildren();
  for (const d of result.drafts ?? []) {
    body.append(el('div', { class: 'total' }, el('span', {}, d.supplier_name), el('span', {}, money(d.total, result.currency))));
  }
  doneCard.hidden = false;
}

async function speak(text) {
  if (muted || !text) return;
  setState('speaking');
  try {
    const res = await api('/api/tts', { text });
    if (res.status === 200) {
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
      return;
    }
  } catch {
    // fall through to the browser voice
  }
  if ('speechSynthesis' in window && speechSynthesis.getVoices().length > 0) {
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.onend = resolve;
      u.onerror = resolve;
      speechSynthesis.speak(u);
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, Math.min(6000, 400 + text.split(/\s+/).length * 300)));
  }
}

async function sendTurn(text) {
  if (busy || !text.trim()) return null;
  busy = true;
  heard.textContent = text;
  setState('thinking');
  const startedAt = performance.now();
  try {
    const res = await api('/api/turn', { conversationId, text });
    const data = await res.json();
    if (!res.ok) {
      reply.textContent = data.reply ?? 'Sorry, something went wrong.';
      return data;
    }
    conversationId = data.conversationId;
    reply.textContent = data.reply;
    renderToolCalls(data.toolCalls ?? []);
    if (data.confirmationCard) renderConfirmCard(data.confirmationCard);
    if (data.orderResult) renderOrderResult(data.orderResult);
    timeline.push({ text, reply: data.reply, tools: (data.toolCalls ?? []).map((c) => c.name), at: Date.now(), roundTripMs: Math.round(performance.now() - startedAt) });
    await speak(data.reply);
    return data;
  } catch {
    reply.textContent = "Sorry, I couldn't reach the shop just now.";
    return null;
  } finally {
    setState('idle');
    busy = false;
  }
}

// --- Push-to-talk (Web Speech API) ---
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognizer = null;
let finalText = '';

function startListening() {
  if (busy) return;
  if (!Recognition) {
    $('text-input').focus();
    stateLabel.textContent = 'Speech recognition is not available in this browser: type instead';
    return;
  }
  finalText = '';
  recognizer = new Recognition();
  recognizer.lang = 'en-US';
  recognizer.interimResults = true;
  recognizer.continuous = true;
  recognizer.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    heard.textContent = (finalText + interim).trim();
  };
  recognizer.onerror = () => setState('idle');
  recognizer.start();
  setState('listening');
}

function stopListening() {
  if (!recognizer) return;
  const r = recognizer;
  recognizer = null;
  r.onend = () => {
    const text = (finalText || heard.textContent || '').trim();
    if (text) void sendTurn(text);
    else setState('idle');
  };
  r.stop();
}

mic.addEventListener('pointerdown', startListening);
mic.addEventListener('pointerup', stopListening);
mic.addEventListener('pointerleave', stopListening);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    startListening();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT') stopListening();
});

$('text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('text-input');
  const text = input.value;
  input.value = '';
  void sendTurn(text);
});
for (const btn of document.querySelectorAll('.suggest')) {
  btn.addEventListener('click', () => void sendTurn(btn.textContent ?? ''));
}
$('btn-confirm').addEventListener('click', () => void sendTurn('Yes, confirm'));
$('btn-cancel').addEventListener('click', () => void sendTurn('No, cancel'));
$('btn-reset').addEventListener('click', async () => {
  if (conversationId) await api('/api/reset', { conversationId });
  conversationId = null;
  calls.replaceChildren();
  callsEmpty.hidden = false;
  confirmCard.hidden = true;
  doneCard.hidden = true;
  heard.textContent = '';
  reply.textContent = 'New conversation. What would you like to know?';
});

// Scripted driver for demos and the video recorder: simulates "hearing" the
// utterance word by word (visible listening state), then runs the turn.
window.shopvoice = {
  async say(text, { wordDelayMs = 180 } = {}) {
    setState('listening');
    heard.textContent = '';
    for (const word of text.split(/\s+/)) {
      heard.textContent = `${heard.textContent} ${word}`.trim();
      await new Promise((r) => setTimeout(r, wordDelayMs));
    }
    await new Promise((r) => setTimeout(r, 250));
    return sendTurn(text);
  },
  setMuted(value) {
    muted = Boolean(value);
  },
  timeline
};

setState('idle');
void loadConfig();
