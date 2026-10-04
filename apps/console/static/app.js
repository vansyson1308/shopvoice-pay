// ShopVoice Pay console. Talk (push-to-talk or typed, POST /api/turn, spoken
// reply), Approvals, Ledger (AG Grid), Rules & PayPal, Suppliers (AG Grid).
// Everything shown comes from the console's own API; the browser never holds
// the shop's credential. DOM is built with textContent only.

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
const NONCE = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? '';

let conversationId = null;
let accessCode = sessionStorage.getItem('shopvoice-access') ?? '';
let config = null;
let overview = null;
let muted = false;
let busy = false;
let confirmTimer = null;
let turnIndex = 0;
let ledgerGrid = null;
let suppliersGrid = null;
const pollers = new Map();
const timeline = [];

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

function cents(minor, currency = 'USD') {
  if (typeof minor !== 'number') return '–';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

function money(value, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

function when(iso, withTime = true) {
  if (!iso) return '–';
  const tz = overview?.shop?.timezone ?? 'America/New_York';
  const opts = withTime ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz } : { month: 'short', day: 'numeric', timeZone: tz };
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(iso));
}

const STATUS = {
  pending_approval: ['Waiting for you', 'warn'],
  authorized: ['Held', 'info'],
  partially_captured: ['Partly charged', 'info'],
  captured: ['Charged', 'ok'],
  voided: ['Released', 'muted'],
  refunded: ['Refunded', 'muted'],
  failed: ['Not placed', 'err'],
  blocked: ['Blocked by rules', 'err']
};

function statusChip(status, payment = null) {
  const [label, tone] = STATUS[status] ?? [status, 'muted'];
  const text = status === 'pending_approval' && payment?.waiting_in_paypal ? 'Waiting in PayPal' : label;
  return el('span', { class: `status ${tone}` }, text);
}

function toast(message, tone = 'ok') {
  const t = $('toast');
  t.textContent = message;
  t.className = `toast ${tone}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (accessCode) headers['x-sim-access'] = accessCode;
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (res.status === 401) {
    const data = await res.clone().json().catch(() => ({}));
    if (data.error === 'access_code_required') {
      await askAccessCode();
      return api(path, { method, body });
    }
    if (data.error === 'no_session') showLanding();
  }
  return res;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message ?? data.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data;
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

// ---------- tabs ----------

const TABS = ['talk', 'approvals', 'ledger', 'policy', 'suppliers'];

function setTab(name, { focus = false } = {}) {
  const tab = TABS.includes(name) ? name : 'talk';
  for (const t of TABS) {
    const button = $(`tab-${t}`);
    const selected = t === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`panel-${t}`).hidden = !selected;
  }
  if (focus) $(`tab-${tab}`).focus();
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`);
  if (tab === 'approvals') void loadApprovals();
  if (tab === 'ledger') void loadLedger();
  if (tab === 'policy') void loadPolicy();
  if (tab === 'suppliers') void loadSuppliers();
}

for (const t of TABS) {
  $(`tab-${t}`).addEventListener('click', () => setTab(t));
  $(`tab-${t}`).addEventListener('keydown', (e) => {
    const i = TABS.indexOf(t);
    if (e.key === 'ArrowRight') setTab(TABS[(i + 1) % TABS.length], { focus: true });
    else if (e.key === 'ArrowLeft') setTab(TABS[(i + TABS.length - 1) % TABS.length], { focus: true });
    else if (e.key === 'Home') setTab(TABS[0], { focus: true });
    else if (e.key === 'End') setTab(TABS[TABS.length - 1], { focus: true });
    else return;
    e.preventDefault();
  });
}
window.addEventListener('hashchange', () => setTab(location.hash.slice(1)));

// ---------- overview, chips, landing ----------

function showLanding() {
  $('landing').hidden = false;
  document.querySelector('.tabs').hidden = true;
  for (const t of TABS) $(`panel-${t}`).hidden = true;
}

