import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';

const CFG = window.DAYMATE || {};
const sb = createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => ymd(new Date());
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmtDay = s => parseYmd(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); const d = new Date(); d.setHours(h, m); return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
const safeLink = u => typeof u === 'string' && /^https:\/\//i.test(u) ? u : '';
const hhmm = t => (typeof t === 'string' && /^\d{1,2}:\d{2}/.test(t)) ? t.slice(0, 5).padStart(5, '0') : '';
const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

let items = [], user = null, channel = null;
let view = 'today', filter = 'open', weekStart = startOfWeek(new Date());

function startOfWeek(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); }

/* ---------- data ---------- */
function normalize(r) {
  return { ...r, time: hhmm(r.time), end_time: hhmm(r.end_time), date: r.date || '', link: r.link || '', notes: r.notes || '' };
}
function toRow(it) {
  const row = {
    kind: it.kind === 'event' ? 'event' : 'task',
    title: String(it.title || 'Untitled').slice(0, 300),
    notes: String(it.notes || '').slice(0, 4000),
    date: isDate(it.date) ? it.date : null,
    time: hhmm(it.time) || null,
    end_time: hhmm(it.end_time) || null,
    priority: ['high', 'low'].includes(it.priority) ? it.priority : 'normal',
    done: !!it.done,
    link: safeLink(it.link),
    remind_minutes: it.remind_minutes === '' || it.remind_minutes == null || isNaN(Number(it.remind_minutes)) ? null : Number(it.remind_minutes),
  };
  // Reminder time is worked out here, in the user's own time zone.
  if (row.remind_minutes != null && row.date) {
    const [h, m] = (row.time || '09:00').split(':').map(Number);
    const at = parseYmd(row.date); at.setHours(h, m, 0, 0);
    row.remind_at = new Date(at.getTime() - row.remind_minutes * 60000).toISOString();
  } else row.remind_at = null;
  return row;
}
async function load() {
  const { data, error } = await sb.from('items').select('*').order('date', { ascending: true, nullsFirst: false }).limit(2000);
  if (error) { setStatus('Could not load. Check your internet.'); return; }
  items = data.map(normalize); render(); setStatus('Synced');
}
function upsertLocal(r) { const n = normalize(r); const i = items.findIndex(x => x.id === n.id); if (i >= 0) items[i] = n; else items.push(n); }
async function saveItem(it) {
  const row = toRow(it);
  const prev = it.id ? items.find(x => x.id === it.id) : null;
  if (prev && +new Date(prev.remind_at || 0) !== +new Date(row.remind_at || 0)) row.notified = false;
  const q = it.id ? sb.from('items').update(row).eq('id', it.id).select().single() : sb.from('items').insert(row).select().single();
  const { data, error } = await q;
  if (error) { toast('Could not save. Check your internet.'); throw error; }
  upsertLocal(data); render(); return normalize(data);
}
async function deleteItem(id, silent) {
  const old = items.find(x => x.id === id); if (!old) return;
  items = items.filter(x => x.id !== id); render();
  const { error } = await sb.from('items').delete().eq('id', id);
  if (error) { toast('Could not delete.'); items.push(old); render(); return; }
  if (!silent) toast('Deleted “' + old.title + '”', () => { const { id: _, ...rest } = old; saveItem(rest); });
}
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('items-' + user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: 'user_id=eq.' + user.id }, p => {
      if (p.eventType === 'DELETE') items = items.filter(x => x.id !== p.old.id);
      else upsertLocal(p.new);
      render();
    })
    .subscribe(s => { if (s === 'SUBSCRIBED') setStatus('Synced'); });
}

