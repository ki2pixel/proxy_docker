// =============================================================================
// ISP Gateway × Monetization Hub | Modern Dashboard Controller
// =============================================================================

const FLAGS = {
  FR: '🇫🇷',
  DE: '🇩🇪',
  US: '🇺🇸',
  SE: '🇸🇪',
  FI: '🇫🇮',
  GB: '🇬🇧',
  CA: '🇨🇦'
};

const state = {
  status: null,
  activeLogTarget: 'system',
  eventSource: null,
  authenticated: false
};

// DOM Elements
const heroIpEl = document.getElementById('hero-ip');
const heroFlagEl = document.getElementById('hero-flag');
const heroCountryEl = document.getElementById('hero-country');
const heroCityEl = document.getElementById('hero-city');
const heroIspEl = document.getElementById('hero-isp');
const heroProxyTargetEl = document.getElementById('hero-proxy-target');
const latencyValueEl = document.getElementById('latency-value');

const statGatewayStatusEl = document.getElementById('stat-gateway-status');
const statLatencyEl = document.getElementById('stat-latency');
const statActiveNodesEl = document.getElementById('stat-active-nodes');
const statProtocolEl = document.getElementById('stat-protocol');

const nodesGridEl = document.getElementById('nodes-grid');
const terminalBodyEl = document.getElementById('terminal-body');
const terminalTitleEl = document.getElementById('terminal-target-title');

// Toast Notification
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// -----------------------------------------------------------------------------
// 0. Authentification
// -----------------------------------------------------------------------------
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function showLogin() {
  state.authenticated = false;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  document.getElementById('login-overlay').classList.remove('hidden');
}

function hideLogin() {
  document.getElementById('login-overlay').classList.add('hidden');
}

async function doLogin(token) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Token invalide');
  }
  state.authenticated = true;
}

async function doLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch { /* cookie supprimé côté client de toute façon */ }
  document.cookie = 'session=; Max-Age=0; path=/';
  document.cookie = 'csrf=; Max-Age=0; path=/';
  state.authenticated = false;
  showLogin();
  showToast('Déconnecté', 'info');
}

// Fetch wrapper : ajoute le header CSRF sur les mutations, gère les 401
async function apiFetch(url, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(opts.headers || {}) };
  const method = (opts.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = getCookie('csrf');
    if (csrf) opts.headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    showLogin();
    throw new Error('Session expirée');
  }
  return res;
}

// Login form
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('login-token');
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');
  errorEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Connexion...';
  try {
    await doLogin(input.value.trim());
    input.value = '';
    hideLogin();
    showToast('Connecté au dashboard', 'success');
    await initAuthenticated();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Se connecter';
  }
});

// Logout button
const logoutBtn = document.getElementById('btn-logout');
if (logoutBtn) {
  logoutBtn.addEventListener('click', doLogout);
}

// -----------------------------------------------------------------------------
// 1. Fetch & Render Status
// -----------------------------------------------------------------------------
async function fetchStatus() {
  if (!state.authenticated) return;
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    state.status = data;
    renderStatus(data);
  } catch (err) {
    console.error('Error fetching status:', err);
  }
}

