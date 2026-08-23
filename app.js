import { ALLOWED_REACTIONS } from './shared/chat.js';

const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');

const state = {
  user: null,
  messages: [],
  reactions: {},
  members: [],
  replyTo: null,
  nextCursor: null,
  search: '',
  pinned: false,
  pollTimer: null,
  loading: false,
};

boot();

async function boot() {
  registerServiceWorker();
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
  } catch {
    state.user = null;
  }
  if (!state.user) renderAuth('login');
  else mountChat();
}

function renderAuth(mode = 'login') {
  stopPolling();
  const labels = { login: 'ログイン', register: '招待で参加', bootstrap: '初回設定' };
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-card">
        <span class="eyebrow">PRIVATE FAMILY SPACE</span>
        <h1>Family S</h1>
        <p>家族だけで使う、シンプルなプライベートチャットです。公開プロフィールやおすすめ機能はありません。</p>
        <div class="tabs" role="tablist">
          ${Object.entries(labels).map(([key,label]) => `<button class="tab ${mode===key?'active':''}" data-auth-tab="${key}">${label}</button>`).join('')}
        </div>
        ${authForm(mode)}
      </section>
    </main>`;

  app.querySelectorAll('[data-auth-tab]').forEach(button => button.addEventListener('click', () => renderAuth(button.dataset.authTab)));
  app.querySelector('form')?.addEventListener('submit', event => submitAuth(event, mode));
}

function authForm(mode) {
  if (mode === 'register') return `
    <form class="form">
      <label>招待コード<input class="input" name="inviteCode" autocomplete="one-time-code" required></label>
      <label>ユーザー名<input class="input" name="username" autocomplete="username" pattern="[A-Za-z0-9_]{3,24}" required></label>
      <label>表示名<input class="input" name="displayName" maxlength="40" required></label>
      <label>パスワード<input class="input" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label>
      <button class="btn primary" type="submit">家族スペースに参加</button>
    </form>`;
  if (mode === 'bootstrap') return `
    <form class="form">
      <p class="hint">最初の1人だけ使用します。Cloudflareに設定した <code>FAMILY_SETUP_SECRET</code> を入力してください。</p>
      <label>セットアップSecret<input class="input" name="setupSecret" type="password" autocomplete="off" required></label>
      <label>ユーザー名<input class="input" name="username" autocomplete="username" pattern="[A-Za-z0-9_]{3,24}" required></label>
      <label>表示名<input class="input" name="displayName" maxlength="40" required></label>
      <label>パスワード<input class="input" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label>
      <button class="btn primary" type="submit">家族スペースを作成</button>
    </form>`;
  return `
    <form class="form">
      <label>ユーザー名<input class="input" name="username" autocomplete="username" required></label>
      <label>パスワード<input class="input" name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
      <button class="btn primary" type="submit">ログイン</button>
    </form>`;
}

async function submitAuth(event, mode) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const data = Object.fromEntries(new FormData(form));
  try {
    let response;
    if (mode === 'bootstrap') {
      response = await api('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'X-Family-Setup-Secret': String(data.setupSecret || '') },
        body: { username: data.username, displayName: data.displayName, password: data.password },
      });
    } else if (mode === 'register') {
      response = await api('/api/auth/register', { method: 'POST', body: data });
    } else {
      response = await api('/api/auth/login', { method: 'POST', body: { username: data.username, password: data.password } });
    }
    state.user = response.user;
    toast('ログインしました');
    mountChat();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function mountChat() {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-dot"></span>Family S</div>
        <section class="sidebar-section">
          <span class="eyebrow">FAMILY MEMBERS</span>
          <div id="memberList"></div>
        </section>
        <div class="sidebar-actions">
          ${state.user.role === 'owner' ? '<button class="btn" id="createInvite">＋ 招待コードを作る</button><button class="btn" id="manageInvites">招待を管理</button>' : ''}
          <button class="btn" id="security">🔐 セキュリティ</button>
          <button class="btn" id="showPinned">📌 固定メッセージ</button>
          <button class="btn" id="logout">ログアウト</button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <button class="btn small mobile-members" id="mobileMembers">家族</button>
          <h1 id="viewTitle">家族チャット</h1>
          <span class="spacer"></span>
          <form class="search" id="searchForm">
            <input class="input" id="searchInput" placeholder="メッセージを検索" maxlength="100" aria-label="メッセージを検索">
            <button class="btn" type="submit">検索</button>
          </form>
        </header>
        <section class="timeline" id="timeline" aria-live="polite"></section>
        <div class="composer-wrap">
          <form class="composer" id="composer">
            <div id="replyBar"></div>
            <div class="composer-row">
              <textarea class="textarea" id="messageInput" rows="1" maxlength="2000" placeholder="家族にメッセージ" aria-label="メッセージ"></textarea>
              <button class="btn primary" type="submit">送信</button>
            </div>
          </form>
        </div>
      </main>
    </div>`;

  app.querySelector('#logout').addEventListener('click', logout);
  app.querySelector('#security').addEventListener('click', showSecurityModal);
  app.querySelector('#createInvite')?.addEventListener('click', createInvite);
  app.querySelector('#manageInvites')?.addEventListener('click', manageInvites);
  app.querySelector('#showPinned').addEventListener('click', togglePinned);
  app.querySelector('#mobileMembers')?.addEventListener('click', showMembersModal);
  app.querySelector('#searchForm').addEventListener('submit', submitSearch);
  app.querySelector('#composer').addEventListener('submit', sendMessage);
  app.querySelector('#memberList').addEventListener('click', handleMemberAction);
  app.querySelector('#messageInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      app.querySelector('#composer').requestSubmit();
    }
  });
  app.querySelector('#timeline').addEventListener('click', handleTimelineAction);

  refreshAll(true);
  startPolling();
}

