'use strict';

// ============================================================
// Firebase 設定
// ============================================================
// 1. https://console.firebase.google.com でプロジェクトを作成
// 2. Firestore Database を有効化（本番モード）
// 3. Storage を有効化
// 4. プロジェクト設定 > ウェブアプリ > SDK の設定をコピーして下記に貼り付け
// 5. Firestore ルール:
//    rules_version = '2';
//    service cloud.firestore {
//      match /databases/{database}/documents {
//        match /groups/{groupId}/{document=**} { allow read, write: if true; }
//      }
//    }
// 6. Storage ルール:
//    rules_version = '2';
//    service firebase.storage {
//      match /b/{bucket}/o {
//        match /{allPaths=**} { allow read, write: if true; }
//      }
//    }
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyCCUgR_rjGJXkT5CTTbg2jw2rymPYyBNDk",
  authDomain: "kadai-doumei.firebaseapp.com",
  projectId: "kadai-doumei",
  storageBucket: "kadai-doumei.firebasestorage.app",
  messagingSenderId: "238661730604",
  appId: "1:238661730604:web:7c529567398738839a2c89",
  measurementId: "G-WGHB74QQYE"
};

firebase.initializeApp(firebaseConfig);
const db      = firebase.firestore();
const storage = firebase.storage();
const auth    = firebase.auth();

// ── Local state ──────────────────────────────────────────────
const LS_MEMBER_ID = 'kadai_watch_memberId';
const LS_GROUPS    = 'kadai_watch_groups';

let memberId    = null;  // this device's persistent ID
let groupId     = null;
let groupName   = '';
let groupCode   = '';
let members     = {};    // { [memberId]: memberDoc }
let assignments = {};    // { [assignmentId]: assignmentDoc }
let currentFilter = 'all';
let editingAssignmentId = null;
let currentType = 'assignment';
let pendingFiles = [];   // File objects staged for upload
let unsubAssignments = null;
let unsubMembers     = null;
let unsubNudges      = null;
let nudgeQueue       = [];
let nudgeShowing     = false;
let deadlineMode     = 'datetime'; // 'datetime' | 'period'
let countdownTimer   = null;

const PERIOD_END = {1:[9,20],2:[10,20],3:[11,20],4:[12,20],5:[14,10],6:[15,10],7:[16,10],8:[17,10]};

// ── Init ─────────────────────────────────────────────────────
function getOrCreateMemberId() {
  let id = localStorage.getItem(LS_MEMBER_ID);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(LS_MEMBER_ID, id); }
  return id;
}

function getSavedGroups() {
  try { return JSON.parse(localStorage.getItem(LS_GROUPS) || '[]'); } catch { return []; }
}

function saveGroup(gId, name) {
  const groups = getSavedGroups().filter(g => g.groupId !== gId);
  groups.unshift({ groupId: gId, groupName: name });
  localStorage.setItem(LS_GROUPS, JSON.stringify(groups.slice(0, 10)));
}

function removeGroup(gId) {
  const groups = getSavedGroups().filter(g => g.groupId !== gId);
  localStorage.setItem(LS_GROUPS, JSON.stringify(groups));
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('watch-sw.js').catch(() => {});
  }

  // Firebase Auth の初期化を待つ（セッション永続化）
  const user = await new Promise(resolve => {
    const unsub = auth.onAuthStateChanged(u => { unsub(); resolve(u); });
  });

  if (!user) {
    showScreen('welcome');
    return;
  }

  memberId = user.uid;

  // Auto-rejoin last group if saved
  const saved = getSavedGroups();
  if (saved.length > 0) {
    const g = saved[0];
    const snap = await db.collection('groups').doc(g.groupId).get().catch(() => null);
    if (snap && snap.exists) {
      const memberSnap = await db.collection('groups').doc(g.groupId)
        .collection('members').doc(memberId).get().catch(() => null);
      if (memberSnap && memberSnap.exists) {
        await enterGroup(g.groupId, snap.data().name, snap.data().code);
        return;
      }
    }
    removeGroup(g.groupId);
  }

  // ログイン済みだがグループ未加入 → ウェルカムへ
  showScreen('welcome');
}

// ── Screen management ─────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