async function loadOverview() {
  overview = await apiJson('/api/owner/overview');
  $('shop-name').textContent = overview.shop.name;
  $('shop-today').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${overview.shop.today}T12:00:00Z`));
  const sim = overview.paypal.mode === 'mock';
  const chip = $('chip-paypal');
  chip.textContent = `${sim ? 'Simulated PayPal' : 'PayPal sandbox'} · ${overview.paypal.connected ? overview.paypal.account : 'not connected'}`;
  chip.className = `chip ${overview.paypal.connected ? 'ok' : 'warn'}`;
  $('honesty').textContent = sim
    ? 'Demo: PayPal is simulated in this deployment (mock mode, calibrated to the PayPal sandbox). No money moves. Shop and suppliers are fictional.'
    : 'Demo: payments run in the PayPal sandbox. No real money moves. Shop and suppliers are fictional.';
  $('btn-reset-demo').hidden = !overview.demo_reset_available;
  setApprovalCount(overview.spend.pending_approvals);
}

function setApprovalCount(n) {
  const badge = $('approvals-count');
  badge.textContent = String(n);
  badge.hidden = !n;
  $('tab-approvals').setAttribute('aria-label', n ? `Approvals, ${n} waiting` : 'Approvals');
}

async function loadConfig() {
  const res = await api('/api/config');
  config = await res.json();
  const claude = config.brain === 'claude';
  $('chip-brain').textContent = claude ? `Claude · ${config.model}` : 'Offline rules brain';
  $('chip-brain').className = `chip ${claude ? 'ok' : 'warn'}`;
  try {
    const ready = await fetch('/readyz');
    const body = await ready.json();
    $('chip-mcp').textContent = ready.ok ? `MCP · ${body.tools ? `${body.tools} tools` : 'ready'}` : 'MCP unreachable';
    $('chip-mcp').className = `chip ${ready.ok ? 'ok' : 'warn'}`;
  } catch {
    $('chip-mcp').textContent = 'MCP unreachable';
  }
  return config;
}

// ---------- Talk ----------

const STATE_TEXT = { idle: 'Hold the button or press Space, then speak', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };

function setState(state) {
  screen.dataset.state = state;
  stateLabel.textContent = STATE_TEXT[state] ?? '';
  mic.classList.toggle('active', state === 'listening');
}

const IRREGULAR = { loaf: 'loaves', box: 'boxes', bunch: 'bunches' };
function plural(unit, qty) {
  if (!unit || qty === 1) return unit ?? '';
  return IRREGULAR[unit] ?? (/(s|x|ch|sh)$/.test(unit) ? `${unit}es` : `${unit}s`);
}

function renderToolCalls(toolCalls) {
  if (toolCalls.length === 0) return;
  callsEmpty.hidden = true;
  turnIndex += 1;
  for (const call of toolCalls) {
    const args = JSON.stringify(call.args);
    const hostCall = call.name.endsWith('_payment');
    const item = el('li', { class: `call${call.isError ? ' err' : ''}${hostCall ? ' host' : ''}` },
      el('div', { class: 'call-top' },
        el('span', { class: 'call-name' }, call.name),
        el('span', { class: 'call-ms' }, call.blockedByHost ? (hostCall ? 'host, not the model' : 'blocked by host') : `${call.latencyMs} ms`)),
      el('pre', { class: 'call-args' }, args === '{}' ? '(no arguments)' : args),
      el('p', { class: 'call-spoken' }, call.spoken));
    if (call.structured) item.append(el('details', {}, el('summary', {}, 'structuredContent'), el('pre', { class: 'call-json' }, JSON.stringify(call.structured, null, 2))));
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
    for (const line of draft.lines ?? []) table.append(el('tr', {}, el('td', {}, line.name), el('td', { class: 'num' }, `${line.qty} ${plural(line.unit, line.qty)}`)));
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
  const payments = result.payments ?? [];
  if (payments.length === 0) {
    for (const d of result.drafts ?? []) body.append(el('div', { class: 'total' }, el('span', {}, d.supplier_name), el('span', {}, money(d.total, result.currency))));
  }
  for (const p of payments) {
    body.append(el('div', { class: 'pay-row' },
      el('span', {}, p.supplier_name),
      el('span', { class: 'num' }, money(p.amount, result.currency)),
      statusChip(p.status, { waiting_in_paypal: p.approval?.state === 'waiting_in_paypal' })));
    if (p.status === 'pending_approval') body.append(el('p', { class: 'why' }, p.reasons?.[0] ?? 'Over your rules.'));
    if (p.status === 'blocked') body.append(el('p', { class: 'why err' }, p.reasons?.find((r) => !/within your rules/.test(r)) ?? 'Blocked by your rules.'));
  }
  doneCard.hidden = false;
}

async function speak(text) {
  if (muted || !text) return;
  setState('speaking');
  try {
    const res = await api('/api/tts', { method: 'POST', body: { text } });
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
    const res = await api('/api/turn', { method: 'POST', body: { conversationId, text } });
    const data = await res.json();
    if (!res.ok) {
      reply.textContent = data.reply ?? data.message ?? 'Sorry, something went wrong.';
      return data;
    }
    conversationId = data.conversationId;
    reply.textContent = data.reply;
    if (data.brainFallback) toast('Claude was unavailable for that turn, so the offline rules brain answered.', 'warn');
    renderToolCalls(data.toolCalls ?? []);
    if (data.confirmationCard) renderConfirmCard(data.confirmationCard);
    if (data.orderResult) renderOrderResult(data.orderResult);
    if (data.approvalResult) toast(data.approvalResult.decision === 'approved' ? 'Approved by voice. The money is held, not charged.' : 'Declined by voice. Nothing was charged.', data.approvalResult.ok ? 'ok' : 'warn');
    if (data.orderResult || data.approvalResult || (data.toolCalls ?? []).some((c) => c.name === 'record_delivery')) void loadOverview();
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
  if (e.code === 'Space' && !e.repeat && $('tab-talk').getAttribute('aria-selected') === 'true' && !['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    startListening();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') stopListening();
});

$('text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('text-input');
  const text = input.value;
  input.value = '';
  void sendTurn(text);
});
for (const btn of document.querySelectorAll('.suggest')) btn.addEventListener('click', () => void sendTurn(btn.textContent ?? ''));
$('btn-confirm').addEventListener('click', () => void sendTurn('Yes, confirm'));
$('btn-cancel').addEventListener('click', () => void sendTurn('No, cancel'));
$('btn-reset').addEventListener('click', async () => {
  if (conversationId) await api('/api/reset', { method: 'POST', body: { conversationId } });
  conversationId = null;
  calls.replaceChildren();
  callsEmpty.hidden = false;
  confirmCard.hidden = true;
  doneCard.hidden = true;
  heard.textContent = '';
  reply.textContent = 'New conversation. What would you like to know?';
});

// ---------- Approvals ----------

function stopPolling(id) {
  clearInterval(pollers.get(id));
  pollers.delete(id);
}

function pollPayPal(id) {
  if (pollers.has(id)) return;
  pollers.set(id, setInterval(async () => {
    try {
      const out = await apiJson(`/api/owner/payments/${id}/sync`, { method: 'POST', body: {} });
      if (out.payment.status !== 'pending_approval') {
        stopPolling(id);
        toast(out.payment.status === 'authorized' ? `${out.payment.supplier_name}: approved in PayPal. ${cents(out.payment.held_minor)} is held.` : `${out.payment.supplier_name}: ${out.payment.status_text}.`);
        void loadApprovals();
        void loadOverview();
      }
    } catch {
      // keep polling; PayPal may not have answered yet
    }
  }, 5000));
}

function approvalCard(p) {
  const expires = p.approval_expires_at ? Date.parse(p.approval_expires_at) : null;
  const expiresText = expires ? (expires > Date.now() ? `Expires ${when(p.approval_expires_at)}` : 'Expired: reorder to ask again') : '';
  const why = el('ul', { class: 'reasons' }, p.reasons.filter((r) => r.effect !== 'info').map((r) => el('li', { class: r.effect === 'block' ? 'err' : '' }, r.text)));
  const lines = el('table', { class: 'lines' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Product'), el('th', { scope: 'col', class: 'num' }, 'Qty'), el('th', { scope: 'col', class: 'num' }, 'Unit cost'))),
    el('tbody', {}, p.lines.map((l) => el('tr', {}, el('td', {}, l.name), el('td', { class: 'num' }, l.qty), el('td', { class: 'num' }, cents(l.unit_cost_minor, p.currency))))));
  const actions = el('div', { class: 'card-actions' });
  const card = el('article', { class: 'approval', 'aria-labelledby': `ap-${p.id}` },
    el('div', { class: 'card-head' },
      el('h3', { id: `ap-${p.id}` }, `${p.supplier_name} · ${cents(p.amount_minor, p.currency)}`),
      statusChip(p.status, p)),
    el('p', { class: 'muted small' }, `Requested ${when(p.created_at)}${expiresText ? ` · ${expiresText}` : ''}`),
    el('h4', {}, 'Why it needs you'), why, lines, actions);

  const busyButtons = (on) => { for (const b of actions.querySelectorAll('button')) b.disabled = on; };
  const act = async (path, done) => {
    busyButtons(true);
    try {
      const out = await apiJson(`/api/owner/approvals/${p.id}/${path}`, { method: 'POST', body: path === 'approve' ? { via: 'tap' } : {} });
      done(out);
      if (path !== 'paypal') void loadApprovals();
      void loadOverview();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      busyButtons(false);
    }
  };
  if (p.waiting_in_paypal) {
    actions.append(el('p', { class: 'muted' }, 'Waiting for your approval on PayPal…'));
    pollPayPal(p.id);
  }
  actions.append(
    el('button', { class: 'btn ghost', type: 'button', onclick: () => act('decline', () => toast(`${p.supplier_name}: declined. Nothing was charged.`)) }, 'Decline'),
    el('button', { class: 'btn', type: 'button', onclick: () => act('paypal', (out) => showPayPalLink(card, out.approve_url, p.id)) }, 'Approve in PayPal'),
    el('button', { class: 'btn primary', type: 'button', onclick: () => act('approve', (out) => toast(out.speech ?? 'Approved.')) }, 'Approve'));
  return card;
}

function showPayPalLink(card, url, id) {
  card.querySelector('.paypal-link')?.remove();
  const simulated = overview?.paypal?.mode === 'mock';
  const box = el('div', { class: 'paypal-link' });
  if (simulated) {
    box.append(el('p', {}, 'Simulated PayPal (mock mode): continue in this browser.'), el('a', { class: 'btn primary', href: url }, 'Open simulated PayPal'));
  } else {
    box.append(
      el('p', {}, 'Scan with your phone to approve on PayPal, or open the link here.'),
      el('img', { src: `/api/qr?url=${encodeURIComponent(url)}`, alt: 'QR code for the PayPal approval page', width: '180', height: '180' }),
      el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open PayPal'));
  }
  card.append(box);
  pollPayPal(id);
}

async function loadApprovals() {
  const list = $('approvals-list');
  try {
    const { approvals } = await apiJson('/api/owner/approvals');
    list.replaceChildren(...approvals.map(approvalCard));
    $('approvals-empty').hidden = approvals.length > 0;
    setApprovalCount(approvals.length);
  } catch (error) {
    if (error.status !== 401) toast(error.message, 'err');
  }
}

// ---------- AG Grid ----------

/** The console is dark; the grids match it. */
function gridTheme() {
  const g = window.agGrid;
  return g.themeQuartz.withPart(g.colorSchemeDarkBlue).withParams({ backgroundColor: '#121a2e', headerBackgroundColor: '#0f1628', accentColor: '#34d399', fontFamily: 'inherit' });
}

let gridModulesRegistered = false;
function createGrid(container, options) {
  const g = window.agGrid;
  if (!g) {
    container.replaceChildren(el('p', { class: 'empty' }, 'The table library did not load.'));
    return null;
  }
  if (!gridModulesRegistered) {
    g.ModuleRegistry.registerModules([g.AllCommunityModule]);
    gridModulesRegistered = true;
  }
  return g.createGrid(container, { theme: gridTheme(), styleNonce: NONCE, domLayout: 'autoHeight', ...options });
}

const centsCol = (field, headerName) => ({ field, headerName, type: 'rightAligned', width: 120, valueFormatter: (p) => cents(p.value, p.data?.currency) });
const APPROVED_BY = { owner_tap: 'You (console)', owner_voice: 'You (voice)', owner_paypal: 'You (PayPal)', owner_elicitation: 'You (AI app prompt)' };
const DECISION = { autopay: 'Auto-pay', step_up: 'Asked owner', blocked: 'Blocked' };

function ledgerColumns() {
  return [
    { field: 'created_at', headerName: 'Created', width: 150, sort: 'desc', valueFormatter: (p) => when(p.value) },
    { field: 'supplier_name', headerName: 'Supplier', width: 170 },
    centsCol('amount_minor', 'Amount'),
    { field: 'status', headerName: 'Status', width: 160, cellRenderer: (p) => statusChip(p.value, p.data), valueFormatter: (p) => STATUS[p.value]?.[0] ?? p.value },
    centsCol('held_minor', 'Held'),
    centsCol('charged_minor', 'Charged'),
    centsCol('released_minor', 'Released'),
    centsCol('refunded_minor', 'Refunded'),
    centsCol('settled_minor', 'Paid to supplier'),
    { field: 'decision', headerName: 'Decision', width: 120, valueFormatter: (p) => DECISION[p.value] ?? p.value },
    { colId: 'why', headerName: 'Why', flex: 1, minWidth: 260, valueGetter: (p) => (p.data?.reasons ?? []).map((r) => r.text).join(' '), tooltipValueGetter: (p) => p.value },
    { field: 'honor_period_ends_at', headerName: 'Honor period ends', width: 160, valueFormatter: (p) => when(p.value), headerTooltip: 'PayPal honors the full hold for 3 days after it was placed.' },
    { field: 'hold_expires_at', headerName: 'Hold expires', width: 150, valueFormatter: (p) => when(p.value), headerTooltip: 'A hold lapses 29 days after it was placed.' },
    { field: 'approved_by', headerName: 'Approved by', width: 150, valueFormatter: (p) => APPROVED_BY[p.value] ?? '–' }
  ];
}

async function loadLedger() {
  try {
    const { payments } = await apiJson('/api/owner/ledger');
    if (!ledgerGrid) {
      ledgerGrid = createGrid($('ledger-grid'), {
        columnDefs: ledgerColumns(),
        defaultColDef: { sortable: true, filter: true, resizable: true },
        rowData: payments,
        getRowId: (p) => p.data.id,
        pagination: true,
        paginationPageSize: 20,
        paginationPageSizeSelector: [20, 50, 100],
        // 14 columns: render them all so screen readers (and tests) see every cell.
        suppressColumnVirtualisation: true,
        onRowClicked: (e) => void openPayment(e.data.id),
        onCellKeyDown: (e) => { if (e.event?.key === 'Enter') void openPayment(e.data.id); }
      });
    } else {
      ledgerGrid.setGridOption('rowData', payments);
    }
  } catch (error) {
    if (error.status !== 401) toast(error.message, 'err');
  }
}

$('btn-ledger-refresh').addEventListener('click', () => void loadLedger());
$('btn-ledger-csv').addEventListener('click', () => ledgerGrid?.exportDataAsCsv({
  fileName: 'shopvoice-ledger.csv',
  // Plain numbers in the CSV: dollars for money columns, ISO dates.
  processCellCallback: (p) => (p.column.getColId().endsWith('_minor') && typeof p.value === 'number' ? (p.value / 100).toFixed(2) : p.value)
}));

// ---------- Payment detail ----------

async function openPayment(id) {
  const dialog = $('payment-dialog');
  const body = $('payment-body');
  body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  if (!dialog.open) dialog.showModal();
  try {
    const { payment: p, events, deliveries } = await apiJson(`/api/owner/payments/${id}`);
    $('payment-title').textContent = `${p.supplier_name} · ${cents(p.amount_minor, p.currency)}`;
    const facts = el('dl', { class: 'stats' }, [
      ['Status', statusChip(p.status, p)], ['Held', cents(p.held_minor)], ['Charged', cents(p.charged_minor)], ['Released', cents(p.released_minor)],
      ['Refunded', cents(p.refunded_minor)], ['Paid to supplier', cents(p.settled_minor)], ['Honor period ends', when(p.honor_period_ends_at)], ['Hold expires', when(p.hold_expires_at)]
    ].flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
    const why = el('ul', { class: 'reasons' }, p.reasons.map((r) => el('li', { class: r.effect === 'block' ? 'err' : '' }, r.text)));
    const history = el('ol', { class: 'timeline' }, events.map((e) => el('li', {},
      el('span', { class: 'when' }, when(e.at)),
      el('span', { class: 'what' }, `${e.kind.replaceAll('_', ' ')}${e.amountMinor ? ` · ${cents(e.amountMinor)}` : ''}`),
      el('span', { class: 'muted' }, e.reason))));
    body.replaceChildren(facts, el('h3', {}, 'Why'), why, el('h3', {}, 'Lines'),
      el('table', { class: 'lines' }, el('tbody', {}, p.lines.map((l) => el('tr', {}, el('td', {}, l.name), el('td', { class: 'num' }, l.qty), el('td', { class: 'num' }, cents(l.unit_cost_minor)))))),
      el('h3', {}, 'History'), history);
    if (deliveries.length) body.append(el('p', { class: 'muted' }, `Deliveries recorded: ${deliveries.map((d) => `${d.outcome} (${cents(d.delivered_value_minor)})`).join(', ')}`));
    if (p.held_minor > 0) body.append(deliveryForm(p));
    if (p.charged_minor > 0 && p.held_minor === 0) body.append(refundForm(p));
  } catch (error) {
    body.replaceChildren(el('p', { class: 'form-error' }, error.message));
  }
}

function deliveryForm(p) {
  const form = el('form', { class: 'inline-form', 'aria-label': 'Record delivery' },
    el('h3', {}, 'Record delivery'),
    el('p', { class: 'muted' }, 'You are charged only for what arrived; the rest of the hold is released and the supplier is paid for what was charged.'),
    p.lines.map((l) => el('label', {}, `${l.name} (ordered ${l.qty})`, el('input', { type: 'number', min: '0', max: String(l.qty * 2), step: '1', name: l.sku, value: String(l.qty) }))),
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn ghost', type: 'button', onclick: () => void submitDelivery(p, { none: true }) }, 'Nothing arrived'),
      el('button', { class: 'btn primary', type: 'submit' }, 'Record delivery')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(form);
    void submitDelivery(p, { lines: p.lines.map((l) => ({ sku: l.sku, received_qty: Number(data.get(l.sku) ?? 0) })) });
  });
  return form;
}

async function submitDelivery(p, body) {
  try {
    const out = await apiJson(`/api/owner/payments/${p.id}/delivery`, { method: 'POST', body });
    toast(out.speech ?? 'Delivery recorded.');
    await openPayment(p.id);
    void loadLedger();
    void loadOverview();
  } catch (error) {
    toast(error.message, 'err');
  }
}

function refundForm(p) {
  const form = el('form', { class: 'inline-form', 'aria-label': 'Refund' },
    el('h3', {}, 'Refund'),
    el('label', {}, 'Amount ($)', el('input', { type: 'number', min: '0.01', step: '0.01', max: String(p.charged_minor / 100), name: 'amount', value: (p.charged_minor / 100).toFixed(2) })),
    el('label', {}, 'Reason', el('input', { type: 'text', name: 'reason', required: true, minlength: '3', maxlength: '200', placeholder: 'e.g. two crates were spoiled' })),
    el('button', { class: 'btn', type: 'submit' }, 'Refund to my PayPal'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    try {
      const out = await apiJson(`/api/owner/payments/${p.id}/refund`, { method: 'POST', body: { amount_minor: Math.round(Number(data.get('amount')) * 100), reason: String(data.get('reason') ?? '') } });
      toast(out.speech ?? 'Refunded.');
      await openPayment(p.id);
      void loadLedger();
    } catch (error) {
      toast(error.message, 'err');
    }
  });
  return form;
}

$('btn-close-payment').addEventListener('click', () => $('payment-dialog').close());

// ---------- Rules & PayPal ----------

async function loadPolicy() {
  try {
    const [{ policy }, { suppliers }] = await Promise.all([apiJson('/api/owner/policy'), apiJson('/api/owner/suppliers')]);
    const form = $('policy-form');
    const set = (name, minor) => { form.elements[name].value = minor === null ? '' : String(Math.round(minor / 100)); };
    set('per_order_autopay_max', policy.per_order_autopay_max_minor);
    set('daily_max', policy.daily_max_minor);
    set('weekly_max', policy.weekly_max_minor);
    set('daily_hard_cap', policy.daily_hard_cap_minor);
    set('weekly_hard_cap', policy.weekly_hard_cap_minor);
    form.elements.price_jump_pct.value = String(policy.price_jump_pct);
    form.elements.quantity_spike_multiplier.value = String(policy.quantity_spike_multiplier);
    $('policy-suppliers').replaceChildren(...suppliers.map((s) => el('label', { class: 'check' },
      el('input', { type: 'checkbox', name: 'approved', value: s.code, checked: policy.allow_listed_supplier_codes.includes(s.code) }), ` ${s.name}`)));
    await loadOverview();
    const pp = overview.paypal;
    $('paypal-status').textContent = pp.connected ? `Connected: ${pp.account} (${pp.mode === 'mock' ? 'simulated' : 'sandbox'})` : 'Not connected. Each order will ask you to approve it in PayPal.';
    $('btn-connect').textContent = pp.connected ? 'Reconnect PayPal' : 'Connect PayPal';
    const s = overview.spend;
    $('spend-stats').replaceChildren(...[
      ['Today', `${cents(s.today_committed_minor)} of ${cents(policy.daily_max_minor)}`],
      ['This week', `${cents(s.week_committed_minor)} of ${cents(policy.weekly_max_minor)}`],
      ['Held awaiting delivery', cents(s.held_minor)],
      ['Waiting for you', String(s.pending_approvals)]
    ].flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  } catch (error) {
    if (error.status !== 401) toast(error.message, 'err');
  }
}

$('policy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const dollars = (name) => (form.elements[name].value === '' ? null : Math.round(Number(form.elements[name].value) * 100));
  const err = $('policy-error');
  err.hidden = true;
  if (!form.checkValidity()) {
    err.textContent = 'Check the highlighted fields.';
    err.hidden = false;
    form.reportValidity();
    return;
  }
  const body = {
    per_order_autopay_max_minor: dollars('per_order_autopay_max'),
    daily_max_minor: dollars('daily_max'),
    weekly_max_minor: dollars('weekly_max'),
    daily_hard_cap_minor: dollars('daily_hard_cap'),
    weekly_hard_cap_minor: dollars('weekly_hard_cap'),
    price_jump_pct: Number(form.elements.price_jump_pct.value),
    quantity_spike_multiplier: Number(form.elements.quantity_spike_multiplier.value),
    allow_listed_supplier_codes: [...form.querySelectorAll('input[name="approved"]:checked')].map((i) => i.value)
  };
  try {
    await apiJson('/api/owner/policy', { method: 'PUT', body });
    toast('Rules saved.');
    void loadPolicy();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  }
});

$('btn-connect').addEventListener('click', async () => {
  try {
    const out = await apiJson('/api/owner/paypal/connect', { method: 'POST', body: {} });
    location.assign(out.approve_url);
  } catch (error) {
    toast(error.message, 'err');
  }
});

// ---------- Suppliers ----------

async function loadSuppliers() {
  try {
    const { suppliers } = await apiJson('/api/owner/suppliers');
    if (!suppliersGrid) {
      suppliersGrid = createGrid($('suppliers-grid'), {
        columnDefs: [
          { field: 'name', headerName: 'Supplier', flex: 1, minWidth: 160 },
          { field: 'lead_time_days', headerName: 'Lead time (days)', width: 150, type: 'rightAligned' },
          { field: 'paypal_email', headerName: 'PayPal email (payouts)', flex: 1, minWidth: 240, editable: true, cellEditor: 'agTextCellEditor' },
          { field: 'verified', headerName: 'Verified', width: 120, editable: true, cellDataType: 'boolean' },
          { field: 'approved', headerName: 'Approved supplier', width: 170, cellDataType: 'boolean', headerTooltip: 'Change on the Rules tab' }
        ],
        defaultColDef: { sortable: true, resizable: true },
        rowData: suppliers,
        getRowId: (p) => p.data.code,
        onCellValueChanged: async (e) => {
          try {
            await apiJson(`/api/owner/suppliers/${encodeURIComponent(e.data.code)}`, { method: 'PUT', body: { paypal_email: e.data.paypal_email ?? '', verified: e.data.verified === true } });
            toast(`${e.data.name} updated.`);
          } catch (error) {
            toast(error.message, 'err');
            void loadSuppliers();
          }
        }
      });
    } else {
      suppliersGrid.setGridOption('rowData', suppliers);
    }
  } catch (error) {
    if (error.status !== 401) toast(error.message, 'err');
  }
}

// ---------- start ----------

$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try {
    await apiJson('/api/session', { method: 'POST', body: {} });
    await boot();
  } catch (error) {
    toast(error.message, 'err');
    $('btn-start').disabled = false;
  }
});

$('btn-reset-demo').addEventListener('click', async () => {
  if (!window.confirm('Reset your demo shop to its starting data? Orders, approvals and ledger entries you made will be cleared.')) return;
  try {
    await apiJson('/api/owner/demo/reset', { method: 'POST', body: {} });
    conversationId = null;
    calls.replaceChildren();
    callsEmpty.hidden = false;
    confirmCard.hidden = true;
    doneCard.hidden = true;
    toast('Demo shop reset.');
    await loadOverview();
    setTab(location.hash.slice(1));
  } catch (error) {
    toast(error.message, 'err');
  }
});

const RETURN_NOTES = {
  connected: ['PayPal connected.', 'ok'],
  connect_failed: ['PayPal was not connected.', 'warn'],
  approved: ['Approved in PayPal. The money is held, not charged.', 'ok'],
  not_approved: ['PayPal approval did not complete. Nothing was charged.', 'warn'],
  cancelled: ['Cancelled in PayPal. Nothing changed.', 'warn']
};

async function boot() {
  $('landing').hidden = true;
  document.querySelector('.tabs').hidden = false;
  await loadOverview();
  const note = new URLSearchParams(location.search).get('paypal');
  if (note && RETURN_NOTES[note]) {
    toast(...RETURN_NOTES[note]);
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
  }
  setTab(location.hash.slice(1));
}

// Scripted driver for demos, the video recorder and the e2e suite.
window.shopvoice = {
  async say(text, { wordDelayMs = 180 } = {}) {
    setTab('talk');
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
(async () => {
  try {
    await loadConfig();
    if (config.mode === 'visitor' && !config.hasShop) showLanding();
    else await boot();
  } catch {
    $('chip-mcp').textContent = 'Offline';
  }
})();