async function refreshAll(initial = false) {
  await Promise.allSettled([refreshMessages(initial), refreshMembers()]);
}

async function refreshMessages(initial = false) {
  if (state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams({ limit: '60' });
    if (state.search) params.set('q', state.search);
    if (state.pinned) params.set('pinned', '1');
    const payload = await api(`/api/messages?${params}`);
    state.messages = payload.messages || [];
    state.reactions = payload.reactions || {};
    state.nextCursor = payload.nextCursor || null;
    renderTimeline();
    if (state.messages.length && !state.search && !state.pinned) {
      const newest = state.messages[state.messages.length - 1];
      api('/api/read', { method: 'POST', body: { lastMessageAt: newest.createdAt } }).catch(() => {});
      if (initial) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' }));
    }
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      renderAuth('login');
    } else if (initial) toast(error.message);
  } finally {
    state.loading = false;
  }
}

async function loadOlder() {
  if (!state.nextCursor || state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams({ limit: '60', cursor: state.nextCursor });
    if (state.search) params.set('q', state.search);
    if (state.pinned) params.set('pinned', '1');
    const payload = await api(`/api/messages?${params}`);
    const known = new Set(state.messages.map(message => message.id));
    state.messages = [...(payload.messages || []).filter(message => !known.has(message.id)), ...state.messages];
    state.reactions = { ...(payload.reactions || {}), ...state.reactions };
    state.nextCursor = payload.nextCursor || null;
    renderTimeline();
  } catch (error) {
    toast(error.message);
  } finally {
    state.loading = false;
  }
}

async function refreshMembers() {
  try {
    const payload = await api('/api/members');
    state.members = payload.members || [];
    renderMembers();
  } catch {}
}

function renderMembers() {
  const list = app.querySelector('#memberList');
  if (!list) return;
  list.innerHTML = state.members.map(member => `
    <div class="member">
      <span class="avatar">${escapeHtml(initials(member.displayName))}</span>
      <div class="member-meta">
        <strong>${escapeHtml(member.displayName)}${member.disabled ? ' · 停止中' : ''}</strong>
        <small>@${escapeHtml(member.username)}${member.role === 'owner' ? ' · owner' : ''}</small>
      </div>
      ${state.user.role === 'owner' && member.role !== 'owner' ? `<button class="btn small" data-member-action="${member.disabled ? 'enable' : 'disable'}" data-member-id="${attr(member.id)}">${member.disabled ? '再開' : '停止'}</button>` : ''}
    </div>`).join('') || '<div class="hint">読み込み中…</div>';
}

