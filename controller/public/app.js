// =============================================================================
// ISP Gateway × Monetization Hub | Modern Dashboard Controller
// =============================================================================

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const code = countryCode.toUpperCase();
  const codePoints = code.split('').map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

const state = {
  status: null,
  activeLogTarget: 'system',
  eventSource: null,
  logPollTimer: null,
  authenticated: false
};

// DOM Elements
const heroIpEl = document.getElementById('hero-ip');
const heroProxyTargetEl = document.getElementById('hero-proxy-target');
const latencyValueEl = document.getElementById('latency-value');

const gatewayBadgeEl = document.getElementById('gateway-badge');
const gatewayBadgeTextEl = gatewayBadgeEl ? gatewayBadgeEl.querySelector('span:last-child') : null;
const dnsBadgeTextEl = document.getElementById('dns-badge')?.querySelector('span:last-child');

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
  if (state.logPollTimer) {
    clearInterval(state.logPollTimer);
    state.logPollTimer = null;
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
// AdaptivePoller — polling robuste pour tunnel à latence variable
// -----------------------------------------------------------------------------
// Remplace setInterval (qui peut empiler les requêtes si une réponse dépasse
// l'intervalle) par une boucle setTimeout chaînée : la requête suivante n'est
// planifiée qu'après la fin de la précédente. Backoff adaptatif selon la
// durée de réponse, pause quand l'onglet est caché (Page Visibility API).
class AdaptivePoller {
  constructor(fetchFn, options = {}) {
    this.fetchFn = fetchFn;
    this.baseIntervalMs = options.baseIntervalMs || 10000;
    this.maxIntervalMs = options.maxIntervalMs || 60000;
    this.currentIntervalMs = this.baseIntervalMs;
    this.inFlight = false;
    this.timerId = null;
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  start() {
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.scheduleNext(0);
  }

  stop() {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.clearTimer();
    this.inFlight = false;
  }

  clearTimer() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  scheduleNext(delayMs) {
    this.clearTimer();
    if (document.hidden) return;
    this.timerId = setTimeout(() => this.executePoll(), delayMs);
  }

  async executePoll() {
    if (this.inFlight || document.hidden) return;
    this.inFlight = true;
    const startTime = performance.now();
    try {
      await this.fetchFn();
      const durationMs = performance.now() - startTime;
      // Si la réponse a pris plus de 2 s, on espace l'intervalle (×1.5) ;
      // sinon retour à l'intervalle nominal.
      this.currentIntervalMs = durationMs > 2000
        ? Math.min(this.currentIntervalMs * 1.5, this.maxIntervalMs)
        : this.baseIntervalMs;
    } catch {
      // Backoff exponentiel en cas d'erreur réseau/serveur
      this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxIntervalMs);
    } finally {
      this.inFlight = false;
      if (!document.hidden) this.scheduleNext(this.currentIntervalMs);
    }
  }

  handleVisibilityChange() {
    if (document.hidden) {
      this.clearTimer();
    } else {
      // Re-synchronisation immédiate au retour dans l'onglet
      this.currentIntervalMs = this.baseIntervalMs;
      this.executePoll();
    }
  }
}

// -----------------------------------------------------------------------------
// 1. Fetch & Render Status (multi-passerelles)
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
    throw err;
  }
}

// Cache DOM des cartes passerelles : construit une fois, patché ensuite
let renderedGwSignature = '';