function renderStatus(data) {
  // Hero IP Card
  if (data.ip) {
    heroIpEl.innerText = data.ip;
  }
  if (data.location) {
    const code = data.location.country || 'FR';
    heroFlagEl.innerText = FLAGS[code] || '🌐';
    heroCountryEl.innerText = data.location.country || 'France';
    heroCityEl.innerText = data.location.city || 'Paris';
  }
  if (data.isp) {
    heroIspEl.innerText = data.isp.org || 'Limestone Networks';
  }
  if (data.activeProxy) {
    heroProxyTargetEl.innerText = `Proxy : ${data.activeProxy.protocol}://${data.activeProxy.host}:${data.activeProxy.port}`;
    if (statProtocolEl) {
      statProtocolEl.innerText = `${(data.activeProxy.protocol || 'SOCKS5').toUpperCase()} :${data.activeProxy.port || '1080'}`;
    }
  }
  if (data.latencyMs) {
    const latText = `${data.latencyMs} ms`;
    latencyValueEl.innerText = latText;
    latencyValueEl.style.color = data.latencyMs < 350 ? '#34d399' : (data.latencyMs < 600 ? '#fbbf24' : '#fb7185');
    if (statLatencyEl) {
      statLatencyEl.innerText = latText;
    }
  }

  // Gateway status
  if (statGatewayStatusEl) {
    const isHealthy = data.gatewayStatus === 'HEALTHY';
    statGatewayStatusEl.innerText = isHealthy ? 'Active' : (data.gatewayStatus || 'En attente');
    statGatewayStatusEl.className = isHealthy ? 'stat-number text-emerald' : 'stat-number text-amber';
  }

  // Monetization nodes
  if (data.providers) {
    const running = data.providers.filter(p => p.running).length;
    if (statActiveNodesEl) {
      statActiveNodesEl.innerText = `${running} / ${data.providers.length}`;
    }
    renderNodes(data.providers);
  }
}

// -----------------------------------------------------------------------------
// 2. Render Monetization Nodes
// -----------------------------------------------------------------------------
function renderNodes(providers) {
  nodesGridEl.innerHTML = '';
  providers.forEach(p => {
    const card = document.createElement('div');
    card.className = 'node-card glass-card';

    const isRunning = p.running;
    const statusClass = isRunning ? 'running' : 'stopped';
    const statusLabel = isRunning ? 'Actif & Routé' : 'Arrêté';

    card.innerHTML = `
      <div class="node-head">
        <div class="node-title-box">
          <span class="node-icon">${p.icon}</span>
          <span class="node-name">${p.name}</span>
        </div>
        <span class="node-status-badge ${statusClass}">${statusLabel}</span>
      </div>
      <div class="node-info">
        <div>Conteneur : <code>${p.container}</code></div>
        <div>Réseau : <code>service:gateway-isp</code></div>
      </div>
      <div class="node-actions">
        ${isRunning ? `
          <button class="btn btn-secondary btn-sm" onclick="nodeAction('${p.id}', 'restart')">Redémarrer</button>
          <button class="btn btn-secondary btn-sm" onclick="nodeAction('${p.id}', 'stop')">Arrêter</button>
        ` : `
          <button class="btn btn-primary btn-sm" onclick="nodeAction('${p.id}', 'start')">Démarrer</button>
        `}
        <a href="${p.dashboard}" target="_blank" class="btn btn-secondary btn-sm" title="Ouvrir le tableau de bord">Dashboard ↗</a>
      </div>
    `;
    nodesGridEl.appendChild(card);
  });
}