async function handleMemberAction(event) {
  const button = event.target.closest('[data-member-action]');
  if (!button || state.user.role !== 'owner') return;
  const member = state.members.find(item => item.id === button.dataset.memberId);
  if (!member) return;
  const disabling = button.dataset.memberAction === 'disable';
  if (!confirm(`${member.displayName} のログインを${disabling ? '停止' : '再開'}しますか？${disabling ? ' 現在の全セッションも失効します。' : ''}`)) return;
  try {
    await api(`/api/members/${encodeURIComponent(member.id)}/disable`, { method: disabling ? 'POST' : 'DELETE' });
    await refreshMembers();
    toast(disabling ? 'メンバーを停止しました' : 'メンバーを再開しました');
  } catch (error) {
    toast(error.message);
  }
}

function renderTimeline() {
  const timeline = app.querySelector('#timeline');
  const title = app.querySelector('#viewTitle');
  if (!timeline || !title) return;
  title.textContent = state.search ? `検索: ${state.search}` : state.pinned ? '固定メッセージ' : '家族チャット';

  const controls = `${state.nextCursor ? '<div class="load-row"><button class="btn small" data-action="older">古いメッセージを読み込む</button></div>' : ''}${(state.search || state.pinned) ? '<div class="load-row"><button class="btn small" data-action="clear-view">通常表示に戻る</button></div>' : ''}`;
  if (!state.messages.length) {
    timeline.innerHTML = `${controls}<div class="empty">${state.search ? '一致するメッセージはありません。' : state.pinned ? '固定メッセージはありません。' : 'まだメッセージがありません。最初のひとことを送ってみましょう。'}</div>`;
    return;
  }
  timeline.innerHTML = controls + state.messages.map(renderMessage).join('');
}

function renderMessage(message) {
  const reactionMap = new Map((state.reactions[message.id] || []).map(item => [item.emoji, item]));
  const reactions = ALLOWED_REACTIONS.map(emoji => {
    const item = reactionMap.get(emoji);
    if (!item) return `<button class="action-link" data-action="react" data-id="${attr(message.id)}" data-emoji="${emoji}" aria-label="${emoji}でリアクション">${emoji}</button>`;
    return `<button class="reaction ${item.reacted ? 'active' : ''}" data-action="react" data-id="${attr(message.id)}" data-emoji="${emoji}">${emoji} ${item.count}</button>`;
  }).join('');
  const mine = message.userId === state.user.id;
  return `
    <article class="message" data-message-id="${attr(message.id)}">
      <span class="avatar">${escapeHtml(initials(message.displayName))}</span>
      <div>
        <div class="message-head">
          <strong>${escapeHtml(message.displayName)}</strong>
          <span class="handle">@${escapeHtml(message.username)}</span>
          <time class="time">${escapeHtml(formatTime(message.createdAt))}${message.editedAt ? ' · 編集済み' : ''}</time>
          ${message.pinnedAt ? '<span class="pinned">📌 固定</span>' : ''}
        </div>
        ${message.replyTo ? `<div class="reply-context">↳ ${escapeHtml(message.replyDisplayName || '削除済み')}: ${escapeHtml(shorten(message.replyBody || 'メッセージはありません', 110))}</div>` : ''}
        <div class="message-body">${formatBody(message.body)}</div>
        <div class="message-actions">
          <button class="action-link" data-action="reply" data-id="${attr(message.id)}">返信</button>
          ${reactions}
          ${mine ? `<button class="action-link" data-action="edit" data-id="${attr(message.id)}">編集</button>` : ''}
          ${(mine || state.user.role === 'owner') ? `<button class="action-link" data-action="delete" data-id="${attr(message.id)}">削除</button>` : ''}
          ${state.user.role === 'owner' ? `<button class="action-link" data-action="pin" data-id="${attr(message.id)}" data-pinned="${message.pinnedAt ? '1' : '0'}">${message.pinnedAt ? '固定解除' : '固定'}</button>` : ''}
          <span class="seen">${message.seenCount > 0 ? `既読 ${message.seenCount}` : ''}</span>
        </div>
      </div>
    </article>`;
}

