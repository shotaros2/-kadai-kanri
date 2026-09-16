'use strict';

const STORAGE_KEY = 'kadai_assignments';

let assignments = [];
let filter = 'all';
let editingId = null;
let currentType = 'assignment';

// --- Storage ---
function load() {
  try {
    assignments = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    assignments = [];
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(assignments));
}

// --- Deadline helpers ---
function deadlineStatus(isoStr, done) {
  if (done) return 'done';
  const now = new Date();
  const d = new Date(isoStr);
  const diffMs = d - now;
  const diffH = diffMs / 3600000;
  if (diffMs < 0) return 'overdue';
  if (diffH < 24) return 'today';
  if (diffH < 48) return 'tomorrow';
  return 'later';
}

function deadlineBadgeClass(status, type) {
  if (type === 'exam') {
    return { overdue: 'badge-exam-overdue', today: 'badge-exam-today', tomorrow: 'badge-exam-tomorrow', later: 'badge-exam-later', done: 'badge-exam-done' }[status];
  }
  return { overdue: 'badge-overdue', today: 'badge-today', tomorrow: 'badge-tomorrow', later: 'badge-later', done: 'badge-done' }[status];
}

function deadlineBadgeLabel(status, isoStr) {
  if (status === 'done') return '完了';
  if (status === 'overdue') return '期限切れ';
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (status === 'today') return `今日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (status === 'tomorrow') return `明日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return dateStr;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Render ---
function getFiltered() {
  return assignments
    .filter(a => {
      if (filter === 'assignment') return !a.done && a.type !== 'exam';
      if (filter === 'exam') return !a.done && a.type === 'exam';
      if (filter === 'done') return a.done;
      return true;
    })
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return new Date(a.deadline) - new Date(b.deadline);
    });
}