/* ---------- rendering ---------- */
const sortKey = a => (a.date || '9999-99-99') + (a.time || '99:99');
function setStatus(t) { $('#status').textContent = t; }
function taskLi(t) {
  const over = t.date && t.date < todayStr() && !t.done;
  return `<li class="${t.done ? 'done' : ''}"><button class="chk ${t.done ? 'done' : ''}" data-tog="${esc(t.id)}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}">${t.done ? '✓' : ''}</button>
  <span class="tt" data-ed="${esc(t.id)}"><b>${esc(t.title)}</b></span>
  ${t.priority === 'high' ? '<span class="pill high">High</span>' : ''}
  <span class="meta" style="${over ? 'color:#e6261f;font-weight:700' : ''}">${t.date ? (t.date === todayStr() ? 'Today' : esc(fmtDay(t.date))) : ''}${t.time ? ' ' + esc(fmtTime(t.time)) : ''}</span></li>`;
}
function render() {
  const today = todayStr(), h = new Date().getHours();
  $('#hello').textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  $('#todayTitle').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const timed = items.filter(x => x.date === today && x.time).sort((a, b) => a.time.localeCompare(b.time));
  $('#agenda').innerHTML = timed.length ? timed.map(x => {
    const l = safeLink(x.link);
    return `<li><span class="t">${esc(fmtTime(x.time))}${x.end_time ? `<small>to ${esc(fmtTime(x.end_time))}</small>` : ''}</span>
    <span class="it" data-ed="${esc(x.id)}" style="cursor:pointer"><b style="${x.done ? 'text-decoration:line-through;opacity:.7' : ''}">${esc(x.title)}</b><span>${x.kind === 'event' ? 'Event' : 'Task'}${x.notes ? ' · ' + esc(x.notes.slice(0, 60)) : ''}</span></span>
    ${l ? `<a class="join" href="${esc(l)}" target="_blank" rel="noopener">Join</a>` : '<span></span>'}</li>`;
  }).join('') : '<li class="empty"><span></span><span>Nothing at a set time today. Type above to add something.</span><span></span></li>';
  const due = items.filter(x => x.kind === 'task' && !x.done && x.date && x.date <= today && !(x.date === today && x.time)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  $('#dueToday').innerHTML = due.length ? due.map(taskLi).join('') : '<li class="sub">Nothing due. Nice.</li>';

  const q = $('#search').value.trim().toLowerCase();
  let list = items.filter(x => x.kind === 'task');
  if (filter === 'open') list = list.filter(x => !x.done);
  if (filter === 'today') list = list.filter(x => !x.done && x.date && x.date <= today);
  if (filter === 'upcoming') list = list.filter(x => !x.done && x.date > today);
  if (filter === 'nodate') list = list.filter(x => !x.done && !x.date);
  if (filter === 'done') list = list.filter(x => x.done);
  if (q) list = list.filter(x => (x.title + ' ' + x.notes).toLowerCase().includes(q));
  list.sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || sortKey(a).localeCompare(sortKey(b)));
  $('#taskList').innerHTML = list.length ? list.map(taskLi).join('') : '<li class="sub">No tasks here.</li>';

  const days = [...Array(7)].map((_, i) => ymd(addDays(weekStart, i)));
  $('#weekTitle').textContent = fmtDay(days[0]) + ' – ' + fmtDay(days[6]);
  $('#week').innerHTML = days.map(d => {
    const its = items.filter(x => x.date === d).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    return `<div class="day ${d === today ? 'today' : ''}"><h3>${esc(fmtDay(d))}</h3>${its.map(x => `<button class="ev ${x.kind} ${x.done ? 'done' : ''}" data-ed="${esc(x.id)}">${x.time ? esc(fmtTime(x.time)) + ' · ' : ''}${esc(x.title)}</button>`).join('') || '<span class="sub" style="font-size:13px">Free</span>'}<button class="ghost" data-newday="${d}" style="min-height:32px;font-size:13px;padding:0 4px">+ Add</button></div>`;
  }).join('');
}