function renderStatus(data) {
  const gateways = data.gateways || [];
  const summary = data.summary || {};
  const meta = data.meta || {};

  // Témoin de fraîcheur : si les données sont vieilles de plus de 30 s
  // (ipinfo.io inaccessible, refresh en échec), on le signale dans le badge.
  if (latencyValueEl) {
    if (meta.isStale || meta.dataAgeMs > 30000) {
      latencyValueEl.innerText = '-- ms (obsolète)';
      latencyValueEl.style.color = 'var(--accent-amber)';
    } else {
      latencyValueEl.style.color = '';
    }
  }

  // --- IP principale : première passerelle avec IP ---
  const firstWithIp = gateways.find(g => g.ip);
  heroIpEl.innerText = firstWithIp ? firstWithIp.ip : (gateways.length ? 'Détection...' : 'Indisponible');
  heroProxyTargetEl.innerText = gateways.length
    ? `Proxies : ${gateways.length} configuré(s)`
    : 'Proxies : --';

  // --- Badges d'en-tête (agrégés) ---
  if (gatewayBadgeEl && gatewayBadgeTextEl) {
    const healthy = gateways.filter(g => g.status === 'HEALTHY').length;
    const total = gateways.length;
    const allHealthy = total > 0 && healthy === total;
    gatewayBadgeEl.classList.toggle('status-healthy', allHealthy);
    gatewayBadgeEl.classList.toggle('status-warning', !allHealthy);
    gatewayBadgeTextEl.innerText = total === 0
      ? 'Passerelle ISP : Aucune'
      : `Passerelles ISP : ${healthy}/${total} active(s)`;
  }
  if (dnsBadgeTextEl) {
    const anyHealthy = gateways.some(g => g.status === 'HEALTHY');
    dnsBadgeTextEl.innerText = anyHealthy ? 'DoH DNS : Cloudflare' : 'DoH DNS : Inactif';
  }
  if (latencyValueEl) {
    const latencies = gateways.filter(g => typeof g.latencyMs === 'number').map(g => g.latencyMs);
    latencyValueEl.innerText = latencies.length ? `${Math.min(...latencies)} ms (min)` : '-- ms';
  }

  // --- Stats globales ---
  if (statGatewayStatusEl) {
    const healthy = gateways.filter(g => g.status === 'HEALTHY').length;
    statGatewayStatusEl.innerText = `${healthy}/${gateways.length}`;
    statGatewayStatusEl.className = healthy > 0 ? 'stat-number text-emerald' : 'stat-number text-amber';
  }
  if (statLatencyEl) {
    const latencies = gateways.filter(g => typeof g.latencyMs === 'number').map(g => g.latencyMs);
    statLatencyEl.innerText = latencies.length ? `${Math.min(...latencies)} ms` : '-- ms';
  }
  if (statActiveNodesEl) {
    statActiveNodesEl.innerText = `${summary.nodesRunning ?? 0} / ${summary.nodesTotal ?? 0}`;
  }
  if (statProtocolEl) {
    const proto = gateways.find(g => g.activeProxy?.protocol)?.activeProxy?.protocol || 'SOCKS5';
    statProtocolEl.innerText = proto.toUpperCase();
  }

  // --- Grille de cartes passerelles (construction unique + patch) ---
  const signature = gateways.map(g => `${g.id}:${g.providers.map(p => p.container).join(',')}`).join('|');
  if (signature !== renderedGwSignature) {
    renderGateways(gateways);
    renderedGwSignature = signature;
  } else {
    patchGateways(gateways);
  }
}

// Mise à jour ciblée des valeurs des cartes existantes (sans reconstruction DOM)
function patchGateways(gateways) {
  gateways.forEach(gw => {
    const card = nodesGridEl.querySelector(`[data-gw-id="${gw.id}"]`);
    if (!card) return;

    const isHealthy = gw.status === 'HEALTHY';

    // Badge statut
    const badge = card.querySelector('.node-status-badge');
    if (badge) {
      badge.className = `node-status-badge ${isHealthy ? 'running' : 'stopped'}`;
      badge.textContent = isHealthy ? 'Active' : (gw.status === 'UNKNOWN' ? 'En attente' : 'Hors ligne');
    }

    // IP
    const ipEl = card.querySelector('.gw-ip');
    if (ipEl) {
      ipEl.textContent = gw.ip || (isHealthy ? 'Détection...' : 'Indisponible');
    }

    // Meta (pays/ville/ISP)
    const meta = card.querySelector('.gw-meta');
    if (meta) {
      const loc = gw.location || {};
      meta.textContent = `${getFlagEmoji(loc.country)} ${loc.country || '--'} · ${loc.city || '--'}${gw.isp?.org ? ' · ' + gw.isp.org : ''}`;
    }

    // Latence
    const latCode = card.querySelector('.gw-latency code');
    if (latCode) latCode.textContent = `${gw.latencyMs} ms`;

    // Providers
    (gw.providers || []).forEach(p => {
      const pCard = card.querySelector(`[data-provider-id="${p.id}"]`);
      if (!pCard) return;
      const isRunning = p.running;
      const badge = pCard.querySelector('.node-status-badge');
      if (badge) {
        badge.className = `node-status-badge ${isRunning ? 'running' : 'stopped'}`;
        badge.textContent = isRunning ? 'Actif & Routé' : 'Arrêté';
      }
      const containerCode = pCard.querySelector('.node-info code');
      if (containerCode) containerCode.textContent = p.container;
    });
  });
}