window.nodeAction = async function(id, action) {
  showToast(`Action ${action} en cours sur ${id}...`, 'info');
  try {
    const res = await apiFetch(`/api/providers/${id}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      setTimeout(fetchStatus, 1500);
    } else {
      showToast(data.error || 'Erreur lors de l\'action', 'error');
    }
  } catch (err) {
    if (err.message !== 'Session expirée') showToast(err.message, 'error');
  }
};

// -----------------------------------------------------------------------------
// 3. Quick Actions & Helpers
// -----------------------------------------------------------------------------
const quickRefreshBtn = document.getElementById('btn-quick-refresh');
if (quickRefreshBtn) {
  quickRefreshBtn.addEventListener('click', async () => {
    showToast('Rafraîchissement des métriques et de la passerelle...', 'info');
    await fetchStatus();
    showToast('Métriques mises à jour avec succès !', 'success');
  });
}

// Rotate IP button
const rotateIpBtn = document.getElementById('btn-rotate-ip');
if (rotateIpBtn) {
  rotateIpBtn.addEventListener('click', async () => {
    showToast('Rotation de l\'adresse IP en cours...', 'info');
    try {
      const res = await apiFetch('/api/proxy/rotate', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || `Nouvelle IP : ${data.ip}`, 'success');
        setTimeout(fetchStatus, 1500);
      } else {
        showToast(data.error || 'Erreur lors de la rotation', 'error');
      }
    } catch (err) {
      if (err.message !== 'Session expirée') showToast(err.message, 'error');
    }
  });
}

// Copy IP button
document.getElementById('btn-copy-ip').addEventListener('click', () => {
  const ip = heroIpEl.innerText;
  if (ip && !ip.includes('...')) {
    navigator.clipboard.writeText(ip);
    showToast(`Adresse IP ${ip} copiée dans le presse-papier !`);
  }
});

// Refresh header button
document.getElementById('btn-refresh-status').addEventListener('click', () => {
  fetchStatus();
  showToast('Métriques rafraîchies', 'info');
});

// Restart all nodes button
document.getElementById('btn-restart-all-nodes').addEventListener('click', async () => {
  showToast('Redémarrage des conteneurs de monétisation...', 'info');
  if (state.status?.providers) {
    for (const p of state.status.providers) {
      if (p.running) {
        await window.nodeAction(p.id, 'restart');
      }
    }
  }
});

// -----------------------------------------------------------------------------
// 3b. Configuration (.env) — édition depuis le dashboard
// -----------------------------------------------------------------------------
const CATEGORY_LABELS = {
  gateway: 'Passerelle ISP',
  dashboard: 'Dashboard',
  providers: 'Fournisseurs'
};

async function fetchConfig() {
  if (!state.authenticated) return;
  try {
    const res = await apiFetch('/api/config');
    if (!res.ok) return;
    const data = await res.json();
    renderConfig(data.config, data.proxyScheme);
  } catch (err) {
    console.error('Error fetching config:', err);
  }
}

function renderConfig(config, proxyScheme) {
  const badge = document.getElementById('config-scheme-badge');
  if (badge) {
    badge.textContent = proxyScheme === 'session'
      ? 'Schéma : session résidentielle (rotation auto)'
      : 'Schéma : classique (HOST:PORT:USER:PASS)';
  }

  const container = document.getElementById('config-fields');
  container.innerHTML = '';

  const groups = {};
  for (const item of config) {
    (groups[item.category] = groups[item.category] || []).push(item);
  }

  for (const [category, items] of Object.entries(groups)) {
    const group = document.createElement('div');
    group.className = 'config-group';

    const title = document.createElement('div');
    title.className = 'config-group-title';
    title.textContent = CATEGORY_LABELS[category] || category;
    group.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'config-grid';

    for (const item of items) {
      const field = document.createElement('div');
      field.className = 'config-field';

      const label = document.createElement('label');
      label.setAttribute('for', `cfg-${item.key}`);
      label.textContent = item.label;
      if (item.sensitive) {
        const dot = document.createElement('span');
        dot.className = 'config-secret-dot';
        dot.textContent = ' 🔒';
        label.appendChild(dot);
      }
      field.appendChild(label);

      let input;
      if (item.options) {
        input = document.createElement('select');
        input.id = `cfg-${item.key}`;
        input.dataset.key = item.key;
        for (const opt of item.options) {
          const option = document.createElement('option');
          option.value = opt;
          option.textContent = opt;
          if (item.value === opt) option.selected = true;
          input.appendChild(option);
        }
      } else {
        input = document.createElement('input');
        input.id = `cfg-${item.key}`;
        input.dataset.key = item.key;
        input.type = item.sensitive ? 'password' : 'text';
        input.autocomplete = 'off';
        if (item.sensitive) {
          input.placeholder = item.hasValue ? '•••••• (vide = inchangé)' : 'Non défini';
        } else {
          input.value = item.value || '';
          input.placeholder = 'Non défini';
        }
      }
      field.appendChild(input);
      grid.appendChild(field);
    }

    group.appendChild(grid);
    container.appendChild(group);
  }
}

function collectConfigUpdates() {
  const updates = {};
  document.querySelectorAll('#config-fields [data-key]').forEach(el => {
    const value = el.value.trim();
    // Champ sensible vide = inchangé (null)
    if (value === '' && el.type === 'password') {
      updates[el.dataset.key] = null;
    } else if (value !== '') {
      updates[el.dataset.key] = value;
    }
  });
  return updates;
}

async function saveConfig(apply) {
  const updates = collectConfigUpdates();
  if (Object.values(updates).every(v => v === null)) {
    showToast('Aucune modification à enregistrer', 'info');
    return;
  }
  try {
    const res = await apiFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates, apply })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.applied ? 'Configuration enregistrée et appliquée' : 'Configuration enregistrée', 'success');
      await fetchConfig();
      if (data.applied) setTimeout(fetchStatus, 2000);
    } else {
      showToast(data.error || 'Erreur lors de l\'enregistrement', 'error');
    }
  } catch (err) {
    if (err.message !== 'Session expirée') showToast(err.message, 'error');
  }
}

const configForm = document.getElementById('config-form');
if (configForm) {
  configForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveConfig(false);
  });
}

const btnConfigApply = document.getElementById('btn-config-apply');
if (btnConfigApply) {
  btnConfigApply.addEventListener('click', () => {
    if (confirm('Appliquer la configuration ? Les conteneurs concernés seront redémarrés (brève coupure).')) {
      saveConfig(true);
    }
  });
}

// -----------------------------------------------------------------------------
// 4. Real-time Logs Terminal & SSE
// -----------------------------------------------------------------------------
function setupLogsSSE() {
  if (state.eventSource) state.eventSource.close();

  state.eventSource = new EventSource('/api/logs/stream');
  state.eventSource.onmessage = (e) => {
    if (state.activeLogTarget === 'system') {
      try {
        const entry = JSON.parse(e.data);
        appendLogLine(`[${entry.level}] ${entry.message}`);
      } catch {
        appendLogLine(e.data);
      }
    }
  };
  // Si le serveur rejette le flux (401), retour à l'écran de connexion
  state.eventSource.onerror = () => {
    if (state.eventSource && state.eventSource.readyState === EventSource.CLOSED && state.authenticated) {
      showLogin();
    }
  };
}

function appendLogLine(line) {
  const lineEl = document.createElement('div');
  lineEl.className = 'log-line';
  lineEl.innerText = line;
  terminalBodyEl.appendChild(lineEl);
  terminalBodyEl.scrollTop = terminalBodyEl.scrollHeight;
}

async function fetchContainerLogs(name) {
  terminalBodyEl.innerHTML = `<div class="log-line">[LOGS] Récupération des logs du conteneur ${name}...</div>`;
  try {
    const res = await apiFetch(`/api/logs/container/${name}?tail=80`);
    const data = await res.json();
    terminalBodyEl.innerHTML = '';
    const lines = (data.logs || '').split('\n');
    lines.forEach(l => {
      if (l.trim()) appendLogLine(l);
    });
  } catch (err) {
    appendLogLine(`[ERROR] Impossible de récupérer les logs: ${err.message}`);
  }
}

// Log tabs
document.getElementById('log-tabs').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    const target = e.target.dataset.target;
    state.activeLogTarget = target;
    terminalTitleEl.innerText = `Flux : ${e.target.innerText}`;

    if (target === 'system') {
      terminalBodyEl.innerHTML = '<div class="log-line">[SYSTEM] Écoute du flux des logs système...</div>';
    } else {
      fetchContainerLogs(target);
    }
  }
});

document.getElementById('btn-clear-logs').addEventListener('click', () => {
  terminalBodyEl.innerHTML = '';
});

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------
async function initAuthenticated() {
  state.authenticated = true;
  await fetchStatus();
  fetchConfig();
  setupLogsSSE();
}

async function init() {
  // Démarrage : vérifie si une session existe déjà (cookie valide)
  try {
    const res = await apiFetch('/api/status');
    if (res.ok) {
      await initAuthenticated();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }

  // Periodic polling every 10 seconds
  setInterval(fetchStatus, 10000);
}

init();
