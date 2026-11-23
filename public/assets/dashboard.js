const API_BASE = "/api/submarine/v1";
const POLL_INTERVAL = 12_000;
const $ = (selector) => document.querySelector(selector);
const state = { servers: [], expandedGroup: null, selectedServerId: null, lastGeneratedAt: null };

const totalOnline = $("#totalOnline");
const groupsElement = $("#groups");
const dialog = $("#serverDialog");

function number(value, digits = 0) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits }).format(Number(value));
}

function serverWord(count) {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "серверов";
  if (last === 1) return "сервер";
  if (last >= 2 && last <= 4) return "сервера";
  return "серверов";
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}д ${hours}ч`;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  return `${minutes}м ${seconds % 60}с`;
}

function timeAgo(timestamp) {
  if (!timestamp) return "данных ещё нет";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 5) return "только что";
  if (seconds < 60) return `${seconds}с назад`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}м назад`;
  return `${Math.floor(minutes / 60)}ч назад`;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("submarine-theme", theme);
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#081426" : "#f2f6fc";
  const icon = theme === "dark" ? "sun" : "moon";
  $("#themeToggle").innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i>`;
  window.dispatchEvent(new CustomEvent("submarine-themechange", { detail: { theme } }));
  window.lucide?.createIcons();
}

function initialiseTheme() {
  const saved = localStorage.getItem("submarine-theme");
  setTheme(saved || "dark");
}

function setConnectionState(kind, label) {
  const indicator = $(".live-indicator");
  indicator.classList.toggle("is-live", kind === "live");
  indicator.classList.toggle("is-error", kind === "error");
  $("#connectionLabel").textContent = label;
}

function getCurrentStats(server) {
  return server?.online && server.stats ? server.stats : server?.stats;
}

function groupLabel(server) {
  const groups = [...new Set(state.servers.map((entry) => entry.group || "Servers"))];
  const index = groups.indexOf(server.group || "Servers");
  return index >= 0 ? `Сеть ${index + 1}` : "СЕРВЕР";
}

function updateSummary(payload) {
  const live = state.servers.filter((server) => server.online && server.stats);
  const onlineCount = live.reduce((sum, server) => sum + (Number(server.stats.online) || 0), 0);
  const tpsValues = live.map((server) => Number(server.stats.tps_average)).filter(Number.isFinite);
  const loadValues = live.map((server) => Number(server.stats.load_average_percent)).filter(Number.isFinite);
  totalOnline.textContent = number(payload.total_online ?? onlineCount);
  $("#onlineServers").textContent = number(live.length);
  $("#registeredServers").textContent = `из ${number(state.servers.length)} серверов`;
  $("#averageTps").textContent = tpsValues.length ? number(tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length, 2) : "—";
  $("#averageLoad").textContent = loadValues.length ? `${number(loadValues.reduce((a, b) => a + b, 0) / loadValues.length, 1)}%` : "—";
  $("#serverCount").textContent = number(state.servers.length);
  $("#updatedAt").textContent = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date((payload.generated_at || Date.now() / 1000) * 1000));
  $("#overviewCaption").textContent = live.length
    ? `${number(live.length)} ${serverWord(live.length)} ${live.length === 1 ? "принимает" : "принимают"} соединения`
    : "Нет активных серверов";
}

function makeServerCard(server) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `server-card${server.online ? " is-online" : ""}`;
  button.setAttribute("aria-label", `${server.name}: ${server.online ? "онлайн" : "офлайн"}`);
  const stats = getCurrentStats(server);
  const tps = stats ? `${number(stats.tps_average, 2)} TPS` : "TPS —";
  const online = stats ? `${number(stats.online)}/${number(stats.max_players)}` : "—/—";
  button.innerHTML = `
    <span class="server-card-main">
      <span class="server-card-name"></span>
      <span class="server-card-meta">${tps} <span aria-hidden="true">·</span> ${online}</span>
    </span>
    <span class="server-card-side">
      <span class="server-card-status" aria-hidden="true"></span>
      <span class="server-card-arrow"><i data-lucide="arrow-up-right" aria-hidden="true"></i></span>
    </span>`;
  button.querySelector(".server-card-name").textContent = server.name;
  button.addEventListener("click", () => openServer(server.id));
  return button;
}

function renderGroups() {
  groupsElement.replaceChildren();
  if (!state.servers.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = '<span class="empty-mark" aria-hidden="true"><i data-lucide="radio-tower"></i></span><div><strong>Серверы пока не зарегистрированы</strong><p>Подключённые ядра появятся в этом списке.</p></div>';
    groupsElement.append(empty);
    window.lucide?.createIcons();
    return;
  }

  const groups = new Map();
  for (const server of state.servers) {
    const label = server.group || "Серверы";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(server);
  }

  for (const [groupName, servers] of groups) {
    const online = servers.filter((server) => server.online).length;
    const players = servers.reduce((sum, server) => sum + (server.online ? Number(server.stats?.online) || 0 : 0), 0);
    const item = document.createElement("section");
    const open = state.expandedGroup === groupName;
    item.className = `group-item${open ? " is-open" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group-toggle";
    button.setAttribute("aria-expanded", String(open));
    button.innerHTML = `
      <span class="group-main">
        <span class="group-icon"><i data-lucide="network" aria-hidden="true"></i></span>
        <span class="group-title-wrap"><span class="group-title"></span><span class="group-caption"></span></span>
      </span>
      <span class="group-online"></span>
      <span class="group-chevron"><i data-lucide="chevron-down" aria-hidden="true"></i></span>`;
    button.querySelector(".group-title").textContent = `Сеть ${groups.size ? [...groups.keys()].indexOf(groupName) + 1 : 1}`;
    button.querySelector(".group-caption").textContent = `${online} из ${servers.length} в сети`;
    button.querySelector(".group-online").textContent = `${number(players)} онлайн`;

    if (servers.length === 1) {
      button.setAttribute("aria-label", `${button.querySelector(".group-title").textContent}, открыть статистику сервера`);
      button.addEventListener("click", () => openServer(servers[0].id));
    } else {
      button.addEventListener("click", () => {
        state.expandedGroup = state.expandedGroup === groupName ? null : groupName;
        renderGroups();
      });
    }

    const disclosure = document.createElement("div");
    disclosure.className = "group-servers";
    const inner = document.createElement("div");
    inner.className = "group-servers-inner";
    const list = document.createElement("div");
    list.className = "server-list";
    for (const server of servers) list.append(makeServerCard(server));
    inner.append(list);
    disclosure.append(inner);
    item.append(button, disclosure);
    groupsElement.append(item);
  }
  window.lucide?.createIcons();
}

