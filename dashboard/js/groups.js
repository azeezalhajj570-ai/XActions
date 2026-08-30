// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Groups dashboard page logic.
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

requireAuth();

let currentGroupId = null;
let currentGroup = null;
let stats = null;
let accountsCache = [];
let socket = null;

const $ = (sel) => document.querySelector(sel);

const STATUS_PILL = {
  PENDING: 'pill--pending',
  CLAIMED: 'pill--running',
  RUNNING: 'pill--running',
  COMPLETED: 'pill--completed',
  FAILED: 'pill--failed',
  CANCELLED: 'pill--paused',
  COOLDOWN: 'pill--pending',
  RATE_LIMITED: 'pill--pending',
};

async function loadAccounts() {
  const res = await apiRequest('/accounts');
  if (res.ok) {
    accountsCache = (res.data.accounts || []).filter((a) => a.isActive && a.hasCookie && !a.isBlocked);
    renderAccountSelect();
  }
}

function renderAccountSelect() {
  const sel = $('#account-select');
  if (!sel) return;
  const linkedIds = new Set((currentGroup?.accountIds || []).map(String));
  sel.innerHTML = accountsCache
    .filter((a) => !linkedIds.has(String(a.id)))
    .map((a) => `<option value="${a.id}">@${a.username}</option>`)
    .join('');
  if (accountsCache.length === 0) {
    sel.innerHTML = '<option value="">No eligible accounts — add one under Accounts</option>';
  }
}

async function loadGroups() {
  const res = await apiRequest('/groups');
  if (!res.ok) { showToast(res.data?.error || 'Failed to load groups', 'error'); return; }
  const groups = res.data.groups || [];
  const container = $('#groups-container');
  $('#groups-empty').style.display = groups.length ? 'none' : 'block';

  container.innerHTML = groups.map((g) => {
    const total = g._count.tasks || 0;
    const pill = g.paused ? '<span class="pill pill--paused">paused</span>' : '<span class="pill pill--running">auto</span>';
    return `
      <div class="card group-card" data-id="${g.id}">
        <div>
          <div class="group-card__name">${esc(g.name)} ${pill}</div>
          <div class="group-card__meta">${g._count.members} members · ${g._count.accounts} accounts · ${total} tasks</div>
        </div>
        <div class="group-card__actions">
          <button class="btn btn--secondary btn--sm" data-action="delete" data-id="${g.id}">Delete</button>
          <button class="btn btn--primary btn--sm" data-action="open" data-id="${g.id}">Open</button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('[data-action="open"]').forEach((b) =>
    b.addEventListener('click', () => openGroup(b.dataset.id)));
  container.querySelectorAll('[data-action="delete"]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete group and all its tasks?`)) return;
      const res = await apiRequest(`/groups/${b.dataset.id}`, { method: 'DELETE' });
      if (res.ok) { showToast('Group deleted', 'success'); loadGroups(); } else showToast(res.data?.error, 'error');
    }));
}

function openGroup(id) {
  currentGroupId = id;
  $('#view-list').style.display = 'none';
  $('#view-detail').style.display = 'block';
  joinGroupRoom(id);
  loadGroupDetail(id);
}

function showList() {
  currentGroupId = null;
  $('#view-detail').style.display = 'none';
  $('#view-list').style.display = 'block';
  if (socket) socket.emit('group:leave', currentGroupId);
  loadGroups();
}

async function loadGroupDetail(id) {
  const res = await apiRequest(`/groups/${id}`);
  if (!res.ok) { showToast(res.data?.error, 'error'); return; }
  currentGroup = res.data.group;
  stats = res.data.stats;
  const actions = currentGroup.actions || {};

  $('#detail-name').textContent = currentGroup.name;
  $('#detail-desc').textContent = currentGroup.description || '';
  $('#pause-pill').innerHTML = currentGroup.paused
    ? '<span class="pill pill--paused">paused</span>'
    : '<span class="pill pill--running">running</span>';

  // Actions tab
  ['like', 'comment', 'repost', 'follow'].forEach((a) => {
    const el = $(`#act-${a}`);
    if (el) el.checked = !!actions[a];
  });
  $('#cooldown-sec').value = currentGroup.cooldownSec || 0;
  $('#auto-execute').checked = !!currentGroup.autoExecute;

  currentGroup.accountIds = (await loadLinkedAccounts()) || [];
  renderStats();
  loadMembers();
  loadTasks();
  loadAccounts();
}