/* ---------- edit dialog ---------- */
const FIELDS = ['title', 'kind', 'priority', 'date', 'time', 'end_time', 'remind_minutes', 'link', 'notes'];
let editing = null;
function openEdit(it, preset = {}) {
  editing = it ? { ...it } : { kind: 'task', date: todayStr(), ...preset };
  const f = $('#edit');
  $('#dlgTitle').textContent = it ? 'Edit' : (editing.kind === 'event' ? 'New event' : 'New task');
  for (const k of FIELDS) f.elements[k].value = editing[k] ?? (k === 'priority' ? 'normal' : k === 'kind' ? 'task' : '');
  $('#del').hidden = !it;
  $('#dlg').showModal(); f.elements.title.focus();
}
$('#edit').addEventListener('submit', e => {
  e.preventDefault(); const f = e.target; const o = { ...editing };
  for (const k of FIELDS) o[k] = f.elements[k].value.trim();
  if (o.link && !safeLink(o.link)) { toast('Meeting links must start with https://'); return; }
  $('#dlg').close(); saveItem(o).catch(() => {});
});
$('#cancel').onclick = () => $('#dlg').close();
$('#del').onclick = () => { $('#dlg').close(); if (editing?.id) deleteItem(editing.id); };

/* ---------- UI events ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-tog],[data-ed],[data-newday]'); if (!t) return;
  if (t.dataset.tog) { const it = items.find(x => x.id === t.dataset.tog); if (it) saveItem({ ...it, done: !it.done }).catch(() => {}); }
  else if (t.dataset.ed) { const it = items.find(x => x.id === t.dataset.ed); if (it) openEdit(it); }
  else if (t.dataset.newday) openEdit(null, { date: t.dataset.newday });
});
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.v));
function show(v) {
  view = v; document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-selected', b.dataset.v === v));
  for (const id of ['today', 'tasks', 'cal', 'ai', 'set']) $('#v-' + id).hidden = id !== v;
  if (v === 'ai') $('#cin').focus();
  if (v === 'set') refreshPushUI();
}
$('#filters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; document.querySelectorAll('[data-f]').forEach(x => x.setAttribute('aria-pressed', x === b)); render(); });
$('#search').addEventListener('input', render);
$('#addTask').onclick = $('#addTask2').onclick = () => openEdit(null);
$('#addEvent').onclick = () => openEdit(null, { kind: 'event', remind_minutes: '10' });
$('#prevW').onclick = () => { weekStart = addDays(weekStart, -7); render(); };
$('#nextW').onclick = () => { weekStart = addDays(weekStart, 7); render(); };
$('#thisW').onclick = () => { weekStart = startOfWeek(new Date()); render(); };

let toastT;
function toast(msg, undo) {
  $('#toastMsg').textContent = msg; const b = $('#toastBtn'); b.hidden = !undo;
  b.onclick = () => { $('#toast').style.display = 'none'; undo && undo(); };
  $('#toast').style.display = 'flex'; clearTimeout(toastT); toastT = setTimeout(() => $('#toast').style.display = 'none', 6000);
}

/* ---------- AI ---------- */
function itemsBrief(limit = 150) {
  const today = todayStr(), cut = ymd(addDays(new Date(), -2));
  return items.filter(x => !x.done || (x.date && x.date >= cut)).sort((a, b) => sortKey(a).localeCompare(sortKey(b))).slice(0, limit)
    .map(x => `${x.id} | ${x.kind} | ${x.title} | ${x.date || 'no date'} ${x.time}${x.end_time ? '-' + x.end_time : ''} | ${x.priority} | ${x.done ? 'done' : x.date && x.date < today ? 'OVERDUE' : 'open'}`).join('\n');
}
async function ai(body) {
  const { data, error } = await sb.functions.invoke('ai', { body: { ...body, now: new Date().toString(), tz, items: itemsBrief() } });
  if (error) {
    let msg = 'The AI is not available right now.';
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return data;
}
async function quickAdd(text) {
  if (!text) return;
  $('#qbtn').disabled = true; $('#qbtn').textContent = 'Adding…';
  try {
    const { item } = await ai({ mode: 'parse', text });
    const c = await saveItem({ ...item, title: item?.title || text });
    toast(`Added ${c.kind} “${c.title}”${c.date ? ' · ' + fmtDay(c.date) : ''}${c.time ? ' ' + fmtTime(c.time) : ''}`, () => deleteItem(c.id, true));
  } catch (e) {
    try { const c = await saveItem({ kind: 'task', title: text }); toast('Added as a task. ' + e.message, () => deleteItem(c.id, true)); } catch {}
  } finally { $('#qbtn').disabled = false; $('#qbtn').textContent = 'Add'; }
}
$('#quick').addEventListener('submit', e => { e.preventDefault(); const v = $('#qin').value.trim(); $('#qin').value = ''; quickAdd(v); });

const chatLog = [];
function addMsg(role, text) { const d = document.createElement('div'); d.className = 'msg ' + role; d.textContent = text; $('#chat').appendChild(d); $('#chat').scrollTop = 1e9; return d; }
async function runAction(a) {
  const args = a.args || {};
  if (a.name === 'add_item') { const c = await saveItem(args); return `Added “${c.title}”${c.date ? ' on ' + fmtDay(c.date) : ''}${c.time ? ' at ' + fmtTime(c.time) : ''}`; }
  if (a.name === 'update_item') {
    const it = items.find(x => x.id === args.id); if (!it) return null;
    const { id, ...ch } = args; const c = await saveItem({ ...it, ...ch });
    return ch.done ? `Marked “${c.title}” done` : `Updated “${c.title}”${c.date ? ' → ' + fmtDay(c.date) : ''}${c.time ? ' ' + fmtTime(c.time) : ''}`;
  }
  if (a.name === 'delete_item') { const it = items.find(x => x.id === args.id); if (!it) return null; await deleteItem(it.id, true); return `Deleted “${it.title}”`; }
  return null;
}
async function ask(text) {
  if (!text) return;
  addMsg('u', text); chatLog.push({ role: 'user', content: text });
  const out = addMsg('a', 'Thinking…');
  try {
    const r = await ai({ mode: 'chat', messages: chatLog });
    const done = [];
    for (const a of r.actions || []) { try { const s = await runAction(a); if (s) done.push(s); } catch {} }
    const reply = [r.text, done.length && !r.text ? done.join('\n') : ''].filter(Boolean).join('\n') || (done.length ? done.join('\n') : 'Done.');
    out.textContent = reply + (done.length && r.text ? '\n\n✓ ' + done.join('\n✓ ') : '');
    chatLog.push({ role: 'assistant', content: reply });
  } catch (e) { out.textContent = e.message; }
}
$('#chatForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#cin').value.trim(); $('#cin').value = ''; ask(v); });
$('#sugg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) ask(b.textContent); });
addMsg('sys', 'Tell me what to plan, move or finish. I can change your planner for you.');

$('#briefBtn').onclick = async () => {
  $('#brief').textContent = 'Thinking…'; $('#briefBtn').disabled = true;
  try { const r = await ai({ mode: 'brief' }); $('#brief').textContent = r.text || 'No briefing.'; }
  catch (e) { $('#brief').textContent = e.message; }
  finally { $('#briefBtn').disabled = false; }
};

/* ---------- voice (browser speech recognition) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function wireMic(btn, input, form) {
  if (!SR) return; btn.hidden = false; let rec = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true;
    let final = '';
    rec.onresult = ev => { let interim = ''; for (const r of ev.results) { if (r.isFinal) final = r[0].transcript; else interim = r[0].transcript; } input.value = (final || interim).trim(); };
    rec.onend = () => { btn.classList.remove('on'); rec = null; if (input.value.trim()) form.requestSubmit(); };
    rec.onerror = () => { btn.classList.remove('on'); };
    btn.classList.add('on'); input.value = ''; rec.start();
  };
}
wireMic($('#qmic'), $('#qin'), $('#quick'));
wireMic($('#cmic'), $('#cin'), $('#chatForm'));

/* ---------- push reminders ---------- */
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let swReg = null;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
async function pushKey() {
  const r = await fetch(CFG.supabaseUrl + '/functions/v1/reminders?key=1', { headers: { apikey: CFG.supabaseKey } });
  return (await r.json()).publicKey;
}
function b64ToBytes(b64) { const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, c => c.charCodeAt(0)); }
async function refreshPushUI() {
  const info = $('#pushInfo'), on = $('#pushOn'), test = $('#pushTest');
  if (!pushSupported) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    info.textContent = ios ? 'On iPhone, first add DayMate to your Home Screen (Safari share button → Add to Home Screen), then open it from there to turn on reminders.' : 'This browser cannot show reminders. Try Chrome or Edge.';
    on.hidden = true; test.hidden = true; return;
  }
  const reg = swReg || await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === 'granted') { info.innerHTML = '<span class="ok">Reminders are on for this device.</span> On Android they also appear on your smartwatch.'; on.textContent = 'Turn off'; test.hidden = false; }
  else { info.textContent = Notification.permission === 'denied' ? 'Notifications are blocked. Allow them for this site in your browser settings, then try again.' : 'Get a notification before tasks and meetings. On Android it also shows on your smartwatch.'; on.textContent = 'Turn on reminders'; test.hidden = true; }
  on.hidden = false;
}
$('#pushOn').onclick = async () => {
  const reg = swReg || await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing && Notification.permission === 'granted') {
    await sb.from('push_subscriptions').delete().eq('endpoint', existing.endpoint); await existing.unsubscribe(); refreshPushUI(); return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { refreshPushUI(); return; }
  try {
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(await pushKey()) });
    const j = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) }, { onConflict: 'endpoint' });
    if (error) throw error;
    toast('Reminders are on.');
  } catch { toast('Could not turn on reminders on this device.'); }
  refreshPushUI();
};
$('#pushTest').onclick = async () => {
  const reg = swReg || await navigator.serviceWorker.ready;
  reg.showNotification('DayMate', { body: 'Reminders work on this device.', icon: 'icons/icon-192.png' });
};