// -----------------------------------------------------------------------------
// 1b. Render Gateway Cards (une par passerelle active)
// -----------------------------------------------------------------------------
function renderGateways(gateways) {
  nodesGridEl.innerHTML = '';
  if (!gateways.length) {
    const empty = document.createElement('div');
    empty.className = 'nodes-empty';
    empty.textContent = 'Aucune passerelle configurée.';
    nodesGridEl.appendChild(empty);
    return;
  }

  gateways.forEach(gw => {
    const card = document.createElement('div');
    card.className = 'gateway-card glass-card';
    card.dataset.gwId = gw.id;

    // En-tête passerelle
    const head = document.createElement('div');
    head.className = 'node-head';
    const titleBox = document.createElement('div');
    titleBox.className = 'node-title-box';
    const icon = document.createElement('span');
    icon.className = 'node-icon';
    icon.textContent = '🌐';
    titleBox.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'node-name';
    name.textContent = `Passerelle ${gw.num} (${gw.container})`;
    titleBox.appendChild(name);
    head.appendChild(titleBox);

    const isHealthy = gw.status === 'HEALTHY';
    const statusBadge = document.createElement('span');
    statusBadge.className = `node-status-badge ${isHealthy ? 'running' : 'stopped'}`;
    statusBadge.textContent = isHealthy ? 'Active' : (gw.status === 'UNKNOWN' ? 'En attente' : 'Hors ligne');
    head.appendChild(statusBadge);
    card.appendChild(head);

    // IP + localisation
    const ipRow = document.createElement('div');
    ipRow.className = 'gw-ip-row';
    const ipEl = document.createElement('code');
    ipEl.className = 'gw-ip';
    ipEl.textContent = gw.ip || (isHealthy ? 'Détection...' : 'Indisponible');
    ipRow.appendChild(ipEl);

    const meta = document.createElement('span');
    meta.className = 'gw-meta';
    const loc = gw.location || {};
    meta.textContent = `${getFlagEmoji(loc.country)} ${loc.country || '--'} · ${loc.city || '--'}${gw.isp?.org ? ' · ' + gw.isp.org : ''}`;
    ipRow.appendChild(meta);
    card.appendChild(ipRow);

    // Détails
    const info = document.createElement('div');
    info.className = 'node-info';

    const proxyLine = document.createElement('div');
    proxyLine.append('Proxy : ');
    const proxyCode = document.createElement('code');
    proxyCode.textContent = gw.activeProxy?.host
      ? `${gw.activeProxy.protocol}://${gw.activeProxy.host}:${gw.activeProxy.port}`
      : 'non configuré';
    proxyLine.appendChild(proxyCode);
    info.appendChild(proxyLine);

    if (typeof gw.latencyMs === 'number') {
      const latLine = document.createElement('div');
      latLine.className = 'gw-latency';
      latLine.append('Latence : ');
      const latCode = document.createElement('code');
      latCode.textContent = `${gw.latencyMs} ms`;
      latLine.appendChild(latCode);
      info.appendChild(latLine);
    }

    card.appendChild(info);

    // Providers de cette passerelle
    const providersWrap = document.createElement('div');
    providersWrap.className = 'gw-providers';
    (gw.providers || []).forEach(p => {
      providersWrap.appendChild(renderProviderCard(p, gw.id));
    });
    card.appendChild(providersWrap);

    nodesGridEl.appendChild(card);
  });
}

// -----------------------------------------------------------------------------
// 1c. Metrics temps réel (VM Performance)
// -----------------------------------------------------------------------------
const metricsGridEl = document.getElementById('metrics-grid');
const metricsStatusBadgeEl = document.getElementById('metrics-status-badge');

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '--';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Choisit la classe de couleur de la barre selon le seuil
function barClass(percent) {
  if (percent >= 90) return 'crit';
  if (percent >= 70) return 'warn';
  return '';
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}j ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function psiValueClass(val, warnThresh = 5, critThresh = 15) {
  if (typeof val !== 'number') return '';
  if (val >= critThresh) return 'crit';
  if (val >= warnThresh) return 'warn';
  return '';
}