async function loadLinkedAccounts() {
  const res = await apiRequest(`/groups/${currentGroupId}/accounts`);
  if (!res.ok) return [];
  const accounts = res.data.accounts || [];
  $('#accounts-tbody').innerHTML = accounts.map((a) => `
    <tr>
      <td>@${esc(a.username)}</td>
      <td>${a.isActive ? '<span class="pill pill--completed">active</span>' : '<span class="pill pill--failed">inactive</span>'}</td>
      <td><button class="btn btn--danger btn--sm" data-unlink="${a.id}">Unlink</button></td>
    </tr>`).join('') || '<tr><td colspan="3" class="muted">No accounts linked.</td></tr>';

  $('#accounts-tbody').querySelectorAll('[data-unlink]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await apiRequest(`/groups/${currentGroupId}/accounts/${b.dataset.unlink}`, { method: 'DELETE' });
      if (res.ok) { showToast('Account unlinked', 'success'); loadGroupDetail(currentGroupId); } else showToast(res.data?.error, 'error');
    }));

  return accounts.map((a) => a.id);
}

function renderStats() {
  if (!stats) return;
  const s = stats;
  const cards = [
    { label: 'Members', val: s.members ?? 0, cls: '' },
    { label: 'Accounts', val: s.accounts ?? 0, cls: '' },
    { label: 'Pending', val: s.pending ?? 0, cls: 'stat-card--warn' },
    { label: 'Running', val: (s.claimed ?? 0) + (s.running ?? 0), cls: 'stat-card--accent' },
    { label: 'Completed', val: s.completed ?? 0, cls: 'stat-card--success' },
    { label: 'Failed', val: s.failed ?? 0, cls: 'stat-card--error' },
    { label: 'Rate Limited', val: s.rateLimited ?? 0, cls: 'stat-card--warn' },
    { label: 'Cooldown', val: s.cooldown ?? 0, cls: 'stat-card--warn' },
  ];
  $('#stats-row').innerHTML = cards.map((c) => `
    <div class="stat-card ${c.cls}"><div class="stat-card__val">${c.val}</div><div class="stat-card__label">${c.label}</div></div>`).join('');
}

async function loadMembers() {
  const res = await apiRequest(`/groups/${currentGroupId}/members`);
  if (!res.ok) return;
  const members = res.data.members || [];
  $('#member-count').textContent = `(${members.length})`;
  $('#members-tbody').innerHTML = members.map((m) => `
    <tr>
      <td>@${esc(m.username)}</td>
      <td>${m._count.tasks}</td>
      <td><button class="btn btn--danger btn--sm" data-remove="${m.id}">Remove</button></td>
    </tr>`).join('') || '<tr><td colspan="3" class="muted">No members yet. Import some usernames above.</td></tr>';

  $('#members-tbody').querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Remove this member? Pending tasks targeting them will be cancelled.')) return;
      const res = await apiRequest(`/groups/${currentGroupId}/members/${b.dataset.remove}`, { method: 'DELETE' });
      if (res.ok) { showToast('Member removed', 'success'); loadGroupDetail(currentGroupId); } else showToast(res.data?.error, 'error');
    }));
}

