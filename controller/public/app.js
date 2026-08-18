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
  eventSource: null
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
// 1. Fetch & Render Status
// -----------------------------------------------------------------------------
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
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
    const res = await fetch(`/api/providers/${id}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      setTimeout(fetchStatus, 1500);
    } else {
      showToast(data.error || 'Erreur lors de l\'action', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
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
    const res = await fetch(`/api/logs/container/${name}?tail=80`);
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
async function init() {
  await fetchStatus();
  setupLogsSSE();

  // Periodic polling every 10 seconds
  setInterval(fetchStatus, 10000);
}

init();