function addDetail(label, value) {
  const item = document.createElement("div");
  item.className = "detail-item";
  const labelNode = document.createElement("span");
  labelNode.className = "detail-label";
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.className = "detail-value";
  valueNode.textContent = value;
  item.append(labelNode, valueNode);
  $("#detailGrid").append(item);
}

function renderDetails(server) {
  const stats = getCurrentStats(server);
  $("#dialogServerName").textContent = server.name;
  $("#dialogGroup").textContent = groupLabel(server);
  $("#dialogAddress").textContent = server.address || "";
  $("#dialogSeen").textContent = `Обновление ${timeAgo(server.last_seen)}`;
  const status = $("#dialogStatus");
  status.classList.toggle("is-online", Boolean(server.online));
  status.innerHTML = `<i></i>${server.online ? "В сети" : "Офлайн"}`;

  const grid = $("#detailGrid");
  grid.replaceChildren();
  if (!stats) {
    addDetail("Игроки", "Нет данных");
    addDetail("TPS", "—");
    addDetail("Память", "—");
    addDetail("Потоки", "—");
    $("#worldList").innerHTML = '<div class="world-empty">Статистика появится после первого отчёта.</div>';
    drawHistory([]);
    return;
  }

  const memory = stats.memory_mb || {};
  addDetail("Онлайн", `${number(stats.online)}/${number(stats.max_players)}`);
  addDetail("TPS сейчас", number(stats.tps_current, 2));
  addDetail("TPS средний", number(stats.tps_average, 2));
  addDetail("Нагрузка сейчас", `${number(stats.load_current_percent, 1)}%`);
  addDetail("Нагрузка средняя", `${number(stats.load_average_percent, 1)}%`);
  addDetail("Аптайм", formatDuration(stats.uptime_seconds));
  addDetail("Потоки", number(stats.thread_count));
  addDetail("Память основного потока", `${number(memory.main, 2)} MB`);
  addDetail("Всего памяти", `${number(memory.total, 2)} MB`);
  addDetail("Виртуальная память", `${number(memory.virtual, 2)} MB`);
  addDetail("Heap", `${number(memory.heap, 2)} MB`);
  addDetail("Лимит памяти", memory.max > 0 ? `${number(memory.max, 2)} MB` : "Без лимита");
  addDetail("Отправка", `${number(stats.network_upload_kb_s, 2)} kB/s`);
  addDetail("Загрузка", `${number(stats.network_download_kb_s, 2)} kB/s`);

  const worlds = $("#worldList");
  worlds.replaceChildren();
  if (!stats.worlds?.length) {
    worlds.innerHTML = '<div class="world-empty">Миры не загружены.</div>';
  } else {
    for (const world of stats.worlds) {
      const row = document.createElement("div");
      row.className = "world-row";
      const name = document.createElement("span");
      name.className = "world-name";
      name.textContent = world.name && world.name !== world.folder ? `${world.folder} (${world.name})` : world.folder;
      row.append(name);
      for (const [value, label] of [[world.chunks, "чанков"], [world.entities, "сущностей"], [world.tiles, "тайлов"], [`${number(world.tick_ms, 2)} ms`, "тик"]]) {
        const stat = document.createElement("span");
        stat.className = "world-stat";
        const strong = document.createElement("strong");
        strong.textContent = typeof value === "string" ? value : number(value);
        const caption = document.createElement("span");
        caption.textContent = label;
        stat.append(strong, caption);
        row.append(stat);
      }
      worlds.append(row);
    }
  }
  drawHistory(server.history || []);
}

