/* ============================================================
   script.js
   ------------------------------------------------------------
   UI + storage + execução. Não conhece as regras matemáticas.
   Depende de: regrasdeganhos.js v3 (deve vir ANTES no HTML)

   CORREÇÕES v3.3:
   - init() NUNCA aborta quando já estamos na própria página
     do jogo (index.html). Nesse caso, cria usuário convidado
     temporário em memória para o jogo funcionar.
   - Elimina o "tela morta": botões sempre recebem listeners.
   - Aviso visual se regrasdeganhos.js não carregar.
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     DEPENDÊNCIAS DO MOTOR DE REGRAS
     ============================================================ */
  const R = window.RegrasDeGanhos;
  if (!R) {
    console.error("regrasdeganhos.js não foi carregado. Abortando.");
    // Aviso visual em vez de silêncio total
    try {
      const warn = document.createElement("div");
      warn.style.cssText =
        "position:fixed;inset:auto 12px 12px 12px;z-index:99999;" +
        "background:#7f1d1d;color:#fff;padding:12px 16px;border-radius:12px;" +
        "font:600 14px Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5)";
      warn.textContent = "⚠ regrasdeganhos.js não carregou. Verifique o caminho do arquivo.";
      document.body.appendChild(warn);
    } catch (e) {}
    return;
  }

  const {
    SYMBOL_TABLE, SYMBOLS, ROLLABLE_SYMBOLS, TOTAL_WEIGHT, NUM_LINES,
    PAYLINES, OUTCOME_CATEGORIES, CATEGORY_ORDER, WIN_TYPES,
    MODES, EVENT_CONFIG, EVENT_STATES,
    GameEngine,
    getWinType, getSymbolById,
  } = R;

  /* ============================================================
     CONSTANTES DE UI/STORAGE
     ============================================================ */
  const STORAGE_USERS = "cassino_users_v1";
  const STORAGE_SESSION = "cassino_session_v1";
  const STORAGE_HISTORY = "cassino_history_v1";
  const AUTO_SPIN_OPTIONS = [10, 25, 50, 100, 250, 500, 1000];

  const GAME_STATES = { IDLE: "idle", SPINNING: "spinning", RESULT: "result", WIN: "win", SUPER_WIN: "super-win", EVENT: "event" };

  /* ============================================================
     ESTADO
     ============================================================ */
  let currentState = GAME_STATES.IDLE;
  let currentEventState = EVENT_STATES.LOCKED;

  const autoSpin = {
    active: false,
    totalRounds: 25,
    currentRound: 0,
    turbo: false,
    cancelRequested: false,
    results: [],
    roundTurboSnapshot: false,
  };

  let currentUser = null;
  let currentBetCents = 10;
  let currentMode = "normal";
  let turboActive = false;
  let audioCtx = null;
  let userGestureReceived = false;

  let sessionStats = {
    spins: 0, wagered: 0, won: 0, hits: 0,
    superWins: 0, biggestWin: 0, events: 0,
    lastCategory: "—",
  };
  let debugVisible = false;

  let redirecting = false;

  const $ = (id) => document.getElementById(id);

  /* ============================================================
     UTILS
     ============================================================ */
  function formatCents(cents) {
    return (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function formatInt(n) {
    return Number(n || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  }
  function vibrate(ms = 12) {
    try {
      if (!userGestureReceived) return;
      if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
      navigator.vibrate(ms);
    } catch (e) {}
  }
  function toast(msg, type = "success") {
    const el = $("toast"); if (!el) return;
    const icon = type === "error" ? "fa-circle-exclamation" : "fa-circle-check";
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${msg}</span>`;
    el.className = "toast show" + (type === "error" ? " error" : "");
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function currentFileName() {
    try {
      const p = window.location.pathname || "";
      const last = p.split("/").pop() || "";
      return last.toLowerCase();
    } catch (e) { return ""; }
  }

  /**
   * Redirecionamento seguro contra loop.
   * Retorna true se disparou, false se já estamos no destino.
   */
  function safeRedirect(url) {
    if (redirecting) return false;
    let targetFile = "";
    try {
      targetFile = String(url).split("/").pop().split("#")[0].split("?")[0].toLowerCase();
    } catch (e) { targetFile = ""; }
    const here = currentFileName();
    if (here && targetFile && here === targetFile) return false;
    redirecting = true;
    window.location.replace(url);
    return true;
  }

  function setState(newState) {
    currentState = newState;
    const lbl = $("stateLabel");
    if (lbl) {
      const modeTag = turboActive ? "RAIO" : "NORMAL";
      const rtp = getTheoreticalRTPPercent();
      lbl.textContent = `RTP ${rtp.toFixed(1)}% · ${modeTag} · ${newState.toUpperCase()}`;
    }
    if (debugVisible) { const dbg = $("dbgState"); if (dbg) dbg.textContent = newState.toUpperCase(); }
  }
  function setEventState(s) {
    currentEventState = s;
    if (debugVisible) { const dbg = $("dbgEvent"); if (dbg) dbg.textContent = s; }
  }

  function getTheoreticalRTPPercent() {
    const res = GameEngine.calculateTheoreticalRTP();
    if (typeof res === "number") return res * 100;
    if (res && typeof res.rtp === "number") return res.rtp;
    return 0;
  }

  /* ============================================================
     RESOLUÇÃO DE SÍMBOLO
     ============================================================ */
  function resolveSymbol(s) {
    if (s == null) return null;
    if (typeof s === "object" && s.icon) return s;
    if (typeof s === "string") {
      const byId = (typeof getSymbolById === "function") ? getSymbolById(s) : null;
      if (byId) return byId;
      if (SYMBOL_TABLE && SYMBOL_TABLE[s]) return SYMBOL_TABLE[s];
      return null;
    }
    if (typeof s === "number") {
      if (Array.isArray(SYMBOLS) && SYMBOLS[s]) {
        const cand = SYMBOLS[s];
        if (typeof cand === "object" && cand.icon) return cand;
        if (typeof cand === "string") return resolveSymbol(cand);
      }
      return null;
    }
    return null;
  }

  function symbolHTML(sy) {
    const obj = resolveSymbol(sy);
    if (!obj) return "";
    return SVG[obj.icon] || `<span>${obj.id}</span>`;
  }

  /* ============================================================
     STORAGE
     ============================================================ */
  function getUsers() { try { return JSON.parse(localStorage.getItem(STORAGE_USERS)) || []; } catch { return []; } }
  function saveUsers(users) { localStorage.setItem(STORAGE_USERS, JSON.stringify(users)); }
  function getSession() { return localStorage.getItem(STORAGE_SESSION); }
  function clearSession() { localStorage.removeItem(STORAGE_SESSION); }

  function updateCurrentUser(updates) {
    if (!currentUser) return;
    // Se for convidado temporário, apenas atualiza em memória.
    if (currentUser.guest) {
      Object.assign(currentUser, updates);
      return;
    }
    const users = getUsers();
    const idx = users.findIndex(u => u.id === currentUser.id);
    if (idx >= 0) { users[idx] = { ...users[idx], ...updates }; saveUsers(users); currentUser = users[idx]; }
  }
  function addHistory(item) {
    try {
      const hist = JSON.parse(localStorage.getItem(STORAGE_HISTORY)) || [];
      hist.unshift(item);
      localStorage.setItem(STORAGE_HISTORY, JSON.stringify(hist.slice(0, 100)));
    } catch {}
  }

  function persistUserStats(extra = {}) {
    if (!currentUser) return;
    const prev = currentUser.stats || {};
    const updated = {
      totalSpins:     (prev.totalSpins     || 0) + 1,
      totalHits:      (prev.totalHits      || 0) + (extra.hit ? 1 : 0),
      totalWagered:   (prev.totalWagered   || 0) + (extra.wagered || 0),
      totalWon:       (prev.totalWon       || 0) + (extra.won || 0),
      bigWins:        (prev.bigWins        || 0) + (extra.bigWin ? 1 : 0),
      megaWins:       (prev.megaWins       || 0) + (extra.megaWin ? 1 : 0),
      superWins:      (prev.superWins      || 0) + (extra.superWin ? 1 : 0),
      totalEvents:    (prev.totalEvents    || 0) + (extra.event ? 1 : 0),
      totalSurprises: (prev.totalSurprises || 0) + (extra.surprise ? 1 : 0),
      biggestWin:     Math.max(prev.biggestWin || 0, extra.won || 0),
    };
    updateCurrentUser({ stats: updated });
  }

  /* ============================================================
     ÁUDIO
     ============================================================ */
  function getAudio() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  function playTick() {
    const ctx = getAudio(); if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.type = "square";
    o.frequency.value = 700 + Math.random() * 500;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.start(t); o.stop(t + 0.06);
  }
  function playWin(small = false) {
    const ctx = getAudio(); if (!ctx) return;
    const notas = small ? [523, 659, 784] : [523, 659, 784, 1047, 1319, 1568];
    notas.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.type = "triangle"; o.frequency.value = f;
      const t = ctx.currentTime + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.start(t); o.stop(t + 0.32);
    });
  }
  function playLose() {
    const ctx = getAudio(); if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.type = "sawtooth";
    o.frequency.setValueAtTime(280, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.4);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.5);
  }
  function playJackpot() {
    const ctx = getAudio(); if (!ctx) return;
    const notas = [392, 523, 659, 784, 1047, 1319, 1568, 2093];
    notas.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.type = "triangle"; o.frequency.value = f;
      const t = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.start(t); o.stop(t + 0.5);
    });
  }
  function playWheelTick() {
    const ctx = getAudio(); if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.type = "square";
    o.frequency.value = 1200 + Math.random() * 400;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.025, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.start(t); o.stop(t + 0.04);
  }

  /* ============================================================
     SVGs
     ============================================================ */
  const SVG = {
    wild:    `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="wildGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffd700"/><stop offset="50%" stop-color="#ff8c00"/><stop offset="100%" stop-color="#d4261a"/></linearGradient></defs><rect x="15" y="20" width="70" height="60" rx="8" fill="url(#wildGrad)" stroke="#6b4f0a" stroke-width="2"/><text x="50" y="62" font-family="Cinzel, serif" font-size="36" font-weight="900" text-anchor="middle" fill="#fff" stroke="#6b4f0a" stroke-width="1">W</text></svg>`,
    crown:   `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="crownGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fff5cc"/><stop offset="35%" stop-color="#ffd700"/><stop offset="100%" stop-color="#b8860b"/></linearGradient></defs><rect x="15" y="72" width="70" height="12" rx="3" fill="url(#crownGold)" stroke="#6b4f0a" stroke-width="1.5"/><path d="M15 72 L25 40 L35 55 L50 25 L65 55 L75 40 L85 72 Z" fill="url(#crownGold)" stroke="#6b4f0a" stroke-width="1.5" stroke-linejoin="round"/><circle cx="25" cy="38" r="4" fill="url(#crownGold)" stroke="#6b4f0a" stroke-width="1"/><circle cx="50" cy="23" r="5" fill="url(#crownGold)" stroke="#6b4f0a" stroke-width="1"/><circle cx="75" cy="38" r="4" fill="url(#crownGold)" stroke="#6b4f0a" stroke-width="1"/><circle cx="35" cy="78" r="3" fill="#ff1744"/><circle cx="50" cy="78" r="4" fill="#ff6b9d"/><circle cx="65" cy="78" r="3" fill="#00b0ff"/></svg>`,
    diamond: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="diamondBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#b3e5fc"/><stop offset="40%" stop-color="#03a9f4"/><stop offset="100%" stop-color="#01579b"/></linearGradient></defs><path d="M50 10 L85 40 L50 90 L15 40 Z" fill="url(#diamondBlue)" stroke="#003d6b" stroke-width="1.5"/><path d="M50 10 L50 90 M15 40 L85 40" stroke="#fff" stroke-width="0.8" opacity="0.5"/><path d="M50 10 L85 40 L50 45 L15 40 Z" fill="#e3f2fd" opacity="0.6"/></svg>`,
    bell:    `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bellGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fff5cc"/><stop offset="40%" stop-color="#ffd700"/><stop offset="100%" stop-color="#b8860b"/></linearGradient></defs><path d="M50 15 Q20 20 20 55 L20 70 L80 70 L80 55 Q80 20 50 15 Z" fill="url(#bellGold)" stroke="#6b4f0a" stroke-width="1.5"/><ellipse cx="50" cy="72" rx="35" ry="6" fill="#b8860b" stroke="#6b4f0a" stroke-width="1.5"/><circle cx="50" cy="82" r="6" fill="#b8860b" stroke="#6b4f0a" stroke-width="1.5"/><circle cx="50" cy="15" r="5" fill="#ffd700" stroke="#6b4f0a" stroke-width="1"/></svg>`,
    seven:   `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sevenRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff5252"/><stop offset="100%" stop-color="#8b0000"/></linearGradient></defs><text x="50" y="78" font-family="Cinzel, serif" font-size="80" font-weight="900" text-anchor="middle" fill="url(#sevenRed)" stroke="#5a0000" stroke-width="2">7</text></svg>`,
    cherry:  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="cherryRed" cx="35%" cy="35%" r="65%"><stop offset="0%" stop-color="#ff5252"/><stop offset="60%" stop-color="#d4261a"/><stop offset="100%" stop-color="#5a0000"/></radialGradient></defs><path d="M50 20 Q48 40 35 55 M50 20 Q52 40 65 55" stroke="#0a5c1a" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="35" cy="68" r="18" fill="url(#cherryRed)" stroke="#5a0000"/><circle cx="65" cy="68" r="18" fill="url(#cherryRed)" stroke="#5a0000"/><ellipse cx="30" cy="62" rx="5" ry="7" fill="#fff" opacity="0.5"/><ellipse cx="60" cy="62" rx="5" ry="7" fill="#fff" opacity="0.5"/></svg>`,
    lemon:   `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="lemonYellow" cx="35%" cy="35%" r="65%"><stop offset="0%" stop-color="#fff59d"/><stop offset="60%" stop-color="#ffeb3b"/><stop offset="100%" stop-color="#9e9d24"/></radialGradient></defs><ellipse cx="50" cy="50" rx="32" ry="38" fill="url(#lemonYellow)" stroke="#6b6b00" stroke-width="1.5"/><ellipse cx="38" cy="38" rx="8" ry="12" fill="#fff" opacity="0.5"/></svg>`,
    orange:  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="orangeOrange" cx="35%" cy="35%" r="65%"><stop offset="0%" stop-color="#ffb74d"/><stop offset="60%" stop-color="#ff6f00"/><stop offset="100%" stop-color="#8b3a00"/></radialGradient></defs><circle cx="50" cy="55" r="35" fill="url(#orangeOrange)" stroke="#5a2200" stroke-width="1.5"/><ellipse cx="38" cy="42" rx="8" ry="12" fill="#fff" opacity="0.4"/><path d="M50 20 Q55 12 60 15 Q58 22 52 22 Z" fill="#4caf50" stroke="#2e5c1a"/></svg>`,
    star:    `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="starGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fff5cc"/><stop offset="50%" stop-color="#ffd700"/><stop offset="100%" stop-color="#b8860b"/></linearGradient></defs><path d="M50 10 L61 40 L92 40 L67 60 L76 90 L50 72 L24 90 L33 60 L8 40 L39 40 Z" fill="url(#starGold)" stroke="#6b4f0a" stroke-width="1.5"/></svg>`,
  };

  /* ============================================================
     UI HELPERS
     ============================================================ */
  function renderBalance(animate = false) {
    const coins = currentUser && typeof currentUser.coins === "number" ? currentUser.coins : 0;
    const el = $("balanceNumber");
    if (el) el.textContent = formatCents(coins);
    if (animate) {
      const wrap = $("balanceValue");
      if (wrap) { wrap.classList.remove("pop"); void wrap.offsetWidth; wrap.classList.add("pop"); }
    }
  }
  function renderBetUI() {
    const display = $("betDisplay");
    if (display) display.textContent = "L$ " + formatCents(currentBetCents);
    const minusBtn = $("betMinus");
    if (minusBtn) minusBtn.disabled = currentBetCents <= GameEngine.MIN_BET || autoSpin.active;
    const plusBtn = $("betPlus");
    if (plusBtn) plusBtn.disabled = autoSpin.active;
  }
  function renderTurboUI() {
    const fab = $("turboFab");
    if (fab) fab.classList.toggle("active", turboActive);
    updateDebugPanel();
  }
  function renderAutoSelectorUI() {
    document.querySelectorAll(".auto-opt").forEach(b => {
      b.classList.toggle("active", Number(b.dataset.rounds) === autoSpin.totalRounds);
      b.disabled = autoSpin.active;
    });
    const selector = $("autoSelector");
    if (selector) selector.classList.toggle("locked", autoSpin.active);
    const title = $("autoProgressTitle");
    if (title) title.textContent = `AUTO-SPIN: ${autoSpin.totalRounds}`;
  }

  function renderPaytable() {
    const listEl = $("paytableList");
    if (!listEl) return;

    const ordered = [...ROLLABLE_SYMBOLS].sort((a, b) => b.pay3 - a.pay3);
    let html = ordered.map(sy => `
      <div class="paytable-row">
        <div class="syms"><span>${symbolHTML(sy)}</span><span>${symbolHTML(sy)}</span><span>${symbolHTML(sy)}</span></div>
        <div class="mult">${sy.pay3}x</div>
      </div>`).join("");

    html += `<div style="height:8px"></div>`;

    const specialRares = ["crown", "seven", "diamond"];
    specialRares.forEach(id => {
      const sym = SYMBOL_TABLE[id];
      if (!sym) return;
      html += `<div class="paytable-row special">
        <div class="syms"><span>${symbolHTML(sym)}</span><span>${symbolHTML(SYMBOL_TABLE.wild)}</span><span>${symbolHTML(sym)}</span></div>
        <div class="mult">${sym.pay3}x</div></div>`;
    });

    listEl.innerHTML = html;

    const badge = $("rtpBadge");
    if (badge) badge.textContent = "RTP " + getTheoreticalRTPPercent().toFixed(1) + "%";
  }

  function updateDebugPanel() {
    if (!debugVisible) return;
    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set("dbgTurbo", turboActive ? "ON" : "off");
    set("dbgAuto", autoSpin.active ? `${autoSpin.currentRound}/${autoSpin.totalRounds}` : "inativo");
    set("dbgCategory", sessionStats.lastCategory);
    set("dbgSpins", formatInt(sessionStats.spins));
    set("dbgWagered", "L$ " + formatCents(sessionStats.wagered));
    set("dbgWon", "L$ " + formatCents(sessionStats.won));
    set("dbgRtp", sessionStats.wagered > 0 ? ((sessionStats.won / sessionStats.wagered) * 100).toFixed(2) + "%" : "—");
    set("dbgHitRate", sessionStats.spins > 0 ? ((sessionStats.hits / sessionStats.spins) * 100).toFixed(1) + "%" : "—");
    set("dbgBiggest", "L$ " + formatCents(sessionStats.biggestWin));
    set("dbgSuper", formatInt(sessionStats.superWins));
    set("dbgEvents", formatInt(sessionStats.events));
  }
  function toggleDebug() {
    debugVisible = !debugVisible;
    const panel = $("debugPanel");
    if (panel) panel.classList.toggle("show", debugVisible);
    if (debugVisible) updateDebugPanel();
  }

  /* ============================================================
     LOCALIZAÇÃO DOS STRIPS
     ------------------------------------------------------------
     No HTML atual, os strips têm IDs: strip0, strip1, strip2.
     Mantemos fallback para classes/data-attrs por segurança.
     ============================================================ */
  function getStrip(colIndex) {
    let el = document.getElementById("strip" + colIndex);
    if (el) return el;
    el = document.querySelector(`[data-strip="${colIndex}"]`);
    if (el) return el;
    const reel = document.querySelector(`.reel[data-reel="${colIndex}"]`);
    if (reel) {
      const s = reel.querySelector(".reel-strip, .strip, [data-strip]");
      if (s) return s;
      if (reel.firstElementChild) return reel.firstElementChild;
    }
    return null;
  }

  /* ============================================================
     ANIMAÇÃO DE REELS
     ============================================================ */
  const STRIP_LENGTH = 20;
  function getSymbolH() {
    const cs = getComputedStyle(document.documentElement);
    return parseFloat(cs.getPropertyValue("--symbol-h")) || 82;
  }
  function buildStripForAnimation(stripEl, finalSymbols) {
    stripEl.innerHTML = "";
    const items = [];
    for (let i = 0; i < STRIP_LENGTH; i++) items.push(GameEngine.rollSymbol());
    items.push(finalSymbols[0], finalSymbols[1], finalSymbols[2]);
    for (let i = 0; i < 3; i++) items.push(GameEngine.rollSymbol());
    for (const sy of items) {
      const el = document.createElement("div");
      el.className = "symbol";
      el.innerHTML = symbolHTML(sy);
      stripEl.appendChild(el);
    }
    stripEl.style.transition = "none";
    stripEl.style.transform = "translateY(0px)";
  }
  function applyGridDirect(grid) {
    for (let c = 0; c < 3; c++) {
      const strip = getStrip(c);
      if (!strip) {
        console.warn("Strip não encontrado para coluna", c);
        continue;
      }
      strip.innerHTML = "";
      strip.style.transition = "none";
      for (let r = 0; r < 3; r++) {
        const el = document.createElement("div");
        el.className = "symbol";
        el.innerHTML = symbolHTML(grid[c][r]);
        strip.appendChild(el);
      }
      strip.style.transform = "translateY(0px)";
    }
  }
  function spinReelToResult(colIndex, finalSymbols, durationMs, useTurbo) {
    return new Promise(resolve => {
      const strip = getStrip(colIndex);
      if (!strip) { resolve(); return; }
      const itemH = getSymbolH();
      buildStripForAnimation(strip, finalSymbols);
      void strip.offsetWidth;
      strip.style.transition = `transform ${durationMs}ms cubic-bezier(0.15, 0.85, 0.35, 1)`;
      const finalOffset = -(STRIP_LENGTH) * itemH;
      strip.style.transform = `translateY(${finalOffset}px)`;
      let ticks = 0;
      const tickMs = useTurbo ? 40 : 70;
      const maxTicks = Math.floor(durationMs / tickMs);
      const tickInterval = setInterval(() => {
        if (ticks++ > maxTicks) { clearInterval(tickInterval); return; }
        playTick();
      }, tickMs);
      const onEnd = () => {
        strip.removeEventListener("transitionend", onEnd);
        clearInterval(tickInterval);
        resolve();
      };
      strip.addEventListener("transitionend", onEnd);
      setTimeout(() => { clearInterval(tickInterval); resolve(); }, durationMs + 200);
    });
  }

  function flashLose() { const el = $("flashLose"); if (!el) return; el.classList.remove("show"); void el.offsetWidth; el.classList.add("show"); }
  function flashWin() { const el = $("flashWin"); if (el) { el.classList.remove("show"); void el.offsetWidth; el.classList.add("show"); } }
  function flashSuper() { const el = $("flashSuper"); if (el) { el.classList.remove("show"); void el.offsetWidth; el.classList.add("show"); } }

  function applyMachineTier(winType) {
    const m = $("machine");
    if (!m) return;
    m.classList.remove("win", "big-win", "super-win");
    void m.offsetWidth;
    const id = winType ? winType.id : "NORMAL";
    if (id === "SUPER" || id === "JACKPOT") m.classList.add("super-win");
    else if (id === "MEGA") m.classList.add("big-win");
    else m.classList.add("win");
  }
  function highlightWinningSymbols(wins, isSuper) {
    const winningCols = new Set();
    (wins || []).forEach(w => w.coords.forEach(([c]) => winningCols.add(c)));
    winningCols.forEach(c => {
      const reel = document.querySelector(`.reel[data-reel="${c}"]`);
      if (reel) { reel.classList.add("win"); if (isSuper) reel.classList.add("super-win"); }
    });
  }
  function clearWinningSymbols() {
    document.querySelectorAll(".reel").forEach(r => r.classList.remove("win", "super-win"));
  }
  function emitGoldParticles(count, origin = { x: 0.5, y: 0.5 }) {
    for (let i = 0; i < count; i++) {
      const p = document.createElement("div");
      p.className = "gold-particle";
      const angle = Math.random() * Math.PI * 2;
      const distance = 80 + Math.random() * 200;
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance;
      p.style.left = (origin.x * window.innerWidth) + "px";
      p.style.top = (origin.y * window.innerHeight) + "px";
      p.style.setProperty("--dx", dx + "px");
      p.style.setProperty("--dy", dy + "px");
      p.style.animationDelay = (Math.random() * 0.3) + "s";
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 3000);
    }
  }
  function emitSoftGlow(isSuper) {
    if (typeof confetti !== "function") return;
    const cores = ["#ffd700", "#f5c542", "#b8860b", "#8a6d1a"];
    if (isSuper) {
      confetti({ particleCount: 60, spread: 100, origin: { y: 0.5 }, colors: cores, scalar: 0.8, gravity: 0.4, drift: 0.2, ticks: 200, shapes: ["circle"], opacity: 0.6 });
    } else {
      confetti({ particleCount: 25, spread: 60, origin: { y: 0.5 }, colors: cores, scalar: 0.7, gravity: 0.4, ticks: 150, shapes: ["circle"], opacity: 0.5 });
    }
  }
  function animatePrizeCounter(finalCents, betCents, winType) {
    return new Promise(resolve => {
      const el = $("winValue");
      if (!el) { resolve(); return; }
      const id = winType ? winType.id : "NORMAL";
      let durationMs;
      if (id === "SUPER" || id === "JACKPOT") durationMs = 2600;
      else if (id === "MEGA") durationMs = 1800;
      else if (id === "BIG") durationMs = 1200;
      else durationMs = 700;
      const start = performance.now();
      const update = (now) => {
        const progress = Math.min((now - start) / durationMs, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const currentCents = Math.floor(finalCents * eased);
        el.textContent = "L$ " + formatCents(currentCents);
        if (progress < 1) requestAnimationFrame(update);
        else { el.textContent = "L$ " + formatCents(finalCents); resolve(); }
      };
      requestAnimationFrame(update);
    });
  }
  async function showWinOverlay(result) {
    return new Promise(async (resolve) => {
      const overlay = $("winOverlay");
      if (!overlay) { resolve(); return; }
      const tierLabel = $("winTierLabel");
      const label = $("winLabel");
      const multEl = $("winMultiplier");
      const valueEl = $("winValue");
      const starsEl = $("winStars");
      const card = $("winCard");
      const cardTier = $("cardTier");
      const cardMult = $("cardMult");
      const cardValue = $("cardValue");
      const cardSymbols = $("cardSymbols");

      const winType = result.winType || WIN_TYPES.NORMAL;
      const isSuper = winType.id === "SUPER" || winType.id === "JACKPOT";
      const totalMult = result.betCents > 0 ? (result.finalWinCents / result.betCents) : 0;
      const totalMultLabel = totalMult >= 1 ? Math.round(totalMult) : totalMult.toFixed(1);

      if (label) { label.className = "win-label"; label.textContent = winType.label; }
      if (tierLabel) tierLabel.textContent = winType.tierLabel || "";
      if (multEl) { multEl.textContent = ""; multEl.style.display = "none"; }
      if (valueEl) valueEl.textContent = "L$ 0,00";
      if (starsEl) starsEl.textContent = isSuper ? "★ ✦ ★ ✦ ★ ✦ ★" : "★ ★ ★ ★ ★";
      if (card) card.classList.remove("show");

      if (label) {
        if (winType.id === "BIG") label.classList.add("big");
        else if (winType.id === "MEGA") label.classList.add("mega");
        else if (isSuper) label.classList.add("super");
      }
      if (isSuper) {
        document.body.classList.add("dimmed");
        setTimeout(() => document.body.classList.remove("dimmed"), 2600);
      }
      overlay.classList.add("show");
      await new Promise(r => setTimeout(r, 500));
      if (winType.id !== "NORMAL" && multEl) {
        multEl.textContent = "×" + totalMultLabel;
        multEl.style.display = "block";
        await new Promise(r => setTimeout(r, 700));
      }
      await animatePrizeCounter(result.finalWinCents, result.betCents, winType);
      if (card) {
        if (cardTier) cardTier.textContent = winType.label;
        if (cardMult) cardMult.textContent = "×" + totalMultLabel;
        if (cardValue) cardValue.textContent = "L$ " + formatCents(result.finalWinCents);
        if (cardSymbols) {
          const winningSymbols = result.wins && result.wins.length > 0
            ? result.wins[0].rawSymbols.map(id => resolveSymbol(id)).filter(Boolean)
            : [];
          cardSymbols.innerHTML = winningSymbols.map(s => `<span>${symbolHTML(s)}</span>`).join("");
        }
        card.classList.add("show");
        await new Promise(r => setTimeout(r, isSuper ? 2000 : 1200));
      }
      overlay.classList.remove("show");
      if (label) label.classList.remove("big", "mega", "super");
      if (card) card.classList.remove("show");
      resolve();
    });
  }
  function drawPaylines(wins) {
    const svg = $("paylineSvg");
    const overlay = $("paylineOverlay");
    if (!svg || !overlay) return;
    svg.innerHTML = "";
    const cores = ["#ffd700", "#22c55e", "#38bdf8", "#ec4899", "#f97316"];
    (wins || []).forEach((w, i) => {
      const line = PAYLINES[w.line];
      if (!line) return;
      const [x1, y1, x2, y2] = line.svg;
      const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
      lineEl.setAttribute("x1", x1); lineEl.setAttribute("y1", y1);
      lineEl.setAttribute("x2", x2); lineEl.setAttribute("y2", y2);
      lineEl.setAttribute("stroke", cores[i % cores.length]);
      lineEl.setAttribute("stroke-width", "1");
      lineEl.setAttribute("stroke-linecap", "round");
      lineEl.setAttribute("vector-effect", "non-scaling-stroke");
      lineEl.style.filter = `drop-shadow(0 0 6px ${cores[i % cores.length]})`;
      lineEl.style.strokeDasharray = "200";
      lineEl.style.strokeDashoffset = "200";
      svg.appendChild(lineEl);
      requestAnimationFrame(() => {
        lineEl.style.transition = "stroke-dashoffset 0.6s ease-out";
        lineEl.style.strokeDashoffset = "0";
      });
    });
    overlay.classList.add("show");
  }
  function clearPaylines() {
    const svg = $("paylineSvg");
    const overlay = $("paylineOverlay");
    if (svg) svg.innerHTML = "";
    if (overlay) overlay.classList.remove("show");
  }

  /* ============================================================
     BOTÕES
     ============================================================ */
  function getAutoBtn() { return document.getElementById("autoBtn"); }
  function getSpinBtn() { return document.getElementById("spinBtn"); }
  function getTurboFab() { return document.getElementById("turboFab"); }

  function setSpinBtnDisabled(disabled) {
    const btn = getSpinBtn();
    if (!btn) return;
    btn.disabled = disabled;
    btn.style.opacity = disabled ? "0.5" : "1";
    btn.style.cursor = disabled ? "not-allowed" : "pointer";
  }
  function setAutoBtnIdle() {
    const btn = getAutoBtn();
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove("running");
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
    btn.innerHTML = '<i class="fa-solid fa-repeat"></i>&nbsp; Auto';
  }
  function setAutoBtnRunning() {
    const btn = getAutoBtn();
    if (!btn) return;
    btn.disabled = false;
    btn.classList.add("running");
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
    btn.innerHTML = '<i class="fa-solid fa-stop"></i>&nbsp; Cancelar';
  }

  /* ============================================================
     EVENTO ESPECIAL
     ============================================================ */
  function getEventProgress() {
    if (!currentUser) return 0;
    if (typeof currentUser.eventProgress !== "number") return 0;
    return currentUser.eventProgress;
  }
  function setEventProgress(v) { updateCurrentUser({ eventProgress: v }); }
  function addEventProgress(betCents) {
    const inc = betCents * EVENT_CONFIG.progressPerCent;
    const prog = Math.min(EVENT_CONFIG.threshold, getEventProgress() + inc);
    setEventProgress(prog);
    updateDebugPanel();
  }
  function isEventReady() {
    return getEventProgress() >= EVENT_CONFIG.threshold && currentEventState === EVENT_STATES.LOCKED;
  }

  async function triggerSpecialEvent() {
    if (currentState !== GAME_STATES.IDLE) return;
    setEventState(EVENT_STATES.READY);
    setState(GAME_STATES.EVENT);

    setSpinBtnDisabled(true);
    const autoBtn = getAutoBtn();
    if (autoBtn) autoBtn.disabled = true;
    const fab = getTurboFab();
    if (fab) fab.disabled = true;
    const minus = $("betMinus"); const plus = $("betPlus");
    if (minus) minus.disabled = true;
    if (plus) plus.disabled = true;
    renderAutoSelectorUI();

    buildEventWheel();

    const overlay = $("eventOverlay");
    const badge = $("eventBadge");
    const prizeLabel = $("eventPrizeLabel");
    const prizeMult = $("eventPrizeMult");
    const prizeValue = $("eventPrizeValue");
    const stars = overlay ? overlay.querySelector(".event-stars") : null;
    const inner = $("eventWheelInner");

    if (!overlay || !inner) { setState(GAME_STATES.IDLE); return; }

    if (badge) badge.textContent = "EVENTO DESBLOQUEADO";
    if (prizeLabel) { prizeLabel.textContent = ""; prizeLabel.classList.remove("reveal"); }
    if (prizeMult) { prizeMult.textContent = ""; prizeMult.classList.remove("reveal"); }
    if (prizeValue) { prizeValue.textContent = "L$ 0,00"; prizeValue.classList.remove("reveal"); }
    if (stars) stars.classList.remove("reveal");

    overlay.classList.add("show");
    setEventState(EVENT_STATES.SPINNING);
    vibrate([60, 30, 60, 30, 120]);
    playJackpot();

    const prizeSeg = GameEngine.spinEventWheel();
    const prizeCents = Math.floor(currentBetCents * prizeSeg.mult);
    const segCount = EVENT_CONFIG.segments.length;
    const segIndex = EVENT_CONFIG.segments.indexOf(prizeSeg);
    const segAngle = 360 / segCount;

    const totalRotation = 360 * (5 + Math.random() * 3);
    const targetRotation = totalRotation + (360 - segIndex * segAngle - segAngle / 2);

    inner.style.transition = "none";
    inner.style.transform = "rotate(0deg)";
    void inner.offsetWidth;
    inner.style.transition = "transform 4200ms cubic-bezier(0.17, 0.67, 0.28, 1)";
    inner.style.transform = `rotate(${targetRotation}deg)`;

    const tickInterval = setInterval(() => playWheelTick(), 90);
    await new Promise(r => setTimeout(r, 4300));
    clearInterval(tickInterval);

    inner.style.transition = "transform 260ms ease-in-out";
    inner.style.transform = `rotate(${targetRotation + 2}deg)`;
    await new Promise(r => setTimeout(r, 280));
    inner.style.transform = `rotate(${targetRotation}deg)`;
    await new Promise(r => setTimeout(r, 300));

    setEventState(EVENT_STATES.STOPPING);
    setEventState(EVENT_STATES.REVEAL);

    if (badge) badge.textContent = "EVENTO";
    if (prizeLabel) { prizeLabel.textContent = "BÔNUS"; prizeLabel.classList.add("reveal"); }
    await new Promise(r => setTimeout(r, 300));
    if (prizeMult) { prizeMult.textContent = prizeSeg.label; prizeMult.classList.add("reveal"); }
    playWin(false);
    emitGoldParticles(80, { x: 0.5, y: 0.4 });
    emitSoftGlow(true);

    await new Promise(resolve => {
      const el = prizeValue;
      if (!el) { resolve(); return; }
      const start = performance.now();
      const duration = 1600;
      const update = (now) => {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = "L$ " + formatCents(Math.floor(prizeCents * eased));
        if (p < 1) requestAnimationFrame(update);
        else { el.textContent = "L$ " + formatCents(prizeCents); resolve(); }
      };
      el.classList.add("reveal");
      requestAnimationFrame(update);
    });

    if (stars) stars.classList.add("reveal");
    vibrate([80, 40, 80, 40, 150]);

    if (prizeCents > 0) {
      updateCurrentUser({ coins: currentUser.coins + prizeCents });
      renderBalance(true);
    }
    sessionStats.events++;
    persistUserStats({ event: true });
    addHistory({
      type: "event", game: "Tigrinho", bet: currentBetCents, win: prizeCents,
      mult: prizeSeg.mult, label: prizeSeg.label, saldo: currentUser.coins, ts: Date.now(),
    });

    await new Promise(r => setTimeout(r, 2200));

    setEventState(EVENT_STATES.FINISHED);
    overlay.classList.remove("show");

    setEventProgress(0);
    setEventState(EVENT_STATES.LOCKED);
    setState(GAME_STATES.IDLE);

    setSpinBtnDisabled(false);
    if (autoBtn) autoBtn.disabled = false;
    if (fab) fab.disabled = false;
    if (minus) minus.disabled = currentBetCents <= GameEngine.MIN_BET;
    if (plus) plus.disabled = false;
    renderAutoSelectorUI();

    toast(`Bônus: +L$ ${formatCents(prizeCents)} (${prizeSeg.label})`);
  }

  function buildEventWheel() {
    const inner = $("eventWheelInner");
    if (!inner) return;
    const segCount = EVENT_CONFIG.segments.length;
    const segAngle = 360 / segCount;
    const colors = ["#2a0a12", "#1a0a05", "#2a0a12", "#1a0a05", "#2a0a12", "#1a0a05", "#2a0a12", "#1a0a05", "#2a0a12"];
    let html = "";
    for (let i = 0; i < segCount; i++) {
      const startA = i * segAngle;
      const endA = (i + 1) * segAngle;
      const seg = EVENT_CONFIG.segments[i];
      const isHigh = seg.kind === "jackpot";
      const fill = isHigh ? "#3a1a05" : colors[i % colors.length];
      const rad = (a) => (a - 90) * Math.PI / 180;
      const x1 = 50 + 50 * Math.cos(rad(startA));
      const y1 = 50 + 50 * Math.sin(rad(startA));
      const x2 = 50 + 50 * Math.cos(rad(endA));
      const y2 = 50 + 50 * Math.sin(rad(endA));
      const large = segAngle > 180 ? 1 : 0;
      const midA = startA + segAngle / 2;
      const tx = 50 + 30 * Math.cos(rad(midA));
      const ty = 50 + 30 * Math.sin(rad(midA));
      html += `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;">
        <path d="M50 50 L ${x1} ${y1} A 50 50 0 ${large} 1 ${x2} ${y2} Z" fill="${fill}" stroke="rgba(255,215,0,0.35)" stroke-width="0.4"/>
        <text x="${tx}" y="${ty}" font-family="Cinzel, serif" font-size="7" font-weight="900"
          fill="${isHigh ? '#ffd700' : 'rgba(255,215,0,0.8)'}" text-anchor="middle" dominant-baseline="middle"
          transform="rotate(${midA} ${tx} ${ty})">${seg.label}</text>
      </svg>`;
    }
    inner.innerHTML = html;
  }

  /* ============================================================
     FLUXO PRINCIPAL DO GIRO
     ============================================================ */
  async function executeSpin() {
    if (currentState !== GAME_STATES.IDLE) return { error: "state" };
    if (!currentUser || typeof currentUser.coins !== "number") return { error: "user" };
    if (currentUser.coins < currentBetCents) return { error: "saldo" };

    const useTurbo = autoSpin.active ? autoSpin.roundTurboSnapshot : turboActive;

    setState(GAME_STATES.SPINNING);

    updateCurrentUser({ coins: currentUser.coins - currentBetCents });
    renderBalance(true);

    sessionStats.spins++;
    sessionStats.wagered += currentBetCents;
    updateDebugPanel();

    addEventProgress(currentBetCents);

    const result = GameEngine.play(currentBetCents, currentMode);
    sessionStats.lastCategory = result.category;

    const mode = MODES[currentMode] || MODES.normal;
    let durations = mode.spinDurations;
    if (useTurbo) durations = durations.map(d => Math.max(120, Math.floor(d * 0.35)));

    const promises = [];
    for (let c = 0; c < 3; c++) {
      const finalSyms = [result.grid[c][0], result.grid[c][1], result.grid[c][2]];
      const delay = c * (useTurbo ? 40 : 150);
      promises.push(new Promise(resolve => {
        setTimeout(() => {
          spinReelToResult(c, finalSyms, durations[c], useTurbo).then(resolve);
        }, delay);
      }));
    }
    await Promise.all(promises);

    setState(GAME_STATES.RESULT);

    if (result.finalWinCents > 0) {
      const winType = result.winType || WIN_TYPES.NORMAL;
      const isSuper = winType.id === "SUPER" || winType.id === "JACKPOT";

      updateCurrentUser({ coins: currentUser.coins + result.finalWinCents });
      sessionStats.won += result.finalWinCents;
      sessionStats.hits++;
      sessionStats.biggestWin = Math.max(sessionStats.biggestWin, result.finalWinCents);
      if (isSuper) sessionStats.superWins++;

      renderBalance(true);
      updateDebugPanel();

      highlightWinningSymbols(result.wins, isSuper);
      drawPaylines(result.wins);
      applyMachineTier(winType);

      if (isSuper) {
        flashSuper();
        emitGoldParticles(winType.particleCount, { x: 0.5, y: 0.4 });
        emitSoftGlow(true);
        playJackpot();
        vibrate([80, 40, 80, 40, 150, 40, 80]);
      } else {
        flashWin();
        emitGoldParticles(winType.particleCount, { x: 0.5, y: 0.5 });
        emitSoftGlow(false);
        if (winType.id === "MEGA") {
          playJackpot();
          vibrate([60, 40, 80, 40, 100]);
        } else {
          playWin(result.finalWinCents < currentBetCents * 3);
          vibrate([40, 30, 50]);
        }
      }

      const lr = $("lastResult");
      if (lr) {
        if (winType.id === "NORMAL") {
          lr.textContent = `🎉 +L$ ${formatCents(result.finalWinCents)}`;
          lr.className = "last-result win";
        } else {
          lr.textContent = `${winType.label} · +L$ ${formatCents(result.finalWinCents)}`;
          lr.className = "last-result super-win";
        }
      }

      setState(isSuper ? GAME_STATES.SUPER_WIN : GAME_STATES.WIN);
      await showWinOverlay(result);

      addHistory({
        type: "spin", game: "Tigrinho", bet: currentBetCents, win: result.finalWinCents,
        mult: result.finalWinCents / currentBetCents, winType: winType.id,
        category: result.category,
        surprise: result.surpriseMult || null,
        linePayout: result.linePayoutCents || 0,
        eventBonus: result.eventBonusCents || 0,
        wheelMult: result.eventWheelResult ? result.eventWheelResult.mult : null,
        saldo: currentUser.coins, ts: Date.now(), mode: currentMode,
      });

      persistUserStats({
        hit: true,
        wagered: currentBetCents,
        won: result.finalWinCents,
        bigWin: winType.id === "BIG",
        megaWin: winType.id === "MEGA",
        superWin: isSuper,
        surprise: !!result.surpriseMult,
      });

      setTimeout(() => {
        clearWinningSymbols();
        clearPaylines();
        const m = $("machine");
        if (m) m.classList.remove("win", "big-win", "super-win");
        const lr2 = $("lastResult");
        if (lr2) {
          lr2.textContent = "Aposte e gire para começar";
          lr2.className = "last-result";
        }
      }, 1500);

    } else {
      flashLose();
      playLose();
      vibrate(30);
      const lr = $("lastResult");
      if (lr) { lr.textContent = "Tente novamente 😉"; lr.className = "last-result"; }

      addHistory({
        type: "spin", game: "Tigrinho", bet: currentBetCents, win: 0,
        mult: 0, winType: "LOSS", category: result.category,
        saldo: currentUser.coins, ts: Date.now(), mode: currentMode,
      });

      persistUserStats({
        hit: false,
        wagered: currentBetCents,
        won: 0,
      });
    }

    setState(GAME_STATES.IDLE);

    const finalWinType = result.winType || WIN_TYPES.NORMAL;
    return {
      totalWin: result.finalWinCents,
      wins: result.wins,
      grid: result.grid,
      bet: currentBetCents,
      winType: finalWinType,
      category: result.category,
      linePayoutCents: result.linePayoutCents || 0,
      eventBonusCents: result.eventBonusCents || 0,
      eventWheelResult: result.eventWheelResult || null,
      superWin: (finalWinType.id === "SUPER" || finalWinType.id === "JACKPOT") ? result.finalWinCents : 0,
      eventReady: isEventReady(),
    };
  }

  /* ============================================================
     GIRO MANUAL
     ============================================================ */
  async function spin() {
    if (currentState !== GAME_STATES.IDLE) return;
    if (autoSpin.active) return;
    if (!currentUser || currentUser.coins < currentBetCents) {
      vibrate([40, 40, 40]);
      toast("L$ insuficientes", "error");
      const el = $("balanceValue");
      if (el) { el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake"); }
      return;
    }

    setSpinBtnDisabled(true);
    const autoBtn = getAutoBtn();
    if (autoBtn) autoBtn.disabled = true;

    const lr = $("lastResult");
    if (lr) { lr.className = "last-result"; lr.textContent = ""; }

    const result = await executeSpin();

    setSpinBtnDisabled(false);
    setAutoBtnIdle();

    if (result && result.error === "saldo") toast("L$ insuficientes", "error");
    else if (result && result.totalWin > 0) toast(`+L$ ${formatCents(result.totalWin)}`);

    if (isEventReady()) await triggerSpecialEvent();
  }

  /* ============================================================
     AUTO-SPIN
     ============================================================ */
  async function handleAutoBtn() {
    if (autoSpin.active) {
      autoSpin.cancelRequested = true;
      toast("Cancelando...", "error");
      vibrate(20);
      return;
    }
    await startAutoSpin();
  }

  async function startAutoSpin() {
    if (autoSpin.active || currentState !== GAME_STATES.IDLE) return;
    if (!currentUser || currentUser.coins < currentBetCents) {
      toast("L$ insuficientes", "error");
      return;
    }

    autoSpin.active = true;
    autoSpin.currentRound = 0;
    autoSpin.cancelRequested = false;
    autoSpin.results = [];
    autoSpin.turbo = turboActive;

    setSpinBtnDisabled(true);
    setAutoBtnRunning();
    renderAutoSelectorUI();
    renderBetUI();

    const progressEl = $("autoProgress");
    const historyCardEl = $("autoHistoryCard");
    const historyListEl = $("autoHistoryList");
    const summaryEl = $("autoSummary");

    if (progressEl) progressEl.classList.add("show");
    if (historyCardEl) historyCardEl.classList.add("show");
    if (historyListEl) historyListEl.innerHTML = "";
    if (summaryEl) summaryEl.textContent = "";
    updateAutoProgress();

    for (let i = 0; i < autoSpin.totalRounds; i++) {
      if (autoSpin.cancelRequested) break;
      if (!currentUser || currentUser.coins < currentBetCents) {
        toast("Saldo insuficiente, parando", "error");
        break;
      }

      autoSpin.turbo = turboActive;
      autoSpin.roundTurboSnapshot = turboActive;

      const result = await executeSpin();
      if (!result || result.error) break;

      autoSpin.currentRound = i + 1;
      autoSpin.results.push(result);
      updateAutoProgress();
      renderAutoChip(result, i);

      if (result.eventReady) {
        autoSpin.cancelRequested = true;
        break;
      }
      if (autoSpin.cancelRequested) break;

      await new Promise(r => setTimeout(r, turboActive ? 100 : 300));
    }

    finishAutoSpin();

    if (isEventReady()) await triggerSpecialEvent();
  }

  function updateAutoProgress() {
    const fill = $("autoProgressFill");
    const counter = $("autoCounter");
    const title = $("autoProgressTitle");
    const done = autoSpin.currentRound;
    const total = autoSpin.totalRounds;
    if (fill) fill.style.width = ((done / total) * 100) + "%";
    if (counter) counter.textContent = `${done} / ${total}`;
    if (title) title.textContent = `AUTO-SPIN: ${total}`;
  }

  function renderAutoChip(result, index) {
    const listEl = $("autoHistoryList");
    if (!listEl) return;
    const chip = document.createElement("div");
    chip.className = "auto-chip";
    if (!result || result.totalWin === 0) {
      chip.classList.add("loss");
      chip.textContent = `${index + 1}º —`;
    } else {
      const wt = result.winType || WIN_TYPES.NORMAL;
      if (wt.id === "SUPER" || wt.id === "JACKPOT") {
        chip.classList.add("super");
        chip.textContent = `${index + 1}º ${wt.label} +${formatCents(result.totalWin)}`;
      } else if (wt.id === "MEGA" || wt.id === "BIG") {
        chip.classList.add("big");
        chip.textContent = `${index + 1}º ${wt.label} +${formatCents(result.totalWin)}`;
      } else {
        chip.classList.add("win");
        chip.textContent = `${index + 1}º +${formatCents(result.totalWin)}`;
      }
    }
    listEl.appendChild(chip);
  }

  function finishAutoSpin() {
    const cancelled = autoSpin.cancelRequested;
    const roundsPlayed = autoSpin.results.length;
    const total = autoSpin.totalRounds;

    autoSpin.active = false;
    autoSpin.cancelRequested = false;

    setSpinBtnDisabled(false);
    setAutoBtnIdle();
    renderAutoSelectorUI();
    renderBetUI();

    const totalWin = autoSpin.results.reduce((s, r) => s + r.totalWin, 0);
    const totalBet = roundsPlayed * currentBetCents;
    const profit = totalWin - totalBet;
    const wins = autoSpin.results.filter(r => r.totalWin > 0).length;

    const summaryEl = $("autoSummary");
    if (summaryEl) {
      summaryEl.textContent =
        `${roundsPlayed}/${total} giros · ${wins}V · ${profit >= 0 ? "+" : ""}L$ ${formatCents(profit)}`;
    }

    if (cancelled && roundsPlayed < total) {
      toast(`Auto-spin cancelado (${roundsPlayed}/${total})`, "error");
    } else {
      toast(`Auto-spin: ${profit >= 0 ? "+" : ""}L$ ${formatCents(profit)}`, profit >= 0 ? "success" : "error");
    }

    setTimeout(() => {
      if (!autoSpin.active) {
        const p = $("autoProgress");
        if (p) p.classList.remove("show");
      }
    }, 2000);

    updateDebugPanel();
  }

  /* ============================================================
     MODAIS
     ============================================================ */
  function openModal(id) { const el = $(id); if (el) el.classList.add("show"); }
  function closeModal(id) { const el = $(id); if (el) el.classList.remove("show"); }

  function openInfo() {
    const body = $("infoModalBody");
    if (!body) return;
    const rtp = getTheoreticalRTPPercent();
    body.innerHTML = `
      <div class="stat-card">
        <div class="row"><span>RTP teórico</span><span>${rtp.toFixed(2)}%</span></div>
        <div class="row"><span>Volatilidade</span><span>Média</span></div>
        <div class="row"><span>Linhas</span><span>${NUM_LINES}</span></div>
      </div>
      <div class="stat-card">
        <div class="row"><span>Categorias de resultado</span><span></span></div>
        <div class="row"><span>Sem prêmio</span><span>${(OUTCOME_CATEGORIES.NO_WIN.chance * 100).toFixed(0)}%</span></div>
        <div class="row"><span>Ganho pequeno</span><span>${(OUTCOME_CATEGORIES.SMALL_WIN.chance * 100).toFixed(0)}%</span></div>
        <div class="row"><span>Ganho médio</span><span>${(OUTCOME_CATEGORIES.MEDIUM_WIN.chance * 100).toFixed(0)}%</span></div>
        <div class="row"><span>Ganho grande</span><span>${(OUTCOME_CATEGORIES.BIG_WIN.chance * 100).toFixed(0)}%</span></div>
        <div class="row"><span>Evento especial</span><span>${(OUTCOME_CATEGORIES.SPECIAL_EVENT.chance * 100).toFixed(0)}%</span></div>
      </div>
      <div class="stat-card">
        <div class="row"><span>Sessão atual</span><span></span></div>
        <div class="row"><span>Giros</span><span>${formatInt(sessionStats.spins)}</span></div>
        <div class="row"><span>Apostado</span><span>L$ ${formatCents(sessionStats.wagered)}</span></div>
        <div class="row"><span>Ganho</span><span>L$ ${formatCents(sessionStats.won)}</span></div>
        <div class="row"><span>RTP real</span><span>${sessionStats.wagered > 0 ? ((sessionStats.won / sessionStats.wagered) * 100).toFixed(2) + "%" : "—"}</span></div>
        <div class="row"><span>Taxa acerto</span><span>${sessionStats.spins > 0 ? ((sessionStats.hits / sessionStats.spins) * 100).toFixed(1) + "%" : "—"}</span></div>
        <div class="row"><span>Maior prêmio</span><span>L$ ${formatCents(sessionStats.biggestWin)}</span></div>
      </div>
      <div class="stat-card">
        <div class="row"><span>Auto-Spin</span><span>${autoSpin.active ? `${autoSpin.currentRound}/${autoSpin.totalRounds}` : "inativo"}</span></div>
        <div class="row"><span>Turbo</span><span>${turboActive ? "ATIVO" : "inativo"}</span></div>
        <div class="row"><span>Opções</span><span>${AUTO_SPIN_OPTIONS.join(" · ")}</span></div>
      </div>
    `;
    openModal("infoModal");
  }

  function openPaytableModal() {
    const body = $("paytableModalBody");
    if (!body) return;
    const rtp = getTheoreticalRTPPercent();
    body.innerHTML = `
      <div class="stat-card">
        <div class="row"><span>RTP teórico</span><span>${rtp.toFixed(2)}%</span></div>
        <div class="row"><span>Volatilidade</span><span>Média</span></div>
        <div class="row"><span>Linhas</span><span>${NUM_LINES}</span></div>
      </div>
      <div class="stat-card">
        <div class="row"><span>Pesos por símbolo</span><span></span></div>
        ${ROLLABLE_SYMBOLS.slice().sort((a,b) => b.weight - a.weight).map(sy => `
          <div class="row"><span>${sy.id}</span><span>${(sy.weight / TOTAL_WEIGHT * 100).toFixed(2)}%</span></div>
        `).join("")}
        <div class="row"><span>wild (coringa)</span><span>2.00%</span></div>
      </div>
      <div class="stat-card">
        <div class="row"><span>3 iguais (× aposta/linha)</span><span></span></div>
        ${ROLLABLE_SYMBOLS.slice().sort((a,b) => b.pay3 - a.pay3).map(sy => `
          <div class="row"><span>${sy.id}</span><span>${sy.pay3}x</span></div>
        `).join("")}
      </div>
      <div class="stat-card">
        <div class="row"><span>Linha especial (raro + wild + raro)</span><span></span></div>
        <div class="row"><span>crown + wild + crown</span><span>${SYMBOL_TABLE.crown.pay3}x</span></div>
        <div class="row"><span>seven + wild + seven</span><span>${SYMBOL_TABLE.seven.pay3}x</span></div>
        <div class="row"><span>diamond + wild + diamond</span><span>${SYMBOL_TABLE.diamond.pay3}x</span></div>
      </div>
      <div class="stat-card">
        <div class="row"><span>Categorias de resultado</span><span></span></div>
        ${CATEGORY_ORDER.map(k => {
          const cat = OUTCOME_CATEGORIES[k];
          return `<div class="row"><span>${cat.label}</span><span>${(cat.chance * 100).toFixed(0)}%</span></div>`;
        }).join("")}
      </div>
      <div class="stat-card">
        <div class="row"><span>Evento especial (roleta)</span><span></span></div>
        <div class="row"><span>Critério</span><span>L$ ${formatInt(EVENT_CONFIG.threshold / 100)} apostados</span></div>
        ${EVENT_CONFIG.segments.map(s => `
          <div class="row"><span>${s.label} (${s.kind})</span><span>peso ${s.weight}</span></div>
        `).join("")}
      </div>
      <div class="stat-card">
        <div class="row"><span>Hierarquia de vitórias</span><span></span></div>
        ${Object.values(WIN_TYPES).map(t => `
          <div class="row"><span>${t.label}</span><span>${t.minMult}x+</span></div>
        `).join("")}
      </div>
    `;
    openModal("paytableModal");
  }

  /* ============================================================
     NAVEGAÇÃO
     ============================================================ */
  function goHome() { vibrate(10); safeRedirect("home.html"); }
  function goHistory() { vibrate(10); safeRedirect("home.html#historico"); }
  function goToBonus() { vibrate(10); safeRedirect("regatebonus.html"); }

  /* ============================================================
     INIT
     ------------------------------------------------------------
     REGRA DE OURO:
     - Se houver sessão VÁLIDA → usa o usuário.
     - Se NÃO houver sessão:
         * se estamos numa página que NÃO é a do login (ex.: jogo.html),
           redireciona UMA vez para index.html e aborta.
         * se JÁ estamos na index.html (a própria página do jogo),
           cria um CONVIDADO temporário em memória e segue o jogo.
     Assim nunca há loop e nunca há tela morta.
     ============================================================ */
  function boot() {
    const sessionId = getSession();
    let user = null;

    if (sessionId) {
      const users = getUsers();
      user = users.find(u => u.id === sessionId) || null;
      if (!user) {
        // Sessão apontando para usuário inexistente — limpa.
        clearSession();
      }
    }

    if (!user) {
      // Sem sessão válida. Decide entre redirecionar ou criar convidado.
      const here = currentFileName();
      const loginPage = "index.html";
      const isLoginPage = (here === "" || here === loginPage);

      if (!isLoginPage) {
        // Estamos numa página que não é o login → manda para o login.
        if (safeRedirect(loginPage)) return;
        // Se safeRedirect não disparou (loop evitado), segue com convidado.
      }

      // Fallback: convidado temporário em memória (não persiste em localStorage).
      user = {
        id: "guest_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        username: "Convidado",
        guest: true,
        coins: 1000,
        stats: {},
        eventProgress: 0,
        createdAt: Date.now(),
      };
      currentUser = user;
      console.warn("[script.js] Sessão ausente — rodando como convidado temporário.");
    } else {
      currentUser = user;
      if (typeof currentUser.coins !== "number") {
        currentUser.coins = 1000;
        updateCurrentUser({ coins: 1000 });
      }
      if (typeof currentUser.eventProgress !== "number") {
        updateCurrentUser({ eventProgress: 0 });
      }
      if (!currentUser.stats) updateCurrentUser({ stats: {} });
    }

    // A partir daqui SEMPRE temos currentUser.
    renderBalance();
    renderBetUI();
    renderTurboUI();
    renderAutoSelectorUI();
    renderPaytable();

    // Símbolos iniciais via ID (compatível com v3)
    const initialGrid = [
      [resolveSymbol("crown"), resolveSymbol("bell"),  resolveSymbol("cherry")],
      [resolveSymbol("crown"), resolveSymbol("lemon"), resolveSymbol("orange")],
      [resolveSymbol("crown"), resolveSymbol("star"),  resolveSymbol("seven")],
    ].map(col => col.map(s => s || resolveSymbol("cherry")));

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        applyGridDirect(initialGrid);

        setTimeout(() => {
          for (let c = 0; c < 3; c++) {
            document.querySelector(`.reel[data-reel="${c}"]`)?.classList.add("win");
          }
          drawPaylines([{ line: 0, coords: [[0,0],[1,0],[2,0]] }]);
          flashWin();
          playJackpot();
          emitSoftGlow(true);
          emitGoldParticles(60, { x: 0.5, y: 0.4 });
          vibrate([80, 40, 80, 40, 150]);

          const lr = $("lastResult");
          if (lr) { lr.textContent = `🎉 Bem-vindo! Boa sorte!`; lr.className = "last-result win"; }

          setTimeout(() => {
            clearWinningSymbols();
            clearPaylines();
            const lr2 = $("lastResult");
            if (lr2) { lr2.textContent = "Aposte e gire para começar"; lr2.className = "last-result"; }
          }, 3000);
        }, 700);
      });
    });

    const betMinus = $("betMinus");
    const betPlus = $("betPlus");
    if (betMinus) {
      betMinus.addEventListener("click", () => {
        if (currentState !== GAME_STATES.IDLE || autoSpin.active) return;
        currentBetCents = GameEngine.stepBet(currentBetCents, -1);
        renderBetUI();
        vibrate(8);
      });
    }
    if (betPlus) {
      betPlus.addEventListener("click", () => {
        if (currentState !== GAME_STATES.IDLE || autoSpin.active) return;
        currentBetCents = GameEngine.stepBet(currentBetCents, +1);
        renderBetUI();
        vibrate(8);
      });
    }

    document.querySelectorAll(".auto-opt").forEach(btn => {
      btn.addEventListener("click", () => {
        if (autoSpin.active) return;
        const rounds = Number(btn.dataset.rounds);
        if (!AUTO_SPIN_OPTIONS.includes(rounds)) return;
        autoSpin.totalRounds = rounds;
        renderAutoSelectorUI();
        updateAutoProgress();
        vibrate(8);
      });
    });

    const turboFab = getTurboFab();
    if (turboFab) {
      turboFab.addEventListener("click", () => {
        if (currentState === GAME_STATES.EVENT) return;
        turboActive = !turboActive;
        autoSpin.turbo = turboActive;
        renderTurboUI();
        vibrate(12);
        if (!autoSpin.active) {
          toast(turboActive ? "Modo Raio ativado" : "Modo Raio desativado");
        } else {
          toast(turboActive ? "Raio ON · próxima rodada" : "Raio OFF · próxima rodada");
        }
      });
    }

    const spinBtnEl = getSpinBtn();
    const autoBtnEl = getAutoBtn();
    if (spinBtnEl) spinBtnEl.addEventListener("click", spin);
    if (autoBtnEl) autoBtnEl.addEventListener("click", handleAutoBtn);

    document.querySelectorAll(".modal-backdrop").forEach(bd => {
      bd.addEventListener("click", (e) => {
        if (e.target === bd) bd.classList.remove("show");
      });
    });

    const markGesture = () => {
      userGestureReceived = true;
      document.removeEventListener("touchstart", markGesture);
      document.removeEventListener("click", markGesture);
      setTimeout(() => getAudio(), 100);
    };
    document.addEventListener("touchstart", markGesture, { once: true });
    document.addEventListener("click", markGesture, { once: true });

    const rtp = getTheoreticalRTPPercent();
    console.log("%c🎰 Tigrinho · Módulos carregados (v3)", "color:#ffd700;font-size:16px;font-weight:900;");
    console.log("Motor:", "regrasdeganhos.js v3.2");
    console.log("UI:", "script.js");
    console.log("Usuário:", currentUser.username, currentUser.guest ? "(convidado)" : "", "| L$:", currentUser.coins);
    console.log("RTP teórico:", rtp.toFixed(2) + "%");
    console.log("Categorias:", CATEGORY_ORDER.map(k => `${k} ${(OUTCOME_CATEGORIES[k].chance*100).toFixed(0)}%`).join(" · "));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  /* ============================================================
     EXPORTAÇÃO PARA O HTML (onclick="...")
     ============================================================ */
  window.goHome = goHome;
  window.goHistory = goHistory;
  window.goToBonus = goToBonus;
  window.openInfo = openInfo;
  window.openPaytableModal = openPaytableModal;
  window.closeModal = closeModal;
  window.toggleDebug = toggleDebug;
})();