function renderMetrics(data) {
  if (!metricsGridEl) return;
  const host = data.host;
  const containers = data.containers || {};

  // Badge de statut global de collecte
  if (metricsStatusBadgeEl) {
    const active = Boolean(host);
    metricsStatusBadgeEl.innerHTML = active
      ? '<span class="dot-green"></span><span>Collecte active</span>'
      : '<span class="dot-blue"></span><span>En attente de /proc</span>';
  }

  metricsGridEl.innerHTML = '';

  // ---------------------------------------------------------------------------
  // 1. Carte Hôte & Mémoire
  // ---------------------------------------------------------------------------
  const hostCard = document.createElement('div');
  hostCard.className = 'metrics-card';

  const hostHead = document.createElement('div');
  hostHead.className = 'metrics-card-header';
  const hostTitle = document.createElement('div');
  hostTitle.className = 'metric-label';
  hostTitle.textContent = host?.hostname ? `VM · ${host.hostname}` : 'VM Hôte';
  hostHead.appendChild(hostTitle);

  if (host?.uptimeSec) {
    const uptime = document.createElement('span');
    uptime.className = 'metric-detail';
    uptime.textContent = `up ${formatUptime(host.uptimeSec)}`;
    hostHead.appendChild(uptime);
  }
  hostCard.appendChild(hostHead);

  if (host) {
    const cpuPct = host.cpuPercent ?? 0;
    const mem = host.memory || {};
    const memPct = mem.usedPercent ?? 0;
    const swapTotal = mem.swapTotalBytes ?? 0;
    const swapUsed = mem.swapUsedBytes ?? 0;
    const swapPct = mem.swapUsedPercent ?? 0;

    // CPU
    const cpuRow = document.createElement('div');
    cpuRow.className = 'metric-row';
    cpuRow.innerHTML = `<span class="metric-label">CPU</span><span class="metric-value">${cpuPct.toFixed(1)} %</span>`;
    hostCard.appendChild(cpuRow);

    const cpuBar = document.createElement('div');
    cpuBar.className = 'metric-bar';
    const cpuFill = document.createElement('div');
    cpuFill.className = `metric-bar-fill ${barClass(cpuPct)}`;
    cpuFill.style.width = `${Math.min(cpuPct, 100)}%`;
    cpuBar.appendChild(cpuFill);
    hostCard.appendChild(cpuBar);

    // RAM
    const memRow = document.createElement('div');
    memRow.className = 'metric-row';
    memRow.innerHTML = `<span class="metric-label">RAM</span><span class="metric-value">${memPct} %</span>`;
    hostCard.appendChild(memRow);

    const memBar = document.createElement('div');
    memBar.className = 'metric-bar';
    const memFill = document.createElement('div');
    memFill.className = `metric-bar-fill ${barClass(memPct)}`;
    memFill.style.width = `${Math.min(memPct, 100)}%`;
    memBar.appendChild(memFill);
    hostCard.appendChild(memBar);

    if (typeof mem.usedBytes === 'number' && typeof mem.totalBytes === 'number') {
      const detail = document.createElement('div');
      detail.className = 'metric-detail';
      detail.textContent = `${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)}`;
      hostCard.appendChild(detail);
    }

    // Swap / zRAM
    if (swapTotal > 0) {
      const swapRow = document.createElement('div');
      swapRow.className = 'metric-row';
      swapRow.innerHTML = `<span class="metric-label">Swap / zRAM</span><span class="metric-value">${swapPct} %</span>`;
      hostCard.appendChild(swapRow);

      const swapBar = document.createElement('div');
      swapBar.className = 'metric-bar';
      const swapFill = document.createElement('div');
      swapFill.className = `metric-bar-fill ${barClass(swapPct)}`;
      swapFill.style.width = `${Math.min(swapPct, 100)}%`;
      swapBar.appendChild(swapFill);
      hostCard.appendChild(swapBar);

      const swapDetail = document.createElement('div');
      swapDetail.className = 'metric-detail';
      swapDetail.textContent = `${formatBytes(swapUsed)} / ${formatBytes(swapTotal)}`;
      hostCard.appendChild(swapDetail);
    }
  } else {
    const empty = document.createElement('div');
    empty.className = 'metrics-empty';
    empty.textContent = 'Métriques hôte indisponibles (/proc).';
    hostCard.appendChild(empty);
  }
  metricsGridEl.appendChild(hostCard);

  // ---------------------------------------------------------------------------
  // 2. Carte Pression Noyau (PSI — Pressure Stall Information)
  // ---------------------------------------------------------------------------
  const psiCard = document.createElement('div');
  psiCard.className = 'metrics-card';

  const psiHead = document.createElement('div');
  psiHead.className = 'metrics-card-header';
  const psiTitle = document.createElement('div');
  psiTitle.className = 'metric-label';
  psiTitle.textContent = 'Pression Noyau (PSI)';
  psiHead.appendChild(psiTitle);

  const pressure = host?.pressure;
  const status = pressure?.status || { level: 'unknown', label: 'N/A' };
  const badgeClass = status.level === 'critical' ? 'crit' : status.level === 'warning' ? 'warn' : status.level === 'nominal' ? 'ok' : 'unknown';

  const psiBadge = document.createElement('span');
  psiBadge.className = `psi-badge ${badgeClass}`;
  psiBadge.textContent = status.label;
  psiBadge.title = status.message || '';
  psiHead.appendChild(psiBadge);
  psiCard.appendChild(psiHead);

  if (pressure && (pressure.memory || pressure.cpu || pressure.io)) {
    const psiList = document.createElement('div');
    psiList.className = 'psi-metrics-list';

    // Mémoire full & some
    const memFull = pressure.memory?.full?.avg10;
    const memSome = pressure.memory?.some?.avg10;
    const memFullRow = document.createElement('div');
    memFullRow.className = 'psi-metric-item';
    memFullRow.innerHTML = `
      <span class="psi-metric-name">Mémoire (full stall)</span>
      <span class="psi-metric-val ${psiValueClass(memFull, 5, 15)}">${typeof memFull === 'number' ? memFull.toFixed(2) + ' %' : '--'}</span>
    `;
    psiList.appendChild(memFullRow);

    const memSomeRow = document.createElement('div');
    memSomeRow.className = 'psi-metric-item';
    memSomeRow.innerHTML = `
      <span class="psi-metric-name">Mémoire (some stall)</span>
      <span class="psi-metric-val ${psiValueClass(memSome, 20, 50)}">${typeof memSome === 'number' ? memSome.toFixed(2) + ' %' : '--'}</span>
    `;
    psiList.appendChild(memSomeRow);

    // CPU some
    const cpuSome = pressure.cpu?.some?.avg10;
    const cpuSomeRow = document.createElement('div');
    cpuSomeRow.className = 'psi-metric-item';
    cpuSomeRow.innerHTML = `
      <span class="psi-metric-name">CPU (some stall)</span>
      <span class="psi-metric-val ${psiValueClass(cpuSome, 50, 80)}">${typeof cpuSome === 'number' ? cpuSome.toFixed(2) + ' %' : '--'}</span>
    `;
    psiList.appendChild(cpuSomeRow);

    // I/O full
    const ioFull = pressure.io?.full?.avg10;
    const ioFullRow = document.createElement('div');
    ioFullRow.className = 'psi-metric-item';
    ioFullRow.innerHTML = `
      <span class="psi-metric-name">I/O Disque (full stall)</span>
      <span class="psi-metric-val ${psiValueClass(ioFull, 15, 40)}">${typeof ioFull === 'number' ? ioFull.toFixed(2) + ' %' : '--'}</span>
    `;
    psiList.appendChild(ioFullRow);

    psiCard.appendChild(psiList);

    const note = document.createElement('div');
    note.className = 'psi-help-note';
    note.textContent = 'Moyenne 10s (/proc/pressure) · Seuil thrashing critique : mem full ≥ 15%';
    psiCard.appendChild(note);
  } else {
    const empty = document.createElement('div');
    empty.className = 'metrics-empty';
    empty.textContent = 'PSI non exposé par le noyau hôte.';
    psiCard.appendChild(empty);
  }
  metricsGridEl.appendChild(psiCard);

  // ---------------------------------------------------------------------------
  // 3. Carte Conteneurs
  // ---------------------------------------------------------------------------
  const containerCard = document.createElement('div');
  containerCard.className = 'metrics-card';
  const containerTitle = document.createElement('div');
  containerTitle.className = 'metric-label';
  const names = Object.keys(containers);
  containerTitle.textContent = `Conteneurs actifs (${names.length})`;
  containerCard.appendChild(containerTitle);

  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'metrics-empty';
    empty.textContent = 'Aucun conteneur actif.';
    containerCard.appendChild(empty);
  } else {
    const table = document.createElement('div');
    table.className = 'metrics-container-table';
    names.sort().forEach(name => {
      const m = containers[name];
      if (!m) return;
      const row = document.createElement('div');
      row.className = 'metrics-container-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'metrics-container-name';
      nameEl.textContent = name;
      nameEl.title = name;
      const usage = document.createElement('span');
      usage.className = 'metrics-container-usage';
      const memMb = m.memory?.usage ? formatBytes(m.memory.usage) : '--';
      usage.textContent = `${m.cpuPercent?.toFixed(1) ?? '--'}% · ${memMb} (${m.memory?.percent ?? '--'}%)`;
      row.appendChild(nameEl);
      row.appendChild(usage);
      table.appendChild(row);
    });
    containerCard.appendChild(table);
  }
  metricsGridEl.appendChild(containerCard);
}