async function openServer(serverId) {
  state.selectedServerId = serverId;
  let server = state.servers.find((entry) => entry.id === serverId);
  if (!server) {
    try {
      const response = await fetch(`${API_BASE}/servers/${encodeURIComponent(serverId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("server not found");
      server = await response.json();
    } catch {
      return;
    }
  }
  renderDetails(server);
  if (!dialog.open) dialog.showModal();
  window.lucide?.createIcons();
}

function drawHistory(history) {
  const canvas = $("#historyChart");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(118 * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  const width = rect.width;
  const height = 118;
  const left = 4;
  const right = width - 4;
  const top = 9;
  const bottom = height - 14;
  const computed = getComputedStyle(document.documentElement);
  const lineColor = computed.getPropertyValue("--line").trim();
  const accent = computed.getPropertyValue("--accent").trim();
  const coral = computed.getPropertyValue("--coral").trim();
  context.clearRect(0, 0, width, height);
  context.strokeStyle = lineColor;
  context.lineWidth = 1;
  for (let index = 0; index < 3; index++) {
    const y = top + ((bottom - top) / 2) * index;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
  }
  const points = history.filter((point) => point?.stats).slice(-360);
  if (points.length < 2) {
    context.fillStyle = computed.getPropertyValue("--muted").trim();
    context.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    context.fillText("История появится после нескольких обновлений", 4, 60);
    return;
  }
  const series = [
    { key: "tps_average", max: 20, color: accent },
    { key: "load_average_percent", max: 100, color: coral },
  ];
  for (const line of series) {
    context.beginPath();
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.strokeStyle = line.color;
    points.forEach((point, index) => {
      const x = left + ((right - left) * index) / (points.length - 1);
      const value = Math.min(line.max, Math.max(0, Number(point.stats[line.key]) || 0));
      const y = bottom - ((bottom - top) * value) / line.max;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
}

async function refresh() {
  try {
    const response = await fetch(`${API_BASE}/servers`, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = await response.json();
    state.servers = Array.isArray(payload.servers) ? payload.servers : [];
    state.lastGeneratedAt = payload.generated_at;
    updateSummary(payload);
    renderGroups();
    $("#apiError").hidden = true;
    setConnectionState("live", "Данные обновляются");
    if (state.selectedServerId && dialog.open) {
      const selected = state.servers.find((server) => server.id === state.selectedServerId);
      if (selected) renderDetails(selected);
    }
  } catch {
    $("#apiError").hidden = false;
    setConnectionState("error", "Нет соединения с API");
    if (!state.servers.length) {
      $("#overviewCaption").textContent = "Серверы временно недоступны";
    }
  }
}

function activateTab(activeTab, focus = false) {
  const pairs = [
    [$("#overviewTab"), $("#overviewPanel")],
    [$("#apiTab"), $("#apiPanel")],
  ];
  for (const [tab, panel] of pairs) {
    const active = tab === activeTab;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
  if (focus) activeTab.focus();
}

const tabs = [$("#overviewTab"), $("#apiTab")];
for (const tab of tabs) {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
            : -1;
    if (next >= 0) {
      event.preventDefault();
      activateTab(tabs[next], true);
    }
  });
}

initialiseTheme();
$("#themeToggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
$("#dialogClose").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
window.addEventListener("resize", () => {
  if (dialog.open && state.selectedServerId) {
    const server = state.servers.find((entry) => entry.id === state.selectedServerId);
    if (server) drawHistory(server.history || []);
  }
});
refresh();
window.setInterval(refresh, POLL_INTERVAL);
import("./network-scene.js?v=20261123-3").catch(() => document.querySelector(".scene-wrap")?.classList.add("scene-fallback"));