/* ---------- install ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('#install').hidden = false; });
$('#install').onclick = async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#install').hidden = true; };

/* ---------- auth ---------- */
let pendingEmail = '';
$('#emailForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#authErr').textContent = '';
  pendingEmail = $('#email').value.trim().toLowerCase();
  $('#sendCode').disabled = true; $('#sendCode').textContent = 'Sending…';
  const { error } = await sb.auth.signInWithOtp({ email: pendingEmail, options: { shouldCreateUser: true } });
  $('#sendCode').disabled = false; $('#sendCode').textContent = 'Send me a code';
  if (error) { $('#authErr').textContent = /rate|limit/i.test(error.message) ? 'Too many emails right now. Please wait a few minutes and try again.' : error.message; return; }
  $('#sentTo').textContent = pendingEmail; $('#emailForm').hidden = true; $('#codeForm').hidden = false; $('#code').focus();
});
$('#codeForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#authErr').textContent = '';
  const token = $('#code').value.replace(/\s/g, '');
  $('#verify').disabled = true;
  const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
  $('#verify').disabled = false;
  if (error) $('#authErr').textContent = 'That code did not work. Check it, or ask for a new one.';
});
$('#back').onclick = () => { $('#codeForm').hidden = true; $('#emailForm').hidden = false; $('#code').value = ''; };
$('#signOut').onclick = async () => { await sb.auth.signOut(); };

function enter(session) {
  const u = session?.user || null;
  if (u && user?.id === u.id) return;
  user = u;
  $('#auth').hidden = !!user; $('#app').hidden = !user;
  if (!user) { items = []; if (channel) sb.removeChannel(channel); channel = null; return; }
  $('#me').textContent = user.email || '';
  $('#ver').textContent = 'DayMate ' + (CFG.version || '');
  setStatus('Loading…'); render(); load(); subscribe();
  if (new URLSearchParams(location.search).get('add')) $('#qin').focus();
}
sb.auth.onAuthStateChange((_e, session) => enter(session));
sb.auth.getSession().then(({ data }) => enter(data.session));
setInterval(() => { if (user && view === 'today') render(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && user) load(); });