async function loadTasks() {
  const status = $('#task-status-filter')?.value || '';
  const q = status ? `?status=${status}&limit=100` : '?limit=100';
  const res = await apiRequest(`/groups/${currentGroupId}/tasks${q}`);
  if (!res.ok) return;
  const tasks = res.data.tasks || [];
  $('#tasks-tbody').innerHTML = tasks.map((t) => `
    <tr>
      <td>${esc(t.action)}</td>
      <td>@${esc(t.account?.username || '?')}</td>
      <td>@${esc(t.member?.username || '?')}</td>
      <td><span class="pill ${STATUS_PILL[t.status] || 'pill--paused'}">${esc(t.status)}</span></td>
      <td>${t.retryCount ?? 0}</td>
      <td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.error || '')}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No tasks.</td></tr>';
}

function joinGroupRoom(id) {
  if (!socket) {
    socket = connectSocket('dashboard', { transports: ['websocket', 'polling'] });
    socket.on('group:taskCreated', () => refreshStats());
    socket.on('group:taskClaimed', (d) => { appendActivity(`▶ ${d.action} @${d.accountUsername} → @${d.memberUsername}`); refreshStats(); });
    socket.on('group:taskCompleted', (d) => { appendActivity(`✓ ${d.action} @${d.accountUsername} → @${d.memberUsername}`); refreshStats(); });
    socket.on('group:taskFailed', (d) => { appendActivity(`✗ ${d.action} → @${d.memberUsername}: ${d.error}`); refreshStats(); });
    socket.on('group:taskRateLimited', (d) => { appendActivity(`⏳ ${d.action} → @${d.memberUsername} rate limited, retry ${d.rescheduleAt}`); refreshStats(); });
  }
  socket.emit('group:join', id);
}

function refreshStats() {
  apiRequest(`/groups/${currentGroupId}/stats`).then((res) => {
    if (res.ok) { stats = res.data.stats; renderStats(); }
  });
}

function appendActivity(line) {
  const log = $('#activity-log');
  if (!log) return;
  const el = document.createElement('div');
  el.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
  log.prepend(el);
  while (log.children.length > 60) log.lastChild.remove();
}

// ── Wiring ─────────────────────────────────────────────────────────────────

$('#btn-new-group').addEventListener('click', () => $('#modal-new-group').classList.add('visible'));
$('#btn-new-group-2').addEventListener('click', () => $('#modal-new-group').classList.add('visible'));
$('#modal-close').addEventListener('click', () => $('#modal-new-group').classList.remove('visible'));
$('#btn-cancel-new').addEventListener('click', () => $('#modal-new-group').classList.remove('visible'));
$('#modal-new-group').addEventListener('click', (e) => {
  if (e.target === $('#modal-new-group')) $('#modal-new-group').classList.remove('visible');
});

$('#btn-create-group').addEventListener('click', async () => {
  const name = $('#new-group-name').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  const res = await apiRequest('/groups', {
    method: 'POST',
    body: JSON.stringify({ name, description: $('#new-group-desc').value.trim() }),
  });
  if (res.ok) {
    showToast('Group created', 'success');
    $('#modal-new-group').classList.remove('visible');
    $('#new-group-name').value = '';
    $('#new-group-desc').value = '';
    loadGroups();
  } else showToast(res.data?.error, 'error');
});

$('#btn-back').addEventListener('click', showList);

$('#btn-import-members').addEventListener('click', async () => {
  const raw = $('#member-input').value;
  if (!raw.trim()) { showToast('Paste some usernames first', 'error'); return; }
  const res = await apiRequest(`/groups/${currentGroupId}/members/import`, {
    method: 'POST',
    body: JSON.stringify({ usernames: raw }),
  });
  if (res.ok) {
    const g = res.data.generated || {};
    showToast(`Added ${res.data.added} members, generated ${g.created} tasks`, 'success');
    $('#member-input').value = '';
    $('#member-import-err').textContent = res.data.invalid?.length ? `Invalid: ${res.data.invalid.join(', ')}` : '';
    loadGroupDetail(currentGroupId);
  } else showToast(res.data?.error, 'error');
});

$('#btn-link-account').addEventListener('click', async () => {
  const id = $('#account-select').value;
  if (!id) { showToast('Select an account first', 'error'); return; }
  const res = await apiRequest(`/groups/${currentGroupId}/accounts`, {
    method: 'POST',
    body: JSON.stringify({ accountIds: [id] }),
  });
  if (res.ok) {
    showToast('Account linked', 'success');
    loadGroupDetail(currentGroupId);
  } else showToast(res.data?.error, 'error');
});

$('#btn-save-actions').addEventListener('click', async () => {
  const actions = {};
  ['like', 'comment', 'repost', 'follow'].forEach((a) => {
    const el = $(`#act-${a}`);
    actions[a] = !!el?.checked;
  });
  const res = await apiRequest(`/groups/${currentGroupId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      actions,
      cooldownSec: parseInt($('#cooldown-sec').value, 10) || 0,
      autoExecute: $('#auto-execute').checked,
    }),
  });
  if (res.ok) showToast('Actions saved', 'success');
  else showToast(res.data?.error, 'error');
});

$('#btn-generate').addEventListener('click', async () => {
  const res = await apiRequest(`/groups/${currentGroupId}/tasks/generate`, { method: 'POST' });
  if (res.ok) {
    showToast(`Generated ${res.data.generated?.created || 0} new tasks`, 'success');
    loadGroupDetail(currentGroupId);
  } else showToast(res.data?.error, 'error');
});

$('#btn-start').addEventListener('click', async () => {
  const res = await apiRequest(`/groups/${currentGroupId}/automation/start`, { method: 'POST' });
  if (res.ok) { showToast('Automation started', 'success'); loadGroupDetail(currentGroupId); }
  else showToast(res.data?.error, 'error');
});

$('#btn-pause').addEventListener('click', async () => {
  const res = await apiRequest(`/groups/${currentGroupId}/automation/pause`, { method: 'POST' });
  if (res.ok) { showToast('Automation paused', 'success'); loadGroupDetail(currentGroupId); }
  else showToast(res.data?.error, 'error');
});

$('#btn-cancel-pending').addEventListener('click', async () => {
  if (!confirm('Cancel all PENDING tasks for this group?')) return;
  const res = await apiRequest(`/groups/${currentGroupId}/tasks/cancel`, { method: 'POST', body: '{}' });
  if (res.ok) { showToast(`Cancelled ${res.data.cancelled} tasks`, 'success'); loadTasks(); refreshStats(); }
  else showToast(res.data?.error, 'error');
});

$('#btn-delete').addEventListener('click', async () => {
  if (!confirm('Delete this group permanently?')) return;
  const res = await apiRequest(`/groups/${currentGroupId}`, { method: 'DELETE' });
  if (res.ok) { showToast('Group deleted', 'success'); showList(); }
  else showToast(res.data?.error, 'error');
});

$('#task-status-filter').addEventListener('change', loadTasks);

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    ['overview', 'actions', 'members', 'accounts', 'tasks', 'xgroups'].forEach((name) => {
      $(`#tab-${name}`).style.display = name === tab.dataset.tab ? 'block' : 'none';
    });
  }));

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ============================================
// X Group DM Member Sync
// ============================================
let xGroup = { conversationId: null, taskId: null, page: 1, pageSize: 50, pollTimer: null };