// ── Welcome / Create / Join ───────────────────────────────────
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function registerAndProceed(email, password) {
  // 既存アカウントのログインまたは新規作成
  try {
    if (auth.currentUser) return true; // 既にログイン済み
    await auth.createUserWithEmailAndPassword(email, password);
    memberId = auth.currentUser.uid;
    return true;
  } catch (err) {
    if (err.code === 'auth/email-already-in-use') {
      showToast('このメールアドレスは既に使われています。「別の端末からログイン」をお使いください');
    } else if (err.code === 'auth/invalid-email') {
      showToast('メールアドレスの形式が正しくありません');
    } else if (err.code === 'auth/weak-password') {
      showToast('パスワードは6文字以上にしてください');
    } else {
      showToast('アカウント作成に失敗しました');
    }
    return false;
  }
}

async function createGroup(name, email, password, gName) {
  if (!(await registerAndProceed(email, password))) return;
  const code = generateCode();
  const ref = await db.collection('groups').add({
    name: gName, code, createdAt: new Date().toISOString()
  });
  await db.collection('groups').doc(ref.id)
    .collection('members').doc(memberId).set({
      name, email, instagramId: '', lineId: '',
      joinedAt: new Date().toISOString()
    });
  saveGroup(ref.id, gName);
  await enterGroup(ref.id, gName, code);
  showScreen('profile');
}

async function joinGroup(name, email, password, code) {
  if (!(await registerAndProceed(email, password))) return;
  code = code.toUpperCase().trim();
  const snap = await db.collection('groups').where('code', '==', code).limit(1).get();
  if (snap.empty) { showToast('招待コードが見つかりません'); return; }
  const doc = snap.docs[0];
  const gData = doc.data();
  const memberSnap = await db.collection('groups').doc(doc.id)
    .collection('members').doc(memberId).get();
  const isNew = !memberSnap.exists;
  await db.collection('groups').doc(doc.id)
    .collection('members').doc(memberId).set({
      name, email, instagramId: '', lineId: '',
      joinedAt: new Date().toISOString()
    }, { merge: true });
  saveGroup(doc.id, gData.name);
  await enterGroup(doc.id, gData.name, gData.code);
  if (isNew) showScreen('profile');
}

async function loginExisting(email, password) {
  try {
    await auth.signInWithEmailAndPassword(email, password);
    memberId = auth.currentUser.uid;
  } catch (err) {
    if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
      showToast('メールアドレスまたはパスワードが正しくありません');
    } else {
      showToast('ログインに失敗しました');
    }
    return;
  }
  // グループが保存されていれば自動復帰
  const saved = getSavedGroups();
  if (saved.length > 0) {
    const g = saved[0];
    const snap = await db.collection('groups').doc(g.groupId).get().catch(() => null);
    if (snap && snap.exists) {
      const memberSnap = await db.collection('groups').doc(g.groupId)
        .collection('members').doc(memberId).get().catch(() => null);
      if (memberSnap && memberSnap.exists) {
        await enterGroup(g.groupId, snap.data().name, snap.data().code);
        return;
      }
    }
    removeGroup(g.groupId);
  }
  showToast('ログインしました。招待コードでグループに参加してください');
  showCardJoin();
}

function showCardJoin() {
  document.getElementById('card-join').style.display = 'block';
  document.getElementById('card-create').style.display = 'none';
  document.getElementById('card-login').style.display = 'none';
}

async function enterGroup(gId, gName, code) {
  groupId   = gId;
  groupName = gName;
  groupCode = code;
  document.getElementById('header-group-name').textContent = gName + ' · コード: ' + code;
  showScreen('main');
  subscribeAll();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdowns, 30000);
}

// ── Realtime subscriptions ────────────────────────────────────
function subscribeAll() {
  if (unsubMembers) unsubMembers();
  if (unsubAssignments) unsubAssignments();
  if (unsubNudges) unsubNudges();

  unsubMembers = db.collection('groups').doc(groupId).collection('members')
    .onSnapshot(snap => {
      snap.docChanges().forEach(c => {
        if (c.type === 'removed') delete members[c.doc.id];
        else members[c.doc.id] = { id: c.doc.id, ...c.doc.data() };
      });
      renderList();
    });

  unsubAssignments = db.collection('groups').doc(groupId).collection('assignments')
    .orderBy('deadline').onSnapshot(snap => {
      snap.docChanges().forEach(c => {
        if (c.type === 'removed') delete assignments[c.doc.id];
        else assignments[c.doc.id] = { id: c.doc.id, ...c.doc.data() };
      });
      document.getElementById('loading').style.display = 'none';
      renderList();
    });

  unsubNudges = db.collection('groups').doc(groupId).collection('nudges')
    .where('toMemberId', '==', memberId).where('read', '==', false)
    .onSnapshot(snap => {
      snap.docChanges().forEach(c => {
        if (c.type === 'added') nudgeQueue.push({ id: c.doc.id, ...c.doc.data() });
      });
      processNudgeQueue();
      updateNudgeBadge(snap.docs.length);
    });
}

