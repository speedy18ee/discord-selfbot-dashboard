// EXC Admin Credential & HWID Management Client

let adminToken = localStorage.getItem('exc_admin_token') || null;

window.addEventListener('DOMContentLoaded', () => {
  if (adminToken) {
    checkAdminAuth();
  } else {
    showAdminLogin();
  }
});

function showAdminLogin() {
  document.getElementById('admin-auth-overlay').style.display = 'flex';
  document.getElementById('admin-main-panel').style.display = 'none';
}

function hideAdminLogin() {
  document.getElementById('admin-auth-overlay').style.display = 'none';
  document.getElementById('admin-main-panel').style.display = 'block';
}

async function checkAdminAuth() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (res.ok) {
      hideAdminLogin();
      loadUsersTable();
    } else {
      localStorage.removeItem('exc_admin_token');
      adminToken = null;
      showAdminLogin();
    }
  } catch (e) {
    showAdminLogin();
  }
}

async function handleAdminLogin(e) {
  e.preventDefault();
  const key = document.getElementById('input-admin-key').value.trim();
  const errEl = document.getElementById('admin-login-error');
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey: key })
    });
    const data = await res.json();
    if (data.success && data.token) {
      adminToken = data.token;
      localStorage.setItem('exc_admin_token', adminToken);
      hideAdminLogin();
      loadUsersTable();
    } else {
      errEl.textContent = data.error || 'Authentication failed';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = 'Server connection error';
    errEl.style.display = 'block';
  }
}