async function handleTimelineAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'older') return loadOlder();
  if (action === 'clear-view') {
    state.search = '';
    state.pinned = false;
    const input = app.querySelector('#searchInput');
    if (input) input.value = '';
    return refreshMessages();
  }
  const id = button.dataset.id;
  const message = state.messages.find(item => item.id === id);
  if (!message) return;
  if (action === 'reply') {
    state.replyTo = message;
    renderReplyBar();
    app.querySelector('#messageInput')?.focus();
  } else if (action === 'react') {
    await mutate(() => api('/api/reactions', { method: 'POST', body: { messageId: id, emoji: button.dataset.emoji } }));
  } else if (action === 'edit') {
    const body = prompt('メッセージを編集', message.body);
    if (body === null || body.trim() === message.body) return;
    await mutate(() => api(`/api/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: { body } }));
  } else if (action === 'delete') {
    if (!confirm('このメッセージを削除しますか？')) return;
    await mutate(() => api(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  } else if (action === 'pin') {
    await mutate(() => api(`/api/messages/${encodeURIComponent(id)}/pin`, { method: 'POST', body: { pinned: button.dataset.pinned !== '1' } }));
  }
}

async function mutate(operation) {
  try {
    await operation();
    await refreshMessages();
  } catch (error) {
    toast(error.message);
  }
}

function renderReplyBar() {
  const bar = app.querySelector('#replyBar');
  if (!bar) return;
  if (!state.replyTo) { bar.innerHTML = ''; return; }
  bar.innerHTML = `<div class="reply-bar"><span>${escapeHtml(state.replyTo.displayName)}に返信: ${escapeHtml(shorten(state.replyTo.body, 80))}</span><button type="button" class="action-link" id="cancelReply">×</button></div>`;
  bar.querySelector('#cancelReply').addEventListener('click', () => { state.replyTo = null; renderReplyBar(); });
}

async function sendMessage(event) {
  event.preventDefault();
  const input = app.querySelector('#messageInput');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const body = input.value.trim();
  if (!body) return;
  button.disabled = true;
  try {
    await api('/api/messages', { method: 'POST', body: { body, replyTo: state.replyTo?.id || null } });
    input.value = '';
    state.replyTo = null;
    renderReplyBar();
    state.search = '';
    state.pinned = false;
    await refreshMessages();
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function submitSearch(event) {
  event.preventDefault();
  const query = app.querySelector('#searchInput').value.trim();
  state.search = query;
  state.pinned = false;
  await refreshMessages();
}

async function togglePinned() {
  state.pinned = !state.pinned;
  state.search = '';
  const input = app.querySelector('#searchInput');
  if (input) input.value = '';
  await refreshMessages();
}

async function createInvite() {
  try {
    const payload = await api('/api/invites', { method: 'POST', body: {} });
    showModal(`
      <span class="eyebrow">SINGLE-USE INVITE</span>
      <h2>家族を招待</h2>
      <p class="hint">このコードは1回だけ使え、1時間で期限切れになります。安全な方法で家族本人に渡してください。</p>
      <div class="code-box">${escapeHtml(payload.inviteCode)}</div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn primary" id="copyInvite">コピー</button><button class="btn" data-close-modal>閉じる</button>
      </div>`);
    document.querySelector('#copyInvite')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(payload.inviteCode);
      toast('招待コードをコピーしました');
    });
  } catch (error) { toast(error.message); }
}

async function manageInvites() {
  try {
    const payload = await api('/api/invites');
    const invites = payload.invites || [];
    showModal(`
      <span class="eyebrow">ACTIVE INVITES</span>
      <h2>招待を管理</h2>
      <p class="hint">不要になった招待はすぐに取り消せます。</p>
      <div id="inviteList">${invites.length ? invites.map(invite => `
        <div class="member">
          <div class="member-meta"><strong>未使用の招待</strong><small>期限 ${escapeHtml(formatTime(invite.expiresAt))}</small></div>
          <button class="btn small" data-revoke-invite="${attr(invite.id)}">取消</button>
        </div>`).join('') : '<div class="hint">有効な招待はありません。</div>'}</div>
      <button class="btn" data-close-modal style="margin-top:12px">閉じる</button>`);
    document.querySelector('#inviteList')?.addEventListener('click', async event => {
      const button = event.target.closest('[data-revoke-invite]');
      if (!button || !confirm('この招待を取り消しますか？')) return;
      try {
        await api(`/api/invites/${encodeURIComponent(button.dataset.revokeInvite)}`, { method: 'DELETE' });
        button.closest('.member')?.remove();
        toast('招待を取り消しました');
      } catch (error) {
        toast(error.message);
      }
    });
  } catch (error) {
    toast(error.message);
  }
}

function showSecurityModal() {
  showModal(`
    <span class="eyebrow">ACCOUNT SECURITY</span>
    <h2>セキュリティ</h2>
    <form class="form" id="passwordForm">
      <label>現在のパスワード<input class="input" name="currentPassword" type="password" autocomplete="current-password" maxlength="128" required></label>
      <label>新しいパスワード<input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label>
      <button class="btn primary" type="submit">パスワードを変更</button>
    </form>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
      <button class="btn" id="logoutOthers">他の端末をログアウト</button>
      <button class="btn" id="logoutAll">全端末をログアウト</button>
      <button class="btn" data-close-modal>閉じる</button>
    </div>`);

  document.querySelector('#passwordForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api('/api/auth/change-password', { method: 'POST', body: data });
      event.currentTarget.reset();
      toast('パスワードを変更し、他のセッションを失効しました');
    } catch (error) {
      toast(error.message);
    }
  });
  document.querySelector('#logoutOthers')?.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout-others', { method: 'POST', body: {} });
      toast('他の端末をログアウトしました');
    } catch (error) { toast(error.message); }
  });
  document.querySelector('#logoutAll')?.addEventListener('click', async () => {
    if (!confirm('この端末を含む全端末からログアウトしますか？')) return;
    try {
      await api('/api/auth/logout-all', { method: 'POST', body: {} });
    } catch {}
    resetToLogin();
  });
}

function showMembersModal() {
  showModal(`<h2>家族メンバー</h2><div>${state.members.map(member => `<div class="member"><span class="avatar">${escapeHtml(initials(member.displayName))}</span><div class="member-meta"><strong>${escapeHtml(member.displayName)}${member.disabled ? ' · 停止中' : ''}</strong><small>@${escapeHtml(member.username)}${member.role === 'owner' ? ' · owner' : ''}</small></div></div>`).join('')}</div><button class="btn" data-close-modal style="margin-top:12px">閉じる</button>`);
}

function showModal(content) {
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-backdrop';
  wrapper.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${content}</div>`;
  const close = () => wrapper.remove();
  wrapper.addEventListener('click', event => { if (event.target === wrapper || event.target.closest('[data-close-modal]')) close(); });
  document.body.append(wrapper);
  wrapper.querySelector('button, input')?.focus();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
  resetToLogin();
}

function resetToLogin() {
  state.user = null;
  state.messages = [];
  state.members = [];
  stopPolling();
  document.querySelectorAll('.modal-backdrop').forEach(node => node.remove());
  renderAuth('login');
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible' || state.search || state.pinned) return;
    refreshMessages(false);
    refreshMembers();
  }, 2500);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user && !state.search && !state.pinned) refreshAll(false);
});

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }
  try {
    const response = await fetch(path, { method: options.method || 'GET', headers, body, credentials: 'same-origin', signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('通信がタイムアウトしました。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatBody(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

function shorten(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat('ja-JP', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function attr(value) { return escapeHtml(value); }

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}