// ── Nudge badge ───────────────────────────────────────────────
function updateNudgeBadge(count) {
  const btn = document.getElementById('btn-notif');
  let badge = btn.querySelector('.notif-badge');
  if (count > 0) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'notif-badge'; btn.appendChild(badge); }
  } else {
    if (badge) badge.remove();
  }
}

// ── Render ────────────────────────────────────────────────────
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function deadlineStatus(isoStr, done) {
  if (done) return 'done';
  const diff = new Date(isoStr) - new Date();
  if (diff < 0) return 'overdue';
  if (diff < 86400000) return 'today';
  if (diff < 172800000) return 'tomorrow';
  return 'later';
}

function badgeClass(status, type) {
  const prefix = type === 'exam' ? 'badge-exam-' : 'badge-';
  return prefix + status;
}

function badgeLabel(status, isoStr, a) {
  if (status === 'done') return '完了';
  if (status === 'overdue') return '期限切れ';
  const d = new Date(isoStr);
  if (a && a.deadlineMode === 'period' && a.period) {
    const prefix = status === 'today' ? '今日' : (status === 'tomorrow' ? '明日' : `${d.getMonth()+1}/${d.getDate()}`);
    return `${prefix} ${a.period}限目`;
  }
  const pad = n => String(n).padStart(2,'0');
  const t = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (status === 'today') return '今日 ' + t;
  if (status === 'tomorrow') return '明日 ' + t;
  return (d.getMonth()+1) + '/' + d.getDate() + ' ' + t;
}

function countdown(isoStr) {
  const diff = new Date(isoStr) - Date.now();
  if (diff <= 0) return '';
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days >= 7)  return `残り${days}日`;
  if (days >= 1)  return `残り${days}日${hours % 24}時間`;
  if (hours >= 1) return `残り${hours}時間${mins % 60}分`;
  return `残り${mins}分`;
}

function updateCountdowns() {
  document.querySelectorAll('.countdown[data-deadline]').forEach(el => {
    el.textContent = countdown(el.dataset.deadline);
  });
}

function getFiltered() {
  return Object.values(assignments).filter(a => {
    const done = !!(a.completions || {})[memberId];
    if (currentFilter === 'assignment') return !done && a.type !== 'exam';
    if (currentFilter === 'exam') return !done && a.type === 'exam';
    if (currentFilter === 'done') return done;
    return true;
  }).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
}

function renderMemberChips(a) {
  const completions = a.completions || {};
  const status = deadlineStatus(a.deadline, false);
  const memberList = Object.values(members);
  if (memberList.length === 0) return '';

  // 完了時刻でソートしてメダルを割り当て
  const MEDALS      = ['🥇', '🥈', '🥉'];
  const MEDAL_CLS   = ['chip-gold', 'chip-silver', 'chip-bronze'];
  const completedSorted = memberList
    .filter(m => completions[m.id])
    .map(m => ({ id: m.id, t: typeof completions[m.id] === 'string' ? new Date(completions[m.id]) : new Date(9e15) }))
    .sort((a, b) => a.t - b.t);
  const medalRank = {};
  completedSorted.forEach((m, i) => { if (i < 3) medalRank[m.id] = i; });

  const chips = memberList.map(m => {
    const done    = !!completions[m.id];
    const rank    = medalRank[m.id];
    const isMine  = m.id === memberId;
    let cls, icon;
    if (rank !== undefined) {
      cls  = MEDAL_CLS[rank];
      icon = MEDALS[rank];
    } else if (done) {
      cls  = 'chip-done'; icon = '✅';
    } else {
      cls  = (status === 'overdue' || status === 'today') ? 'chip-overdue' : 'chip-undone';
      icon = status === 'overdue' ? '🔴' : '⏳';
    }
    return `<span class="member-chip ${cls}${isMine ? ' chip-mine' : ''}"
      ${isMine ? `data-toggle-assign="${esc(a.id)}"` : `data-member-id="${esc(m.id)}"`}
      title="${esc(m.name)}">${icon} ${esc(m.name)}</span>`;
  }).join('');

  const nudgeable = memberList.filter(m => m.id !== memberId && !completions[m.id]);
  const nudgeButtons = nudgeable.map(m =>
    `<button class="btn-nudge" data-nudge-assign="${esc(a.id)}" data-nudge-to="${esc(m.id)}">📣 ${esc(m.name)}に通知</button>`
  ).join('');

  const doneCount = memberList.filter(m => !!completions[m.id]).length;
  const pct = memberList.length > 0 ? Math.round(doneCount / memberList.length * 100) : 0;

  return `
    <div class="completion-section">
      <div class="completion-header">
        <div class="completion-label">完了状況</div>
        <div class="completion-rate">${doneCount}/${memberList.length}人</div>
      </div>
      <div class="completion-bar"><div class="completion-bar-fill" style="width:${pct}%"></div></div>
      <div class="member-chips">${chips}</div>
      ${nudgeButtons ? `<div class="nudge-row">${nudgeButtons}</div>` : ''}
    </div>`;
}