function adminLogout() {
  if (adminToken) {
    fetch('/api/admin/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    }).catch(() => {});
  }
  localStorage.removeItem('exc_admin_token');
  adminToken = null;
  showAdminLogin();
}

async function loadUsersTable() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (!data.success) {
      if (res.status === 401) return showAdminLogin();
      return showToast(data.error || 'Failed to load credentials', 'error');
    }

    const currentUsers = data.users || [];
    renderUsers(currentUsers);

    // Auto-Recovery Check: Compare with browser offline backup
    try {
      const rawBackup = localStorage.getItem('exc_admin_users_backup');
      if (rawBackup) {
        const backupUsers = JSON.parse(rawBackup);
        if (Array.isArray(backupUsers) && backupUsers.length > 0) {
          const missingUsers = backupUsers.filter(bu => 
            !currentUsers.some(cu => cu.username.toLowerCase() === bu.username.toLowerCase())
          );
          if (missingUsers.length > 0) {
            console.log(`[EXC AUTO-RECOVERY] Detected ${missingUsers.length} missing user(s) from local backup. Restoring...`);
            const restoreRes = await fetch('/api/admin/restore', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${adminToken}`
              },
              body: JSON.stringify({ users: missingUsers })
            });
            const restoreData = await restoreRes.json();
            if (restoreData.success && restoreData.restoredUsers > 0) {
              showToast(`🛡️ Auto-restored ${restoreData.restoredUsers} user credential(s) from browser safety backup!`, 'success');
              return loadUsersTable();
            }
          }
        }
      }
      // Update local storage backup with latest server data
      localStorage.setItem('exc_admin_users_backup', JSON.stringify(currentUsers));
    } catch (e) {
      console.warn('Backup check error:', e);
    }
  } catch (err) {
    showToast('Failed to load users', 'error');
  }
}

function renderUsers(users) {
  const tbody = document.getElementById('users-table-body');
  tbody.innerHTML = '';

  const total = users.length;
  const bound = users.filter(u => u.isBound).length;
  const unbound = total - bound;

  document.getElementById('stat-total-users').textContent = total;
  document.getElementById('stat-bound-users').textContent = bound;
  document.getElementById('stat-unbound-users').textContent = unbound;

  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">No credentials created yet. Click "Auto-Generate Credential" to create one.</td></tr>`;
    return;
  }

  users.forEach(u => {
    const tr = document.createElement('tr');
    const deviceStr = u.boundDevice ? `${u.boundDevice.platform} • ${u.boundDevice.browser}` : 'Not yet logged in';
    const hwidBadge = u.isBound 
      ? `<span class="hwid-badge hwid-bound" title="${u.hwid}"><i class="fa-solid fa-lock"></i> Locked (${u.hwid.substring(0, 15)}...)</span>`
      : `<span class="hwid-badge hwid-unbound"><i class="fa-solid fa-circle-check"></i> Unbound (Ready)</span>`;
    const limit = u.botLimit || 10;

    tr.innerHTML = `
      <td>
        <div style="font-weight: 700; color: #fff;">${escapeHTML(u.username)}</div>
        ${u.note ? `<div style="font-size:0.76rem; color:var(--text-muted);">${escapeHTML(u.note)}</div>` : ''}
      </td>
      <td>
        <span class="font-mono" style="background:rgba(255,255,255,0.06); padding:3px 8px; border-radius:6px;" id="pwd-${u.id}">••••••••</span>
        <button class="btn-icon-action" onclick="togglePasswordView('${u.id}', '${escapeHTML(u.password)}')" title="Show / Hide">
          <i class="fa-solid fa-eye" id="eye-${u.id}"></i>
        </button>
        <button class="btn-icon-action" onclick="copyText('${escapeHTML(u.password)}')" title="Copy password">
          <i class="fa-solid fa-copy"></i>
        </button>
      </td>
      <td>
        <span class="hwid-badge" style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.35);">
          <i class="fa-solid fa-robot"></i> ${limit} Bots Limit
        </span>
        <button class="btn-icon-action" style="margin-left: 4px; padding: 3px 6px;" onclick="editUserLimit('${u.id}', '${escapeHTML(u.username)}', ${limit})" title="Edit bot limit">
          <i class="fa-solid fa-pen"></i>
        </button>
      </td>
      <td>${hwidBadge}</td>
      <td style="font-size:0.82rem; color:var(--text-muted);">${escapeHTML(deviceStr)}</td>
      <td>
        <span class="badge ${u.status === 'active' ? 'badge-success' : 'badge-danger'}">
          ${u.status.toUpperCase()}
        </span>
      </td>
      <td>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button class="btn-icon-action" style="background: rgba(168, 85, 247, 0.18); border-color: rgba(168, 85, 247, 0.45); color: #c084fc; font-weight: 600;" onclick="editUserLimit('${u.id}', '${escapeHTML(u.username)}', ${limit})" title="Change bots limit for ${escapeHTML(u.username)}">
            <i class="fa-solid fa-robot"></i> Limit (${limit})
          </button>
          ${u.isBound ? `
            <button class="btn-icon-action btn-reset-hwid" onclick="resetUserHwid('${u.id}', '${escapeHTML(u.username)}')" title="Unlock account from current device so user can bind new phone/PC">
              <i class="fa-solid fa-arrows-rotate"></i> Reset HWID
            </button>
          ` : ''}
          <button class="btn-icon-action" onclick="toggleUserStatus('${u.id}')" title="Suspend / Activate">
            <i class="fa-solid ${u.status === 'active' ? 'fa-pause' : 'fa-play'}"></i>
          </button>
          <button class="btn-icon-action" onclick="copyFullUserCredentials('${escapeHTML(u.username)}', '${escapeHTML(u.password)}', ${limit})" title="Copy message for buyer">
            <i class="fa-solid fa-share-nodes"></i> Share
          </button>
          <button class="btn-icon-action btn-delete-user" onclick="deleteUser('${u.id}', '${escapeHTML(u.username)}')" title="Delete Credential">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function togglePasswordView(id, rawPassword) {
  const el = document.getElementById(`pwd-${id}`);
  const eye = document.getElementById(`eye-${id}`);
  if (el.textContent === '••••••••') {
    el.textContent = rawPassword;
    eye.className = 'fa-solid fa-eye-slash';
  } else {
    el.textContent = '••••••••';
    eye.className = 'fa-solid fa-eye';
  }
}

function generateRandomCreds() {
  const randNum = Math.floor(1000 + Math.random() * 9000);
  const randPass = Math.random().toString(36).substring(2, 8) + Math.floor(10 + Math.random() * 90);
  document.getElementById('create-username').value = `exc_user_${randNum}`;
  document.getElementById('create-password').value = randPass;
}

async function handleCreateUser(e) {
  e.preventDefault();
  const username = document.getElementById('create-username').value.trim();
  const password = document.getElementById('create-password').value.trim();
  const botLimit = parseInt(document.getElementById('create-bot-limit').value, 10) || 10;
  const note = document.getElementById('create-note').value.trim();

  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ username, password, note, botLimit })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`User "${username}" created (Limit: ${botLimit} Bots, 1-Device HWID Lock)!`, 'success');
      document.getElementById('create-username').value = '';
      document.getElementById('create-password').value = '';
      document.getElementById('create-bot-limit').value = '10';
      document.getElementById('create-note').value = '';

      // Show formatted share box
      const host = window.location.origin;
      const shareText = `╔═══════════════════════════════╗\n  🎵 EXC DASHBOARD LOGIN CREDENTIALS 🎵\n╚═══════════════════════════════╝\n🔗 Dashboard URL: ${host}\n👤 Username: ${username}\n🔑 Password: ${password}\n🤖 Bot Limit: ${botLimit} Bots Allowed\n\n⚠️ IMPORTANT: This account is HWID Locked to 1 Device only. The first phone or PC you log in with will become your permanently authorized device.`;
      
      document.getElementById('quick-copy-content').textContent = shareText;
      document.getElementById('quick-copy-box').style.display = 'block';

      loadUsersTable();
    } else {
      showToast(data.error || 'Failed to create user', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function copyCreatedText() {
  const text = document.getElementById('quick-copy-content').textContent;
  copyText(text);
  showToast('Copied full login instructions to clipboard!', 'success');
}

function copyFullUserCredentials(username, password, limit = 10) {
  const host = window.location.origin;
  const shareText = `🎵 EXC DASHBOARD ACCESS 🎵\n🔗 URL: ${host}\n👤 Username: ${username}\n🔑 Password: ${password}\n🤖 Bot Limit: ${limit} Bots\n⚠️ Locked to 1 device upon first login!`;
  copyText(shareText);
  showToast('Copied credentials to clipboard!', 'success');
}

async function editUserLimit(userId, username, currentLimit) {
  const newLimitStr = prompt(`Set new bot account limit for "${username}":`, currentLimit || 10);
  if (!newLimitStr) return;
  const newLimit = parseInt(newLimitStr, 10);
  if (isNaN(newLimit) || newLimit < 1) {
    return alert('Please enter a valid positive number for bot limit!');
  }

  try {
    const res = await fetch(`/api/admin/users/${userId}/limit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ limit: newLimit })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Updated bot limit for "${username}" to ${newLimit} bots!`, 'success');
      loadUsersTable();
    } else {
      showToast(data.error || 'Failed to update limit', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function resetUserHwid(userId, username) {
  if (!confirm(`Are you sure you want to reset the HWID lock for "${username}"? They will be able to bind a new device on their next login.`)) return;

  try {
    const res = await fetch(`/api/admin/users/${userId}/reset-hwid`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast(`HWID for "${username}" reset! User can now bind a new device.`, 'success');
      loadUsersTable();
    } else {
      showToast(data.error || 'Failed to reset HWID', 'error');
    }
  } catch (e) {
    showToast('Network error', 'error');
  }
}

async function toggleUserStatus(userId) {
  try {
    const res = await fetch(`/api/admin/users/${userId}/toggle`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast(`User status updated to: ${data.user.status.toUpperCase()}`, 'info');
      loadUsersTable();
    }
  } catch (e) {}
}

async function deleteUser(userId, username) {
  if (!confirm(`Are you sure you want to permanently delete user "${username}"?`)) return;

  try {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast(`User "${username}" deleted`, 'info');
      loadUsersTable();
    }
  } catch (e) {}
}

function copyText(text) {
  navigator.clipboard.writeText(text);
  showToast('Copied to clipboard!', 'info');
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${escapeHTML(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// --- CLOUD PERSISTENCE & DATA PROTECTION ---

async function syncToCloudNow() {
  const btn = document.getElementById('btn-cloud-sync');
  const txt = document.getElementById('cloud-sync-text');
  if (btn) btn.disabled = true;
  if (txt) txt.textContent = 'Syncing...';

  try {
    const res = await fetch('/api/admin/sync-cloud', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast(`☁️ Cloud Persistence Synced: Saved ${data.usersCount || 'all'} user(s) permanently to Render!`, 'success');
      if (txt) txt.textContent = 'Synced!';
      setTimeout(() => { if (txt) txt.textContent = 'Cloud Sync'; }, 3000);
    } else {
      showToast(data.error || data.reason || 'Sync failed', 'error');
      if (txt) txt.textContent = 'Cloud Sync';
    }
  } catch (err) {
    showToast('Failed to connect to sync endpoint', 'error');
    if (txt) txt.textContent = 'Cloud Sync';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function downloadBackup() {
  try {
    const res = await fetch('/api/admin/backup', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (!data.success) {
      return showToast('Failed to fetch backup data', 'error');
    }

    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `exc_credentials_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('📥 Backup file downloaded successfully!', 'success');
  } catch (e) {
    showToast('Error exporting backup file', 'error');
  }
}

async function handleRestoreFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const parsed = JSON.parse(event.target.result);
      const users = parsed.users || (Array.isArray(parsed) ? parsed : null);
      const accounts = parsed.accounts || null;

      if (!users && !accounts) {
        return showToast('Invalid backup file format', 'error');
      }

      const res = await fetch('/api/admin/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({ users, accounts })
      });

      const data = await res.json();
      if (data.success) {
        showToast(`✅ Restored ${data.restoredUsers} user(s) and ${data.restoredAccounts} bot account(s)!`, 'success');
        loadUsersTable();
      } else {
        showToast(data.error || 'Restore failed', 'error');
      }
    } catch (err) {
      showToast(`Failed to parse backup JSON: ${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
}

// Keep Render alive while admin page is open
setInterval(() => {
  fetch('/api/ping').catch(() => {});
}, 45 * 1000);