function renderXGroupAccountSelect() {
  const sel = $('#xgroup-account');
  if (!sel) return;
  sel.innerHTML = accountsCache.length
    ? accountsCache.map((a) => `<option value="${a.id}">@${a.username}</option>`).join('')
    : '<option value="">No eligible accounts — add one under Accounts</option>';
}

function renderXGroupGroupSelect(groups) {
  const sel = $('#xgroup-group');
  if (!sel) return;
  sel.innerHTML = (groups.length
    ? groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`)
    : ['<option value="">No groups yet — create one first</option>']
  ).join('');
}

async function loadXGroupOptions() {
  await loadAccounts();
  renderXGroupAccountSelect();
  const res = await apiRequest('/groups');
  if (res.ok) renderXGroupGroupSelect(res.data.groups || []);
}

function setXGroupResult(html, progress) {
  const box = $('#xgroup-result');
  box.style.display = 'block';
  $('#xgroup-summary').innerHTML = html;
  $('#xgroup-progress').textContent = progress || '';
}

async function xGroupSync() {
  const url = $('#xgroup-url').value.trim();
  const accountId = $('#xgroup-account').value;
  const groupId = $('#xgroup-group').value;
  if (!url) { showToast('Enter an X Group DM URL', 'error'); return; }
  if (!accountId) { showToast('Select an X account', 'error'); return; }
  if (!groupId) { showToast('Select a target group', 'error'); return; }

  // Validate + resolve the conversation ID.
  const parsed = await apiRequest('/x/groups/parse', { method: 'POST', body: { url } });
  if (!parsed.ok) {
    showToast(parsed.data?.error || 'Invalid group URL', 'error');
    return;
  }
  xGroup.conversationId = parsed.data.conversationId;
  setXGroupResult('Parsed conversation — starting sync...', 'Queuing extraction job…');

  const syncRes = await apiRequest(`/x/groups/${xGroup.conversationId}/members/sync`, {
    method: 'POST',
    body: { accountId, groupId },
  });
  if (!syncRes.ok) {
    showToast(syncRes.data?.error || 'Failed to start sync', 'error');
    setXGroupResult('Sync could not start.', syncRes.data?.error || '');
    return;
  }
  xGroup.taskId = syncRes.data.taskId;
  showToast('Sync started', 'success');
  pollXGroupStatus();
}

function pollXGroupStatus() {
  if (!xGroup.conversationId) return;
  clearInterval(xGroup.pollTimer);
  const tick = async () => {
    if (!xGroup.conversationId) return;
    const res = await apiRequest(`/x/groups/${xGroup.conversationId}/sync-status`);
    if (!res.ok) return;
    const s = res.data;
    if (s.status === 'COMPLETED' || s.status === 'FAILED' || s.status === 'CANCELLED' || s.status === 'RATE_LIMITED') {
      clearInterval(xGroup.pollTimer);
      setXGroupResult(
        `Sync <b>${esc(s.status)}</b> — processed ${s.processed || 0} members${s.total ? ` of ${s.total}` : ''}.`,
        s.status === 'FAILED' ? 'Check the task log for details.' : '',
      );
      if (s.status === 'COMPLETED') loadXGroupMembers(1);
      return;
    }
    setXGroupResult('Syncing…', `Processed ${s.processed || 0} members${s.total ? ` of ${s.total}` : ''} (${s.pages || 0} pages)`);
  };
  tick();
  xGroup.pollTimer = setInterval(tick, 2500);
}

async function loadXGroupMembers(page = 1) {
  if (!xGroup.conversationId) return;
  xGroup.page = page;
  const q = encodeURIComponent($('#xgroup-search').value.trim());
  const res = await apiRequest(`/x/groups/${xGroup.conversationId}/members?page=${page}&pageSize=${xGroup.pageSize}&search=${q}`);
  if (!res.ok) { showToast(res.data?.error || 'Failed to load members', 'error'); return; }
  const { members, total } = res.data;
  $('#xgroup-members-card').style.display = 'block';
  $('#xgroup-member-count').textContent = `${total} members`;
  $('#xgroup-page').textContent = `Page ${page}`;
  $('#xgroup-tbody').innerHTML = members.length
    ? members.map((m) => `
      <tr>
        <td>${esc(m.displayName || m.username)}</td>
        <td>@${esc(m.username)}</td>
        <td>${esc(m.xUserId)}</td>
        <td>${m.isCurrentMember ? '<span class="pill pill--running">Active</span>' : '<span class="pill pill--paused">Left</span>'}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No members found.</td></tr>';
  $('#btn-xgroup-prev').disabled = page <= 1;
  $('#btn-xgroup-next').disabled = page * xGroup.pageSize >= total;
}

function exportXGroupMembers(format) {
  if (!xGroup.conversationId) return;
  const q = encodeURIComponent($('#xgroup-search').value.trim());
  apiRequest(`/x/groups/${xGroup.conversationId}/members?pageSize=100&search=${q}`).then((res) => {
    if (!res.ok) return;
    const members = res.data.members || [];
    const rows = members.map((m) => ({
      x_user_id: m.xUserId,
      username: m.username,
      display_name: m.displayName || '',
      profile_url: m.profileUrl || '',
    }));
    const blob = format === 'csv'
      ? new Blob([[`x_user_id,username,display_name,profile_url\n${rows.map((r) => [r.x_user_id, r.username, r.display_name, r.profile_url].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')}`]], { type: 'text/csv' })
      : new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `xgroup-${xGroup.conversationId}.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// X Group DM Sync controls
$('#btn-xgroup-sync').addEventListener('click', xGroupSync);
$('#btn-xgroup-view').addEventListener('click', () => loadXGroupMembers(1));
$('#btn-xgroup-export-csv').addEventListener('click', () => exportXGroupMembers('csv'));
$('#btn-xgroup-export-json').addEventListener('click', () => exportXGroupMembers('json'));
$('#btn-xgroup-prev').addEventListener('click', () => loadXGroupMembers(Math.max(1, xGroup.page - 1)));
$('#btn-xgroup-next').addEventListener('click', () => loadXGroupMembers(xGroup.page + 1));
$('#xgroup-search').addEventListener('input', debounce(() => loadXGroupMembers(1), 400));

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Boot
(async () => {
  const sb = document.getElementById('sidebar');
  if (window.renderSidebar) sb.innerHTML = window.renderSidebar();
  loadGroups();
  loadAccounts();
  loadXGroupOptions();
  try { socket = connectSocket('dashboard', { transports: ['websocket', 'polling'] }); } catch { /* offline */ }
})();