function renderList() {
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  const items = getFiltered();

  if (items.length === 0) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = items.map(a => {
    const type = a.type || 'assignment';
    const status = deadlineStatus(a.deadline, a.done);
    const badgeClass = deadlineBadgeClass(status, type);
    const badgeLabel = deadlineBadgeLabel(status, a.deadline);
    const typeLabel = type === 'exam' ? '📝 テスト' : '📋 課題';
    return `
      <div class="card ${a.done ? 'done-card' : ''}" data-id="${escHtml(a.id)}">
        <input class="card-check" type="checkbox" ${a.done ? 'checked' : ''} data-id="${escHtml(a.id)}" aria-label="完了トグル">
        <div class="card-body">
          <div class="card-top">
            <span class="card-subject">${escHtml(a.subject)}</span>
            <span class="deadline-badge ${badgeClass}">${badgeLabel}</span>
          </div>
          <div class="card-type-label">${typeLabel}</div>
          ${a.content ? `<div class="card-content">${escHtml(a.content)}</div>` : ''}
          ${a.memo ? `<div class="card-memo">${escHtml(a.memo)}</div>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn-icon" data-action="edit" data-id="${escHtml(a.id)}" title="編集">✏️</button>
          <button class="btn-icon" data-action="delete" data-id="${escHtml(a.id)}" title="削除">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

// --- Modal type toggle ---
function setType(type) {
  currentType = type;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  const labelDeadline = document.getElementById('label-deadline');
  const labelContent = document.getElementById('label-content');
  const fContent = document.getElementById('f-content');
  if (type === 'exam') {
    labelDeadline.childNodes[0].textContent = '日時 ';
    labelContent.textContent = '出題範囲';
    fContent.placeholder = '例：第1章〜第3章、p.1-60';
  } else {
    labelDeadline.childNodes[0].textContent = '締め切り ';
    labelContent.textContent = '内容';
    fContent.placeholder = '課題の内容や指示を入力';
  }
}

// --- Modal ---
function openModal(id = null) {
  editingId = id;
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const a = id ? assignments.find(x => x.id === id) : null;
  const type = a ? (a.type || 'assignment') : 'assignment';

  title.textContent = id ? '編集' : '追加';
  document.getElementById('f-subject').value = a ? a.subject : '';
  document.getElementById('f-deadline').value = a ? a.deadline : '';
  document.getElementById('f-content').value = a ? a.content : '';
  document.getElementById('f-memo').value = a ? a.memo : '';
  setType(type);

  overlay.hidden = false;
  document.getElementById('f-subject').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').hidden = true;
  document.getElementById('form').reset();
  editingId = null;
}

// --- Share ---
// 配列形式 [id, subject, deadline, content, memo, done, createdAt, type] で圧縮
function toCompact(a) {
  return [a.id, a.subject, a.deadline, a.content, a.memo, a.done ? 1 : 0, a.createdAt, a.type || 'assignment'];
}
function fromCompact([id, subject, deadline, content, memo, done, createdAt, type]) {
  return { id, subject, deadline, content: content || '', memo: memo || '', done: !!done, createdAt, type: type || 'assignment' };
}

async function compress(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function decompress(b64) {
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

async function copyShareLink() {
  const compact = JSON.stringify(assignments.map(toCompact));
  const compressed = await compress(compact);
  const longUrl = `${location.origin}${location.pathname}#s=${compressed}`;

  try {
    const res = await fetch(`/api/shorten?url=${encodeURIComponent(longUrl)}`);
    if (!res.ok) throw new Error();
    const shortUrl = (await res.text()).trim();
    await navigator.clipboard.writeText(shortUrl);
    showToast('短縮URLをコピーしました');
  } catch {
    await navigator.clipboard.writeText(longUrl);
    showToast('URLをコピーしました');
  }
}

async function loadShareFromHash() {
  const hash = location.hash;
  const m = hash.match(/^#s=(.+)$/);
  if (!m) return;
  try {
    const json = await decompress(m[1]);
    const data = JSON.parse(json);
    if (Array.isArray(data)) {
      assignments = data.map(fromCompact);
      save();
      history.replaceState(null, '', location.pathname);
      showToast('共有データを読み込みました');
    }
  } catch {
    showToast('データの読み込みに失敗しました');
  }
}

// --- Toast ---
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// --- Event handlers ---
function handleListClick(e) {
  const check = e.target.closest('input.card-check');
  if (check) {
    const id = check.dataset.id;
    const a = assignments.find(x => x.id === id);
    if (a) { a.done = check.checked; save(); renderList(); }
    return;
  }

  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'edit') { openModal(id); return; }
  if (action === 'delete') {
    if (confirm('削除しますか？')) {
      assignments = assignments.filter(a => a.id !== id);
      save();
      renderList();
    }
  }
}

function handleFormSubmit(e) {
  e.preventDefault();
  const subject = document.getElementById('f-subject').value.trim();
  const deadline = document.getElementById('f-deadline').value;
  const content = document.getElementById('f-content').value.trim();
  const memo = document.getElementById('f-memo').value.trim();
  const type = currentType;

  if (editingId) {
    const a = assignments.find(x => x.id === editingId);
    if (a) { a.subject = subject; a.deadline = deadline; a.content = content; a.memo = memo; a.type = type; }
  } else {
    assignments.push({ id: crypto.randomUUID(), subject, deadline, content, memo, done: false, createdAt: new Date().toISOString(), type });
  }

  save();
  renderList();
  closeModal();
}

// --- Init ---
async function init() {
  load();
  await loadShareFromHash();
  renderList();

  document.getElementById('btn-add').addEventListener('click', () => openModal());
  document.getElementById('btn-share').addEventListener('click', copyShareLink);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  document.getElementById('form').addEventListener('submit', handleFormSubmit);
  document.getElementById('list').addEventListener('click', handleListClick);

  document.querySelector('.type-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.type-btn');
    if (btn) setType(btn.dataset.type);
  });

  document.getElementById('filter-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    filter = tab.dataset.filter;
    renderList();
  });
}

document.addEventListener('DOMContentLoaded', init);