function renderAttachments(a) {
  const files = a.files || [];
  if (!files.length) return '';
  const chips = files.map(f => {
    const icon = f.type && f.type.startsWith('image') ? '🖼️' : '📄';
    return `<a class="attachment-chip" href="${esc(f.url)}" target="_blank" rel="noopener">${icon} ${esc(f.name)}</a>`;
  }).join('');
  return `<div class="attachments-row">${chips}</div>`;
}

function renderList() {
  const list  = document.getElementById('list');
  const empty = document.getElementById('empty');
  const items = getFiltered();
  if (!items.length) { list.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  list.innerHTML = items.map(a => {
    const myDone = !!(a.completions || {})[memberId];
    const status = deadlineStatus(a.deadline, myDone);
    const bc = badgeClass(status, a.type);
    const bl = badgeLabel(status, a.deadline, a);
    const cd = (!myDone && status !== 'overdue') ? countdown(a.deadline) : '';
    const typeLabel = a.type === 'exam' ? '📝 テスト' : '📋 課題';
    return `
      <div class="card${myDone ? ' done-card' : ''}" data-id="${esc(a.id)}">
        <div class="card-top">
          <span class="card-subject">${esc(a.subject)}</span>
          <div class="card-deadline-wrap">
            <span class="deadline-badge ${bc}">${bl}</span>
            ${cd ? `<span class="countdown" data-deadline="${esc(a.deadline)}">${cd}</span>` : ''}
          </div>
        </div>
        <div class="card-type-label">${typeLabel}</div>
        ${a.content ? `<div class="card-content">${esc(a.content)}</div>` : ''}
        ${a.memo    ? `<div class="card-memo">${esc(a.memo)}</div>` : ''}
        ${renderAttachments(a)}
        ${renderMemberChips(a)}
        <div class="card-actions-row">
          <div></div>
          <div class="card-edit-del">
            <button class="btn-icon" data-action="edit"   data-id="${esc(a.id)}" title="編集">✏️</button>
            <button class="btn-icon" data-action="delete" data-id="${esc(a.id)}" title="削除">🗑️</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Assignment CRUD ───────────────────────────────────────────
function openAssignmentModal(id = null) {
  editingAssignmentId = id;
  pendingFiles = [];
  const a = id ? assignments[id] : null;
  const type = a ? (a.type || 'assignment') : 'assignment';
  const mode = a ? (a.deadlineMode || 'datetime') : 'datetime';
  document.getElementById('modal-assignment-title').textContent = id ? '課題を編集' : '課題を追加';
  document.getElementById('f-subject').value = a ? a.subject : '';
  document.getElementById('f-content').value = a ? a.content : '';
  document.getElementById('f-memo').value    = a ? a.memo    : '';
  document.getElementById('file-list').innerHTML = '';
  document.getElementById('existing-files').innerHTML = (a && a.files && a.files.length)
    ? a.files.map(f => `<div class="file-item"><span class="file-item-name">${esc(f.name)}</span></div>`).join('')
    : '';
  setAssignmentType(type);
  setDeadlineMode(mode);
  if (mode === 'period' && a) {
    document.getElementById('f-deadline-date').value = (a.deadline || '').split('T')[0];
    document.getElementById('f-period').value = String(a.period || 1);
    document.getElementById('f-deadline').value = '';
  } else {
    document.getElementById('f-deadline').value = a ? (a.deadline || '') : '';
  }
  document.getElementById('modal-assignment').hidden = false;
  document.getElementById('f-subject').focus();
}

function closeAssignmentModal() {
  document.getElementById('modal-assignment').hidden = true;
  editingAssignmentId = null;
  pendingFiles = [];
}

function setAssignmentType(type) {
  currentType = type;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  const lbl = document.getElementById('label-deadline');
  const lc  = document.getElementById('label-content');
  const fc  = document.getElementById('f-content');
  if (type === 'exam') {
    lbl.childNodes[0].textContent = '日時 ';
    lc.textContent = '出題範囲';
    fc.placeholder = '例：第1章〜第3章、p.1-60';
  } else {
    lbl.childNodes[0].textContent = '締め切り ';
    lc.textContent = '内容';
    fc.placeholder = '課題の内容や指示を入力';
  }
}

function periodToISO(dateStr, period) {
  const [h, m] = PERIOD_END[+period] || [9, 20];
  return `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
}

function setDeadlineMode(mode) {
  deadlineMode = mode;
  const isDt = mode === 'datetime';
  document.querySelectorAll('.deadline-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  const dtField = document.getElementById('f-deadline');
  const periodFields = document.getElementById('period-mode-fields');
  dtField.style.display = isDt ? '' : 'none';
  dtField.required = isDt;
  periodFields.style.display = isDt ? 'none' : 'flex';
  document.getElementById('f-deadline-date').required = !isDt;
}

async function saveAssignment(e) {
  e.preventDefault();
  const subject = document.getElementById('f-subject').value.trim();
  const content = document.getElementById('f-content').value.trim();
  const memo    = document.getElementById('f-memo').value.trim();
  const btn     = document.getElementById('btn-assignment-submit');

  let deadline, period = null;
  if (deadlineMode === 'period') {
    const dateStr = document.getElementById('f-deadline-date').value;
    period = +document.getElementById('f-period').value;
    if (!dateStr) { showToast('日付を入力してください'); return; }
    deadline = periodToISO(dateStr, period);
  } else {
    deadline = document.getElementById('f-deadline').value;
  }

  btn.disabled = true;
  btn.textContent = '保存中…';

  // Upload pending files
  let newFiles = [];
  for (const file of pendingFiles) {
    try {
      const path = `groups/${groupId}/assignments/${editingAssignmentId || 'new'}/${Date.now()}_${file.name}`;
      const ref  = storage.ref(path);
      await ref.put(file);
      const url  = await ref.getDownloadURL();
      newFiles.push({ name: file.name, url, type: file.type, uploadedBy: memberId, uploadedAt: new Date().toISOString() });
    } catch { showToast('ファイルのアップロードに失敗しました'); }
  }

  const existingFiles = editingAssignmentId && assignments[editingAssignmentId]
    ? (assignments[editingAssignmentId].files || []) : [];

  const data = {
    subject, deadline, content, memo,
    type: currentType,
    deadlineMode,
    period,
    files: [...existingFiles, ...newFiles]
  };

  if (editingAssignmentId) {
    await db.collection('groups').doc(groupId).collection('assignments')
      .doc(editingAssignmentId).update(data);
  } else {
    await db.collection('groups').doc(groupId).collection('assignments').add({
      ...data,
      completions: {},
      createdBy: memberId,
      createdAt: new Date().toISOString()
    });
  }

  btn.disabled = false;
  btn.textContent = '保存';
  closeAssignmentModal();
  showToast(editingAssignmentId ? '更新しました' : '課題を追加しました');
}

async function deleteAssignment(id) {
  if (!confirm('削除しますか？')) return;
  await db.collection('groups').doc(groupId).collection('assignments').doc(id).delete();
  showToast('削除しました');
}

async function toggleMyCompletion(assignmentId) {
  const a    = assignments[assignmentId];
  if (!a) return;
  const done = !!(a.completions || {})[memberId];
  // 完了時刻を記録（取消時は null）
  await db.collection('groups').doc(groupId).collection('assignments')
    .doc(assignmentId).update({ [`completions.${memberId}`]: done ? null : new Date().toISOString() });
}

// ── Nudge ─────────────────────────────────────────────────────
async function sendNudge(assignmentId, toMemberId) {
  const a = assignments[assignmentId];
  if (!a) return;
  const from = members[memberId];
  await db.collection('groups').doc(groupId).collection('nudges').add({
    fromMemberId: memberId,
    toMemberId,
    assignmentId,
    subject: a.subject,
    fromName: from ? from.name : '',
    createdAt: new Date().toISOString(),
    read: false
  });
  showToast('通知を送りました 📣');
}

function processNudgeQueue() {
  if (nudgeShowing || nudgeQueue.length === 0) return;
  const nudge = nudgeQueue.shift();
  showNudgePopup(nudge);
}

function showNudgePopup(nudge) {
  nudgeShowing = true;
  const popup = document.getElementById('nudge-popup');
  document.getElementById('nudge-popup-title').textContent = `📣 ${nudge.fromName || '誰か'}から通知が来ました`;
  document.getElementById('nudge-popup-body').textContent  = `「${nudge.subject || '課題'}」まだ終わってないよ！`;

  const from = members[nudge.fromMemberId] || {};
  const actions = document.getElementById('nudge-popup-actions');
  actions.innerHTML = '';
  if (from.instagramId) {
    const a = document.createElement('a');
    a.className = 'nudge-popup-link';
    a.href = `https://instagram.com/${from.instagramId}`;
    a.target = '_blank'; a.rel = 'noopener';
    a.textContent = '📸 Instagram';
    actions.appendChild(a);
  }
  if (from.lineId) {
    const a = document.createElement('a');
    a.className = 'nudge-popup-link';
    a.href = `https://line.me/ti/p/${encodeURIComponent(from.lineId)}`;
    a.target = '_blank'; a.rel = 'noopener';
    a.textContent = '💬 LINE';
    actions.appendChild(a);
  }
  if (from.email) {
    const a = document.createElement('a');
    a.className = 'nudge-popup-link';
    a.href = `mailto:${from.email}`;
    a.textContent = '📧 メール';
    actions.appendChild(a);
  }

  popup.classList.add('show');

  // Mark read
  db.collection('groups').doc(groupId).collection('nudges').doc(nudge.id)
    .update({ read: true }).catch(() => {});

  setTimeout(dismissNudgePopup, 8000);
}

function dismissNudgePopup() {
  document.getElementById('nudge-popup').classList.remove('show');
  nudgeShowing = false;
  setTimeout(processNudgeQueue, 500);
}

// ── Member profile modal ──────────────────────────────────────
function openMemberModal(mId) {
  const m = members[mId];
  if (!m) return;
  const totalAssign = Object.values(assignments).length;
  const doneCount   = Object.values(assignments).filter(a => !!(a.completions || {})[mId]).length;
  document.getElementById('member-modal-avatar').textContent = (m.name || '?')[0];
  document.getElementById('member-modal-name').textContent   = m.name;
  document.getElementById('member-modal-stat').textContent   = `${doneCount} / ${totalAssign} 件完了`;

  const contacts = document.getElementById('member-modal-contacts');
  contacts.innerHTML = '';
  if (m.instagramId) {
    contacts.insertAdjacentHTML('beforeend',
      `<a class="contact-link" href="https://instagram.com/${esc(m.instagramId)}" target="_blank" rel="noopener">
        <span class="contact-icon">📸</span> Instagram: @${esc(m.instagramId)}</a>`);
  }
  if (m.lineId) {
    contacts.insertAdjacentHTML('beforeend',
      `<a class="contact-link" href="https://line.me/ti/p/${encodeURIComponent(m.lineId)}" target="_blank" rel="noopener">
        <span class="contact-icon">💬</span> LINE: ${esc(m.lineId)}</a>`);
  }
  if (m.email) {
    contacts.insertAdjacentHTML('beforeend',
      `<a class="contact-link" href="mailto:${esc(m.email)}">
        <span class="contact-icon">📧</span> ${esc(m.email)}</a>`);
  }
  if (!m.instagramId && !m.lineId && !m.email) {
    contacts.innerHTML = '<div style="color:var(--text-sub);font-size:14px">連絡先未登録</div>';
  }
  document.getElementById('modal-member').hidden = false;
}

// ── My profile edit ───────────────────────────────────────────
function openMyProfileModal() {
  const me = members[memberId] || {};
  document.getElementById('mp-name').value      = me.name || '';
  document.getElementById('mp-instagram').value = me.instagramId || '';
  document.getElementById('mp-line').value      = me.lineId || '';
  document.getElementById('mp-email-display').textContent = auth.currentUser ? auth.currentUser.email : '';
  document.getElementById('mp-new-password').value  = '';
  document.getElementById('mp-new-password2').value = '';
  document.getElementById('modal-my-profile').hidden = false;
}

async function saveMyProfile() {
  const name      = document.getElementById('mp-name').value.trim();
  const instagram = document.getElementById('mp-instagram').value.trim().replace(/^@/, '');
  const line      = document.getElementById('mp-line').value.trim();
  const newPw     = document.getElementById('mp-new-password').value;
  const newPw2    = document.getElementById('mp-new-password2').value;
  if (!name) { showToast('名前を入力してください'); return; }
  if (newPw) {
    if (newPw.length < 6)   { showToast('パスワードは6文字以上にしてください'); return; }
    if (newPw !== newPw2)   { showToast('パスワードが一致しません'); return; }
    try {
      await auth.currentUser.updatePassword(newPw);
    } catch (err) {
      if (err.code === 'auth/requires-recent-login') {
        showToast('パスワード変更には再ログインが必要です。一度ログアウトして再度ログインしてください');
      } else {
        showToast('パスワード変更に失敗しました');
      }
      return;
    }
  }
  await db.collection('groups').doc(groupId).collection('members').doc(memberId)
    .update({ name, instagramId: instagram, lineId: line });
  document.getElementById('modal-my-profile').hidden = true;
  showToast(newPw ? 'プロフィールとパスワードを更新しました' : 'プロフィールを更新しました');
}

async function leaveGroup() {
  if (!confirm('このグループから退出しますか？')) return;
  await db.collection('groups').doc(groupId).collection('members').doc(memberId).delete();
  removeGroup(groupId);
  location.reload();
}

// ── Profile setup screen ──────────────────────────────────────
async function saveProfile() {
  const instagram = document.getElementById('p-instagram').value.trim().replace(/^@/, '');
  const line      = document.getElementById('p-line').value.trim();
  await db.collection('groups').doc(groupId).collection('members').doc(memberId)
    .update({ instagramId: instagram, lineId: line });
  showScreen('main');
}

// ── File handling ─────────────────────────────────────────────
function handleFileInput(files) {
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { showToast(f.name + ' は20MB超のためスキップ'); continue; }
    if (!f.type.startsWith('image/') && f.type !== 'application/pdf') {
      showToast(f.name + ' はPDF・画像のみ対応'); continue;
    }
    pendingFiles.push(f);
    const item = document.createElement('div');
    item.className = 'file-item';
    const icon = f.type.startsWith('image') ? '🖼️' : '📄';
    item.innerHTML = `<span class="file-item-name">${icon} ${esc(f.name)}</span>
      <button type="button" class="file-item-remove" data-fname="${esc(f.name)}">✕</button>`;
    document.getElementById('file-list').appendChild(item);
  }
}

// ── Invite code copy ──────────────────────────────────────────
async function copyGroupCode() {
  const url = location.origin + location.pathname.replace('watch.html', '') + 'watch.html';
  const text = `課題同盟「${groupName}」に参加しよう！\n招待コード: ${groupCode}\n${url}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast('招待コードをコピーしました 🔗');
  } catch {
    prompt('招待コード', groupCode);
  }
}

// ── Toast ─────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Event wiring ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Welcome
  document.getElementById('btn-join').addEventListener('click', async () => {
    const name  = document.getElementById('w-name').value.trim();
    const email = document.getElementById('w-email').value.trim();
    const pw    = document.getElementById('w-password').value;
    const code  = document.getElementById('w-code').value.trim();
    if (!name)  { showToast('名前を入力してください'); return; }
    if (!email || !isValidEmail(email)) { showToast('正しいメールアドレスを入力してください'); return; }
    if (pw.length < 6) { showToast('パスワードは6文字以上にしてください'); return; }
    document.getElementById('btn-join').disabled = true;
    if (!code) {
      // 招待コードなし → アカウントだけ作成して待機
      if (!(await registerAndProceed(email, pw).finally(() => { document.getElementById('btn-join').disabled = false; }))) return;
      showToast('アカウントを作成しました。招待コードを入力してグループに参加してください');
      document.getElementById('w-name').value = name;
    } else {
      await joinGroup(name, email, pw, code).finally(() => { document.getElementById('btn-join').disabled = false; });
    }
  });
  document.getElementById('btn-create').addEventListener('click', async () => {
    const name  = document.getElementById('c-name').value.trim();
    const email = document.getElementById('c-email').value.trim();
    const pw    = document.getElementById('c-password').value;
    const gName = document.getElementById('c-group').value.trim();
    if (!name)  { showToast('名前を入力してください'); return; }
    if (!email || !isValidEmail(email)) { showToast('正しいメールアドレスを入力してください'); return; }
    if (pw.length < 6) { showToast('パスワードは6文字以上にしてください'); return; }
    if (!gName) { showToast('グループ名を入力してください'); return; }
    document.getElementById('btn-create').disabled = true;
    await createGroup(name, email, pw, gName).finally(() => { document.getElementById('btn-create').disabled = false; });
  });
  document.getElementById('btn-login').addEventListener('click', async () => {
    const email = document.getElementById('l-email').value.trim();
    const pw    = document.getElementById('l-password').value;
    if (!email) { showToast('メールアドレスを入力してください'); return; }
    if (!pw)    { showToast('パスワードを入力してください'); return; }
    document.getElementById('btn-login').disabled = true;
    await loginExisting(email, pw).finally(() => { document.getElementById('btn-login').disabled = false; });
  });
  document.getElementById('link-create').addEventListener('click', () => {
    document.getElementById('card-join').style.display = 'none';
    document.getElementById('card-create').style.display = 'block';
    document.getElementById('card-login').style.display = 'none';
  });
  document.getElementById('link-join').addEventListener('click', () => {
    document.getElementById('card-create').style.display = 'none';
    document.getElementById('card-join').style.display = 'block';
    document.getElementById('card-login').style.display = 'none';
  });
  ['link-login', 'link-login2'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      document.getElementById('card-join').style.display = 'none';
      document.getElementById('card-create').style.display = 'none';
      document.getElementById('card-login').style.display = 'block';
    });
  });
  document.getElementById('link-back-join').addEventListener('click', showCardJoin);

  // Profile setup
  document.getElementById('btn-profile-save').addEventListener('click', saveProfile);
  document.getElementById('btn-profile-skip').addEventListener('click', () => showScreen('main'));

  // Header
  document.getElementById('btn-code').addEventListener('click', copyGroupCode);
  document.getElementById('btn-my-profile').addEventListener('click', openMyProfileModal);
  document.getElementById('btn-notif').addEventListener('click', () => {
    // Mark all nudges read by showing queue
    processNudgeQueue();
  });

  // Filter tabs
  document.getElementById('filter-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.filter;
    renderList();
  });

  // Deadline mode toggle
  document.getElementById('deadline-mode-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.deadline-mode-btn');
    if (btn) setDeadlineMode(btn.dataset.mode);
  });

  // FAB / assignment
  document.getElementById('btn-add').addEventListener('click', () => openAssignmentModal());
  document.getElementById('btn-assignment-cancel').addEventListener('click', closeAssignmentModal);
  document.getElementById('modal-assignment').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAssignmentModal();
  });
  document.getElementById('form-assignment').addEventListener('submit', saveAssignment);
  document.querySelector('.type-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.type-btn');
    if (btn) setAssignmentType(btn.dataset.type);
  });

  // File drop
  const fileDrop = document.getElementById('file-drop');
  fileDrop.addEventListener('click', () => document.getElementById('f-files').click());
  document.getElementById('f-files').addEventListener('change', e => handleFileInput(e.target.files));
  fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.classList.add('drag-over'); });
  fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag-over'));
  fileDrop.addEventListener('drop', e => {
    e.preventDefault(); fileDrop.classList.remove('drag-over');
    handleFileInput(e.dataTransfer.files);
  });
  document.getElementById('file-list').addEventListener('click', e => {
    const btn = e.target.closest('.file-item-remove');
    if (!btn) return;
    const fname = btn.dataset.fname;
    pendingFiles = pendingFiles.filter(f => f.name !== fname);
    btn.closest('.file-item').remove();
  });

  // List interactions (delegation)
  document.getElementById('list').addEventListener('click', e => {
    const chip = e.target.closest('[data-toggle-assign]');
    if (chip) { toggleMyCompletion(chip.dataset.toggleAssign); return; }

    const memberChip = e.target.closest('[data-member-id]');
    if (memberChip) { openMemberModal(memberChip.dataset.memberId); return; }

    const nudgeBtn = e.target.closest('[data-nudge-assign]');
    if (nudgeBtn) { sendNudge(nudgeBtn.dataset.nudgeAssign, nudgeBtn.dataset.nudgeTo); return; }

    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      if (actionBtn.dataset.action === 'edit')   openAssignmentModal(actionBtn.dataset.id);
      if (actionBtn.dataset.action === 'delete') deleteAssignment(actionBtn.dataset.id);
    }
  });

  // Member modal
  document.getElementById('btn-member-close').addEventListener('click',  () => { document.getElementById('modal-member').hidden = true; });
  document.getElementById('btn-member-close2').addEventListener('click', () => { document.getElementById('modal-member').hidden = true; });
  document.getElementById('modal-member').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });

  // My profile modal
  document.getElementById('btn-mp-cancel').addEventListener('click', () => { document.getElementById('modal-my-profile').hidden = true; });
  document.getElementById('btn-mp-save').addEventListener('click', saveMyProfile);
  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (!confirm('ログアウトしますか？')) return;
    await auth.signOut();
    localStorage.removeItem(LS_GROUPS);
    location.reload();
  });
  document.getElementById('btn-leave').addEventListener('click', leaveGroup);
  document.getElementById('modal-my-profile').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });

  // Nudge popup
  document.getElementById('nudge-popup-close').addEventListener('click', dismissNudgePopup);

  // Enter key on code input
  document.getElementById('w-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });

  init();
});
