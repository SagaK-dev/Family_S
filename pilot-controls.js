const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');

const observer = new MutationObserver(() => enhancePilotControls());
observer.observe(app, { childList: true, subtree: true });
enhancePilotControls();

document.addEventListener('click', event => {
  const auditButton = event.target.closest('#pilotAuditLog');
  if (auditButton) {
    event.preventDefault();
    void showAuditLog();
    return;
  }

  const selfDeleteButton = event.target.closest('#pilotDeleteAccount');
  if (selfDeleteButton) {
    event.preventDefault();
    showDeleteAccountModal();
    return;
  }

  const memberDeleteButton = event.target.closest('[data-pilot-delete-member]');
  if (memberDeleteButton) {
    event.preventDefault();
    const row = memberDeleteButton.closest('.member');
    const displayName = row?.querySelector('strong')?.textContent?.replace(' · 停止中', '') || 'このメンバー';
    showDeleteMemberModal(memberDeleteButton.dataset.pilotDeleteMember, displayName, row);
  }
});

function enhancePilotControls() {
  const sidebarActions = document.querySelector('.sidebar-actions');
  if (!sidebarActions) return;

  const isOwner = Boolean(document.querySelector('#createInvite'));
  const securityButton = document.querySelector('#security');

  if (isOwner && !document.querySelector('#pilotAuditLog')) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.id = 'pilotAuditLog';
    button.textContent = '🧾 監査ログ';
    sidebarActions.insertBefore(button, securityButton || null);
  }

  if (!isOwner && securityButton && !document.querySelector('#pilotDeleteAccount')) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.id = 'pilotDeleteAccount';
    button.textContent = '🗑️ 退会・データ削除';
    securityButton.insertAdjacentElement('afterend', button);
  }

  if (isOwner) {
    document.querySelectorAll('[data-member-action][data-member-id]').forEach(actionButton => {
      const memberId = actionButton.dataset.memberId;
      const row = actionButton.closest('.member');
      if (!memberId || !row || row.querySelector(`[data-pilot-delete-member="${cssEscape(memberId)}"]`)) return;
      const deleteButton = document.createElement('button');
      deleteButton.className = 'btn small';
      deleteButton.dataset.pilotDeleteMember = memberId;
      deleteButton.textContent = '削除';
      deleteButton.title = 'この参加者のアカウントとアプリ上の保存データを削除';
      actionButton.insertAdjacentElement('afterend', deleteButton);
    });
  }
}

async function showAuditLog() {
  try {
    const payload = await pilotApi('/api/audit?limit=100');
    const events = payload.events || [];
    showPilotModal(`
      <span class="eyebrow">PILOT AUDIT LOG</span>
      <h2>監査ログ</h2>
      <p class="hint">パスワード・メッセージ本文・招待コードは記録しません。管理・セキュリティ操作だけを表示します。</p>
      <div>${events.length ? events.map(event => `
        <div class="member">
          <div class="member-meta">
            <strong>${escapeHtml(auditLabel(event.eventType))}</strong>
            <small>${escapeHtml(formatAuditTime(event.createdAt))}${event.actorDisplayName ? ` · ${escapeHtml(event.actorDisplayName)}` : ''}${event.subjectDisplayName ? ` → ${escapeHtml(event.subjectDisplayName)}` : ''}</small>
          </div>
        </div>`).join('') : '<div class="hint">監査イベントはまだありません。</div>'}</div>
      <button class="btn" data-pilot-close style="margin-top:12px">閉じる</button>`);
  } catch (error) {
    toast(error.message);
  }
}

function showDeleteAccountModal() {
  showPilotModal(`
    <span class="eyebrow">PARTICIPANT WITHDRAWAL</span>
    <h2>退会・データ削除</h2>
    <p class="hint">この操作はアプリ上の通常操作では取り消せません。あなたのセッション、投稿、リアクション、既読情報など、アカウントに紐づくデータを削除します。Cloudflareの障害復旧履歴には保持期間中の過去状態が残る場合があります。</p>
    <form class="form" id="pilotDeleteAccountForm">
      <label>現在のパスワード<input class="input" name="currentPassword" type="password" autocomplete="current-password" maxlength="128" required></label>
      <label>確認のため DELETE と入力<input class="input" name="confirmation" autocomplete="off" pattern="DELETE" required></label>
      <button class="btn" type="submit">退会してデータを削除</button>
      <button class="btn" type="button" data-pilot-close>キャンセル</button>
    </form>`);

  document.querySelector('#pilotDeleteAccountForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!confirm('本当に退会して、アプリ上のアカウントと保存データを削除しますか？')) return;
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(event.currentTarget));
      await pilotApi('/api/auth/delete-account', { method: 'POST', body: data });
      location.reload();
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  });
}

function showDeleteMemberModal(memberId, displayName, row) {
  showPilotModal(`
    <span class="eyebrow">OWNER DATA DELETION</span>
    <h2>${escapeHtml(displayName)} のデータを削除</h2>
    <p class="hint">参加撤回など、削除依頼を確認した場合だけ使用してください。投稿・リアクション・既読・セッション等のアプリ上のデータが削除されます。Cloudflareの障害復旧履歴には保持期間中の過去状態が残る場合があります。</p>
    <form class="form" id="pilotDeleteMemberForm">
      <label>オーナーの現在のパスワード<input class="input" name="currentPassword" type="password" autocomplete="current-password" maxlength="128" required></label>
      <label>確認のため DELETE と入力<input class="input" name="confirmation" autocomplete="off" pattern="DELETE" required></label>
      <button class="btn" type="submit">参加者データを削除</button>
      <button class="btn" type="button" data-pilot-close>キャンセル</button>
    </form>`);

  document.querySelector('#pilotDeleteMemberForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!confirm(`${displayName} のアカウントとアプリ上の保存データを削除しますか？`)) return;
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(event.currentTarget));
      await pilotApi(`/api/members/${encodeURIComponent(memberId)}/delete`, { method: 'POST', body: data });
      row?.remove();
      closePilotModals();
      toast('参加者のアカウントとアプリ上の保存データを削除しました');
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  });
}

function showPilotModal(content) {
  closePilotModals();
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-backdrop pilot-modal-backdrop';
  wrapper.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${content}</div>`;
  wrapper.addEventListener('click', event => {
    if (event.target === wrapper || event.target.closest('[data-pilot-close]')) wrapper.remove();
  });
  document.body.append(wrapper);
  wrapper.querySelector('button, input')?.focus();
}

function closePilotModals() {
  document.querySelectorAll('.pilot-modal-backdrop').forEach(node => node.remove());
}

async function pilotApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: controller.signal,
    });
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

function auditLabel(eventType) {
  return ({
    password_changed: 'パスワード変更',
    account_deleted: '参加者が退会・データ削除',
    member_deleted: 'オーナーが参加者データを削除',
    member_disabled: '参加者のログイン停止',
    member_enabled: '参加者のログイン再開',
    sessions_revoked_all: '全端末ログアウト',
    invite_created: '招待コード作成',
    invite_revoked: '招待コード取消',
    message_deleted: 'メッセージ削除',
    message_pin_changed: '固定メッセージ変更',
  })[eventType] || eventType;
}

function formatAuditTime(timestamp) {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/[^A-Za-z0-9_-]/g, '\\$&');
}

function toast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}