async function fetchMetrics() {
  if (!state.authenticated) return;
  try {
    const res = await apiFetch('/api/metrics');
    const data = await res.json();
    renderMetrics(data);
  } catch (err) {
    console.error('Error fetching metrics:', err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// 2. Render Provider Card (dans le contexte d'une passerelle)
// -----------------------------------------------------------------------------
function renderProviderCard(p, gwId) {
  const card = document.createElement('div');
  card.className = 'node-card glass-card';
  card.dataset.providerId = p.id;

  const head = document.createElement('div');
  head.className = 'node-head';

  const titleBox = document.createElement('div');
  titleBox.className = 'node-title-box';

  const icon = document.createElement('span');
  icon.className = 'node-icon';
  icon.textContent = p.icon || '📦';
  titleBox.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'node-name';
  name.textContent = p.name || p.id;
  titleBox.appendChild(name);
  head.appendChild(titleBox);

  const isRunning = p.running;
  const statusBadge = document.createElement('span');
  statusBadge.className = `node-status-badge ${isRunning ? 'running' : 'stopped'}`;
  statusBadge.textContent = isRunning ? 'Actif & Routé' : 'Arrêté';
  head.appendChild(statusBadge);
  card.appendChild(head);

  const info = document.createElement('div');
  info.className = 'node-info';

  const containerLine = document.createElement('div');
  const containerCode = document.createElement('code');
  containerCode.textContent = p.container;
  containerLine.append('Conteneur : ', containerCode);
  info.appendChild(containerLine);

  const networkLine = document.createElement('div');
  const networkCode = document.createElement('code');
  networkCode.textContent = `service:${gwId === 'gw1' ? 'gateway-isp' : `gateway-isp-${gwId.replace('gw', '')}`}`;
  networkLine.append('Réseau : ', networkCode);
  info.appendChild(networkLine);
  card.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'node-actions';

  const actionButtons = isRunning
    ? [['restart', 'Redémarrer', 'btn-secondary'], ['stop', 'Arrêter', 'btn-secondary']]
    : [['start', 'Démarrer', 'btn-primary']];
  for (const [action, label, variant] of actionButtons) {
    const btn = document.createElement('button');
    btn.className = `btn ${variant} btn-sm`;
    btn.textContent = label;
    btn.addEventListener('click', () => nodeAction(gwId, p.id, action));
    actions.appendChild(btn);
  }

  const dashboardLink = document.createElement('a');
  dashboardLink.href = p.dashboard;
  dashboardLink.target = '_blank';
  dashboardLink.rel = 'noopener noreferrer';
  dashboardLink.className = 'btn btn-secondary btn-sm';
  dashboardLink.title = 'Ouvrir le tableau de bord';
  dashboardLink.textContent = 'Dashboard ↗';
  actions.appendChild(dashboardLink);
  card.appendChild(actions);

  return card;
}

window.nodeAction = async function(gwId, id, action) {
  showToast(`Action ${action} en cours sur ${id} (${gwId})...`, 'info');
  try {
    const res = await apiFetch(`/api/gateways/${gwId}/providers/${id}/${action}`, { method: 'POST' });
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
async function withBusy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

const quickRefreshBtn = document.getElementById('btn-quick-refresh');
if (quickRefreshBtn) {
  quickRefreshBtn.addEventListener('click', () => {
    withBusy(quickRefreshBtn, async () => {
      showToast('Rafraîchissement des métriques et de la passerelle...', 'info');
      await fetchStatus();
      showToast('Métriques mises à jour avec succès !', 'success');
    });
  });
}

// Copy IP button (copie la première passerelle active)
document.getElementById('btn-copy-ip').addEventListener('click', async () => {
  const first = state.status?.gateways?.find(g => g.ip);
  const ip = first ? first.ip : null;
  if (ip) {
    try {
      await copyToClipboard(ip);
      showToast(`Adresse IP ${ip} copiée dans le presse-papier !`);
    } catch {
      showToast('Impossible de copier l\'adresse IP', 'error');
    }
  } else {
    showToast('Aucune adresse IP disponible', 'error');
  }
});

// Refresh header button
const refreshStatusBtn = document.getElementById('btn-refresh-status');
if (refreshStatusBtn) {
  refreshStatusBtn.addEventListener('click', () => {
    withBusy(refreshStatusBtn, async () => {
      await fetchStatus();
      showToast('Métriques rafraîchies', 'info');
    });
  });
}

// Restart all nodes button (tous les providers de toutes les passerelles)
document.getElementById('btn-restart-all-nodes').addEventListener('click', async () => {
  showToast('Redémarrage des conteneurs de monétisation...', 'info');
  const gateways = state.status?.gateways || [];
  for (const gw of gateways) {
    for (const p of gw.providers || []) {
      if (p.running) {
        await window.nodeAction(gw.id, p.id, 'restart');
      }
    }
  }
});

// -----------------------------------------------------------------------------
// 3b. Configuration (.env) — édition depuis le dashboard
// -----------------------------------------------------------------------------
// Catégories de l'éditeur : global + une section repliable par passerelle + legacy
const CATEGORY_LABELS = {
  global: '⚙️ Global (dashboard)',
  gw1: 'Passerelle 1 — Proxy 1',
  gw2: 'Passerelle 2 — Proxy 2',
  gw3: 'Passerelle 3 — Proxy 3',
  gw4: 'Passerelle 4 — Proxy 4',
  legacy: 'Clés héritées (mono-passerelle)'
};

const CATEGORY_ORDER = ['global', 'gw1', 'gw2', 'gw3', 'gw4', 'legacy'];

async function fetchConfig() {
  if (!state.authenticated) return;
  try {
    const res = await apiFetch('/api/config');
    if (!res.ok) return;
    const data = await res.json();
    renderConfig(data.config);
  } catch (err) {
    console.error('Error fetching config:', err);
  }
}

function renderConfig(config) {
  const container = document.getElementById('config-fields');
  container.innerHTML = '';

  const groups = {};
  for (const item of config) {
    (groups[item.category] = groups[item.category] || []).push(item);
  }

  for (const category of CATEGORY_ORDER) {
    const items = groups[category];
    if (!items || !items.length) continue;
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
  const nearBottom = terminalBodyEl.scrollHeight - terminalBodyEl.scrollTop - terminalBodyEl.clientHeight < 60;
  const lineEl = document.createElement('div');
  lineEl.className = 'log-line';
  lineEl.innerText = line;
  terminalBodyEl.appendChild(lineEl);
  if (nearBottom) terminalBodyEl.scrollTop = terminalBodyEl.scrollHeight;
}

async function fetchContainerLogs(name, opts = {}) {
  const { silent = false } = opts;
  // N'affiche "Récupération..." que si l'écran est vide (premier chargement),
  // pas à chaque tick de polling (évite le clignotement cyclique).
  if (!silent && !terminalBodyEl.textContent.trim()) {
    terminalBodyEl.innerHTML = `<div class="log-line">[LOGS] Récupération des logs du conteneur ${name}...</div>`;
  }
  try {
    const res = await apiFetch(`/api/logs/container/${encodeURIComponent(name)}?tail=80`);
    const data = await res.json();
    if (!res.ok) {
      if (!silent) {
        terminalBodyEl.innerHTML = '';
        appendLogLine(`[ERROR] ${data.error || 'Erreur inconnue'}`);
      }
      return;
    }
    const lines = (data.logs || '').split('\n').filter(l => l.trim());
    if (!silent) terminalBodyEl.innerHTML = '';
    if (!lines.length) {
      if (!silent) appendLogLine(`[LOGS] Aucun log disponible pour ${name} (conteneur arrêté ou vide).`);
      return;
    }
    lines.forEach(l => appendLogLine(l));
  } catch (err) {
    if (!silent) {
      terminalBodyEl.innerHTML = '';
      appendLogLine(`[ERROR] Impossible de récupérer les logs: ${err.message}`);
    }
  }
}

// Log tabs — construits dynamiquement à partir des passerelles et providers
const CONTAINER_LOG_POLL_MS = 5000;

function rebuildLogTabs(gateways) {
  const tabsEl = document.getElementById('log-tabs');
  if (!tabsEl) return;
  const current = state.activeLogTarget;
  tabsEl.innerHTML = '';

  const sysTab = document.createElement('button');
  sysTab.className = 'tab-btn' + (current === 'system' ? ' active' : '');
  sysTab.dataset.target = 'system';
  sysTab.textContent = 'Système / Hub';
  tabsEl.appendChild(sysTab);

  const targets = [];
  for (const gw of gateways) {
    targets.push({ name: gw.container, label: gw.container });
    for (const p of gw.providers || []) {
      targets.push({ name: p.container, label: p.container });
    }
  }
  for (const t of targets) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (current === t.name ? ' active' : '');
    btn.dataset.target = t.name;
    btn.textContent = t.label;
    tabsEl.appendChild(btn);
  }
}

document.getElementById('log-tabs').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    const target = e.target.dataset.target;
    state.activeLogTarget = target;
    terminalTitleEl.innerText = `Flux : ${e.target.innerText}`;

    if (state.logPollTimer) {
      clearInterval(state.logPollTimer);
      state.logPollTimer = null;
    }

    if (target === 'system') {
      terminalBodyEl.innerHTML = '<div class="log-line">[SYSTEM] Écoute du flux des logs système...</div>';
    } else {
      fetchContainerLogs(target);
      state.logPollTimer = setInterval(() => fetchContainerLogs(target, { silent: true }), CONTAINER_LOG_POLL_MS);
    }
  }
});

document.getElementById('btn-clear-logs').addEventListener('click', () => {
  terminalBodyEl.innerHTML = '';
});

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------
let statusPoller = null;
let metricsPoller = null;

async function initAuthenticated(hasStatus = false) {
  state.authenticated = true;

  // Premier snapshot si pas déjà reçu par le check de session
  if (!hasStatus) {
    await fetchStatus();
  }
  if (state.status?.gateways) rebuildLogTabs(state.status.gateways);

  // Le reste en parallèle (config + SSE ne dépendent pas du status)
  await Promise.allSettled([fetchConfig(), setupLogsSSE()]);

  // Polling adaptatif unique (remplace les setInterval 10 s)
  if (!statusPoller) {
    statusPoller = new AdaptivePoller(fetchStatus, { baseIntervalMs: 10000 });
    statusPoller.start();
  }

  // Polling des métriques temps réel (5 s, avec backoff adaptatif)
  if (!metricsPoller) {
    metricsPoller = new AdaptivePoller(fetchMetrics, { baseIntervalMs: 5000, maxIntervalMs: 30000 });
    metricsPoller.start();
  }
}

async function init() {
  // Démarrage : vérifie si une session existe déjà.
  // Le cookie csrf (non-httpOnly) est posé en même temps que la session :
  // s'il est absent, on affiche le login sans requête (évite un 401 volontaire
  // et son log d'erreur dans la console).
  if (getCookie('csrf')) {
    try {
      const res = await apiFetch('/api/status');
      if (res.ok) {
        // Réutilise la réponse déjà reçue pour le premier rendu
        const data = await res.json();
        state.status = data;
        renderStatus(data);
        state.authenticated = true;
        await initAuthenticated(true);
        return;
      }
    } catch { /* session invalide → login */ }
  }
  showLogin();
  if (!statusPoller) {
    statusPoller = new AdaptivePoller(fetchStatus, { baseIntervalMs: 10000 });
    statusPoller.start();
  }
}

init();
