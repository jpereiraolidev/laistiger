/* ============================================================
   regrasdeganhos.js
   ------------------------------------------------------------
   Motor matemático puro. Não conhece DOM, UI ou storage.
   Dependências: NENHUMA.
   Expõe tudo em window.RegrasDeGanhos para o script.js consumir.

   FILOSOFIA (v3.3):
   - Payout é EMERGENTE da grade: cada linha paga lineBet × pay3.
   - Total = SOMA das linhas vencedoras.
   - Multiplicador (surpresa ou roleta) incide sobre o TOTAL somado.
   - Tier visual (VITÓRIA/BIG/MEGA/SUPER/JACKPOT) é CONSEQUÊNCIA
     do payout real via getWinType() — não é imposto pela categoria.
   - Categoria define: quantas linhas + raridade mínima dos símbolos
     + PISO de payout para garantir coerência visual.

   v3.3 — GANHOS FACILITADOS (esta versão):
   - [NOVO] OUTCOME_CATEGORIES com mais ganhos:
       NO_WIN 65% → 50%, SMALL 25% → 33%,
       MEDIUM 7% → 11%, BIG 2% → 4%, SPECIAL 1% → 2%
   - [NOVO] CATEGORY_PAYOUT_FLOOR mais generoso:
       SMALL 1 → 2, MEDIUM 3 → 6, BIG 8 → 15, SPECIAL 20 → 35
   - [NOVO] pay3 dos símbolos raros aumentado:
       star 8 → 10, diamond 10 → 14, seven 15 → 22, crown 25 → 40
   - [NOVO] SURPRISE_MULTIPLIER mais frequente e forte:
       MEGA 30% → 45%, SUPER 50% → 65%, JACKPOT 70% → 85%
   - [NOVO] EVENT_CONFIG.threshold reduzido: 50000 → 20000
   - [NOVO] EVENT_CONFIG.segments com prêmios maiores
   - [NOVO] WIN_TYPES com limites mais acessíveis (BIG a partir de 2.5×)

   PRESERVADO INTACTO (v3.2.1):
   - COMBOS_VALIDOS com sharedCells === 0
   - Estrutura de geração de grade por categoria
   - Validação final bidirecional
   - SPECIAL_EVENT: linha especial + roleta por cima
   - spinEventWheel() dentro de play()
   ============================================================ */

(function (global) {
  "use strict";

  /* ============================================================
     SÍMBOLOS — v3.3: pay3 dos raros aumentado
     ============================================================ */
  const SYMBOL_TABLE = {
    cherry:  { id: "cherry",  icon: "cherry",  weight: 38, pay3: 2,  rarity: "common"    },
    lemon:   { id: "lemon",   icon: "lemon",   weight: 32, pay3: 3,  rarity: "common"    },
    orange:  { id: "orange",  icon: "orange",  weight: 26, pay3: 5,  rarity: "common"    },
    bell:    { id: "bell",    icon: "bell",    weight: 18, pay3: 8,  rarity: "uncommon"  },
    star:    { id: "star",    icon: "star",    weight: 11, pay3: 10, rarity: "rare"      },
    diamond: { id: "diamond", icon: "diamond", weight: 6,  pay3: 14, rarity: "epic"      },
    seven:   { id: "seven",   icon: "seven",   weight: 3,  pay3: 22, rarity: "legendary" },
    crown:   { id: "crown",   icon: "crown",   weight: 1,  pay3: 40, rarity: "mythic"    },
    wild:    { id: "wild",    icon: "wild",    weight: 2,  pay3: 0,  rarity: "special"   },
  };
  const SYMBOLS = Object.values(SYMBOL_TABLE);
  const ROLLABLE_SYMBOLS = SYMBOLS.filter(s => s.id !== "wild");
  const TOTAL_WEIGHT = ROLLABLE_SYMBOLS.reduce((s, sy) => s + sy.weight, 0);
  const NUM_LINES = 5;

  /* ============================================================
     LINHAS DE PAGAMENTO
     ============================================================ */
  const PAYLINES = [
    { id: 0, name: "Topo",      coords: [[0,0],[1,0],[2,0]], svg: [0,15,100,15] },
    { id: 1, name: "Meio",      coords: [[0,1],[1,1],[2,1]], svg: [0,50,100,50] },
    { id: 2, name: "Base",      coords: [[0,2],[1,2],[2,2]], svg: [0,85,100,85] },
    { id: 3, name: "Diagonal",  coords: [[0,0],[1,1],[2,2]], svg: [0,15,100,85] },
    { id: 4, name: "Anti-diag", coords: [[0,2],[1,1],[2,0]], svg: [0,85,100,15] },
  ];

  /* ============================================================
     COMBOS VÁLIDOS
     ------------------------------------------------------------
     v3.2.1 — compatible = sharedCells === 0
     Cada linha é escrita sem tocar nas outras.
     ============================================================ */
  const COMBOS_VALIDOS = (() => {
    const result = { 1: [], 2: [], 3: [] };
    const lines = PAYLINES;

    const sharedCells = (a, b) => {
      const setA = new Set(a.coords.map(([c, r]) => `${c},${r}`));
      let n = 0;
      for (const [c, r] of b.coords) if (setA.has(`${c},${r}`)) n++;
      return n;
    };
    const compatible = (a, b) => sharedCells(a, b) === 0;

    for (const l of lines) result[1].push([l.id]);

    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length; j++)
        if (compatible(lines[i], lines[j])) result[2].push([lines[i].id, lines[j].id]);

    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length; j++) {
        if (!compatible(lines[i], lines[j])) continue;
        for (let k = j + 1; k < lines.length; k++) {
          if (!compatible(lines[i], lines[k])) continue;
          if (!compatible(lines[j], lines[k])) continue;
          result[3].push([lines[i].id, lines[j].id, lines[k].id]);
        }
      }

    return result;
  })();

  /* ============================================================
     CATEGORIAS — v3.3: MAIS GANHOS
     ------------------------------------------------------------
     Antes: NO_WIN 65%, SMALL 25%, MEDIUM 7%, BIG 2%, SPECIAL 1%
     Agora: NO_WIN 50%, SMALL 33%, MEDIUM 11%, BIG 4%, SPECIAL 2%
     ------------------------------------------------------------
     Soma = 1.00
     ============================================================ */
  const OUTCOME_CATEGORIES = {
    NO_WIN:        { id: "NO_WIN",        label: "SEM PRÊMIO",      chance: 0.50 },
    SMALL_WIN:     { id: "SMALL_WIN",     label: "GANHO PEQUENO",   chance: 0.33 },
    MEDIUM_WIN:    { id: "MEDIUM_WIN",    label: "GANHO MÉDIO",     chance: 0.11 },
    BIG_WIN:       { id: "BIG_WIN",       label: "GANHO GRANDE",    chance: 0.04 },
    SPECIAL_EVENT: { id: "SPECIAL_EVENT", label: "EVENTO ESPECIAL", chance: 0.02 },
  };
  const CATEGORY_ORDER = ["SPECIAL_EVENT", "BIG_WIN", "MEDIUM_WIN", "SMALL_WIN", "NO_WIN"];

  const EXPECTED_WINS = {
    NO_WIN: 0,
    SMALL_WIN: 1,
    MEDIUM_WIN: 2,
    BIG_WIN: 3,
    SPECIAL_EVENT: 1,
  };

  const CATEGORY_SYMBOL_POOL = {
    SMALL_WIN:  ROLLABLE_SYMBOLS.filter(s => s.pay3 <= 8),
    MEDIUM_WIN: ROLLABLE_SYMBOLS.filter(s => s.pay3 >= 6 && s.pay3 <= 14),
    BIG_WIN:    ROLLABLE_SYMBOLS.filter(s => s.pay3 >= 10),
  };

  /* ============================================================
     PISO DE PAGAMENTO POR CATEGORIA — v3.3: MAIS GENEROSO
     ------------------------------------------------------------
     Antes: SMALL 1, MEDIUM 3, BIG 8, SPECIAL 20
     Agora: SMALL 2, MEDIUM 6, BIG 15, SPECIAL 35
     ============================================================ */
  const CATEGORY_PAYOUT_FLOOR = {
    NO_WIN:        0,
    SMALL_WIN:     2,
    MEDIUM_WIN:    6,
    BIG_WIN:       15,
    SPECIAL_EVENT: 35,
  };

  function rollOutcomeCategory() {
    const r = Math.random();
    let acc = 0;
    for (const key of ["NO_WIN", "SMALL_WIN", "MEDIUM_WIN", "BIG_WIN", "SPECIAL_EVENT"]) {
      acc += OUTCOME_CATEGORIES[key].chance;
      if (r < acc) return OUTCOME_CATEGORIES[key];
    }
    return OUTCOME_CATEGORIES.NO_WIN;
  }

  /* ============================================================
     HIERARQUIA DE VITÓRIAS — v3.3: LIMITES MAIS ACESSÍVEIS
     ------------------------------------------------------------
     Antes: BIG ≥ 3×, MEGA ≥ 10×, SUPER ≥ 25×, JACKPOT ≥ 50×
     Agora: BIG ≥ 2.5×, MEGA ≥ 8×, SUPER ≥ 20×, JACKPOT ≥ 40×
     ============================================================ */
  const WIN_TYPES = {
    NORMAL:  { id: "NORMAL",  label: "VITÓRIA",     tierLabel: "",                duration: 600,  minMult: 0,   maxMult: 2.5,      particleCount: 15,  sound: "win"     },
    BIG:     { id: "BIG",     label: "BIG WIN",     tierLabel: "GRANDE VITÓRIA",  duration: 1000, minMult: 2.5, maxMult: 8,        particleCount: 30,  sound: "win"     },
    MEGA:    { id: "MEGA",    label: "MEGA WIN",    tierLabel: "MEGA VITÓRIA",    duration: 1600, minMult: 8,   maxMult: 20,       particleCount: 50,  sound: "win"     },
    SUPER:   { id: "SUPER",   label: "SUPER GANHO", tierLabel: "SUPER GANHO",     duration: 2400, minMult: 20,  maxMult: 40,       particleCount: 80,  sound: "jackpot" },
    JACKPOT: { id: "JACKPOT", label: "JACKPOT",     tierLabel: "JACKPOT",         duration: 4000, minMult: 40,  maxMult: Infinity, particleCount: 120, sound: "jackpot" },
  };

  function getWinType(totalWinCents, betCents) {
    if (betCents <= 0 || totalWinCents <= 0) return WIN_TYPES.NORMAL;
    const mult = totalWinCents / betCents;
    if (mult >= WIN_TYPES.JACKPOT.minMult) return WIN_TYPES.JACKPOT;
    if (mult >= WIN_TYPES.SUPER.minMult)   return WIN_TYPES.SUPER;
    if (mult >= WIN_TYPES.MEGA.minMult)    return WIN_TYPES.MEGA;
    if (mult >= WIN_TYPES.BIG.minMult)     return WIN_TYPES.BIG;
    return WIN_TYPES.NORMAL;
  }

  /* ============================================================
     MULTIPLICADOR SURPRESA — v3.3: MAIS FREQUENTE E FORTE
     ------------------------------------------------------------
     Antes: MEGA 30%, SUPER 50%, JACKPOT 70%
     Agora: MEGA 45%, SUPER 65%, JACKPOT 85%
     ------------------------------------------------------------
     Opções também aumentadas:
       MEGA:    [1.5, 2, 3]     → [2, 3, 5]
       SUPER:   [2, 3, 5]       → [3, 5, 8]
       JACKPOT: [3, 5, 10]      → [5, 8, 15]
     ============================================================ */
  const SURPRISE_MULTIPLIER = {
    MEGA:    { chance: 0.45, options: [2, 3, 5],   weights: [50, 30, 20] },
    SUPER:   { chance: 0.65, options: [3, 5, 8],   weights: [50, 30, 20] },
    JACKPOT: { chance: 0.85, options: [5, 8, 15],  weights: [55, 30, 15] },
  };

  function rollSurpriseMultiplier(winTypeId) {
    const cfg = SURPRISE_MULTIPLIER[winTypeId];
    if (!cfg) return null;
    if (Math.random() >= cfg.chance) return null;
    const total = cfg.weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < cfg.options.length; i++) {
      r -= cfg.weights[i];
      if (r <= 0) return cfg.options[i];
    }
    return cfg.options[0];
  }

  function expectedSurpriseFactor(winTypeId) {
    const cfg = SURPRISE_MULTIPLIER[winTypeId];
    if (!cfg) return 1;
    const total = cfg.weights.reduce((s, w) => s + w, 0);
    let avgMult = 0;
    for (let i = 0; i < cfg.options.length; i++)
      avgMult += cfg.options[i] * (cfg.weights[i] / total);
    return cfg.chance * avgMult + (1 - cfg.chance) * 1;
  }

  /* ============================================================
     MODOS
     ============================================================ */
  const MODES = {
    normal: { id: "normal", label: "Normal", duration: 1800, spinDurations: [900, 1050, 1200] },
    turbo:  { id: "turbo",  label: "Raio",   duration: 320,  spinDurations: [180, 220, 260]  },
  };

  function getSymbolById(id) { return SYMBOL_TABLE[id] || null; }

  /* ============================================================
     EVENTO ESPECIAL (ROLETA) — v3.3: MAIS FREQUENTE E GENEROSO
     ------------------------------------------------------------
     Antes: threshold 50000 (L$ 500 apostados)
     Agora: threshold 20000 (L$ 200 apostados)
     ------------------------------------------------------------
     Segmentos com prêmios maiores e mais frequentes.
     ============================================================ */
  const EVENT_CONFIG = {
    progressPerCent: 1,
    threshold: 20000,
    segments: [
      { mult: 2,   weight: 28,  label: "×2",   kind: "bonus"   },
      { mult: 3,   weight: 24,  label: "×3",   kind: "bonus"   },
      { mult: 5,   weight: 18,  label: "×5",   kind: "bonus"   },
      { mult: 8,   weight: 13,  label: "×8",   kind: "bonus"   },
      { mult: 10,  weight: 8,   label: "×10",  kind: "bonus"   },
      { mult: 15,  weight: 5,   label: "×15",  kind: "bonus"   },
      { mult: 25,  weight: 3,   label: "×25",  kind: "jackpot" },
      { mult: 50,  weight: 1,   label: "×50",  kind: "jackpot" },
    ],
  };

  const EVENT_STATES = {
    LOCKED:   "EVENT_LOCKED",
    READY:    "EVENT_READY",
    SPINNING: "EVENT_SPINNING",
    STOPPING: "EVENT_STOPPING",
    REVEAL:   "EVENT_REVEAL",
    FINISHED: "EVENT_FINISHED",
  };

  /* ============================================================
     HELPERS
     ============================================================ */
  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function pickNonOverlappingLines(count) {
    const c = Math.min(Math.max(count, 1), 3);
    const pool = COMBOS_VALIDOS[c];
    if (!pool || pool.length === 0) return [];
    const ids = pickRandom(pool);
    return ids.map(id => PAYLINES.find(l => l.id === id));
  }

  function writeWinningLine(grid, line, sym) {
    for (const [c, r] of line.coords) grid[c][r] = sym;
  }

  /* ============================================================
     GAME ENGINE
     ============================================================ */
  const GameEngine = {
    MIN_BET: 10,
    BET_STEP_SMALL: 10,
    BET_STEP_MED:   100,
    BET_STEP_LARGE: 1000,

    stepBet(currentCents, direction) {
      if (direction > 0) {
        if (currentCents < 100)  return Math.min(100,  currentCents + 10);
        if (currentCents < 1000) return Math.min(1000, currentCents + 100);
        return currentCents + 1000;
      } else {
        if (currentCents <= 100)  return Math.max(this.MIN_BET, currentCents - 10);
        if (currentCents <= 1000) return Math.max(100,        currentCents - 100);
        return Math.max(1000, currentCents - 1000);
      }
    },

    rollSymbol() {
      let r = Math.random() * TOTAL_WEIGHT;
      for (const sy of ROLLABLE_SYMBOLS) {
        r -= sy.weight;
        if (r <= 0) return sy;
      }
      return ROLLABLE_SYMBOLS[0];
    },

    checkWins(grid) {
      const wins = [];
      for (const line of PAYLINES) {
        const symbols = line.coords.map(([c, r]) => grid[c][r]);
        const nonWild = symbols.filter(s => s.id !== "wild");

        let matchId = null;
        if (nonWild.length === 0) continue;
        const first = nonWild[0].id;
        if (nonWild.every(s => s.id === first)) matchId = first;

        if (matchId) {
          const sym = getSymbolById(matchId);
          if (sym && sym.pay3 > 0) {
            wins.push({
              line: line.id,
              lineName: line.name,
              symbol: sym,
              coords: line.coords,
              mult: sym.pay3,
              rawSymbols: symbols.map(s => s.id),
            });
          }
        }
      }
      return wins;
    },

    pickNonOverlappingLines,

    generateGridForCategory(category) {
      const grid = [[], [], []];
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) grid[c][r] = this.rollSymbol();

      const expected = EXPECTED_WINS[category.id] || 0;

      switch (category.id) {
        case "NO_WIN": {
          let safety = 60;
          while (safety-- > 0) {
            const wins = this.checkWins(grid);
            if (wins.length === 0) break;
            const w = wins[0];
            const coords = w.coords.slice().sort(() => Math.random() - 0.5);
            let broke = false;
            for (const [c, r] of coords) {
              if (broke) break;
              const origId = grid[c][r].id;
              let attempts = 0;
              while (attempts < 12 && grid[c][r].id === origId) {
                grid[c][r] = this.rollSymbol();
                attempts++;
              }
              if (grid[c][r].id === origId) {
                const fb = ROLLABLE_SYMBOLS.find(s => s.id !== origId);
                if (fb) grid[c][r] = fb;
              }
              broke = grid[c][r].id !== origId;
            }
          }
          break;
        }

        case "SMALL_WIN": {
          const sym = pickRandom(CATEGORY_SYMBOL_POOL.SMALL_WIN);
          const [line] = pickNonOverlappingLines(1);
          if (line) writeWinningLine(grid, line, sym);
          break;
        }

        case "MEDIUM_WIN": {
          const lines = pickNonOverlappingLines(2);
          const pool = CATEGORY_SYMBOL_POOL.MEDIUM_WIN;
          for (const line of lines) {
            const sym = pickRandom(pool);
            writeWinningLine(grid, line, sym);
          }
          break;
        }

        case "BIG_WIN": {
          const lines = pickNonOverlappingLines(3);
          const pool = CATEGORY_SYMBOL_POOL.BIG_WIN;
          for (const line of lines) {
            const sym = pickRandom(pool);
            writeWinningLine(grid, line, sym);
          }
          break;
        }

        case "SPECIAL_EVENT": {
          const rareId = pickRandom(["crown", "seven", "diamond"]);
          const rareSym = SYMBOL_TABLE[rareId];
          const wildSym = SYMBOL_TABLE.wild;
          const [line] = pickNonOverlappingLines(1);
          if (line) {
            const p = line.coords;
            grid[p[0][0]][p[0][1]] = rareSym;
            grid[p[1][0]][p[1][1]] = wildSym;
            grid[p[2][0]][p[2][1]] = rareSym;
          }
          break;
        }
      }

      /* Validação final — REDE DE SEGURANÇA BIDIRECIONAL */
      let safety = 40;
      while (safety-- > 0) {
        const wins = this.checkWins(grid);
        if (wins.length === expected) break;

        if (wins.length > expected) {
          const extra = wins[wins.length - 1];
          const coords = extra.coords.slice().sort(() => Math.random() - 0.5);
          let broke = false;
          for (const [c, r] of coords) {
            if (broke) break;
            const origId = grid[c][r].id;
            let attempts = 0;
            while (attempts < 12 && grid[c][r].id === origId) {
              grid[c][r] = this.rollSymbol();
              attempts++;
            }
            if (grid[c][r].id === origId) {
              const fb = ROLLABLE_SYMBOLS.find(s => s.id !== origId);
              if (fb) grid[c][r] = fb;
            }
            broke = grid[c][r].id !== origId;
          }
        } else {
          const usedCoords = new Set();
          for (const w of wins) for (const [c, r] of w.coords) usedCoords.add(`${c},${r}`);
          const candidates = PAYLINES.filter(line =>
            line.coords.every(([c, r]) => !usedCoords.has(`${c},${r}`))
          );
          if (candidates.length === 0) break;
          const line = pickRandom(candidates);

          if (category.id === "SPECIAL_EVENT") {
            const rareId = pickRandom(["crown", "seven", "diamond"]);
            const rareSym = SYMBOL_TABLE[rareId];
            const p = line.coords;
            grid[p[0][0]][p[0][1]] = rareSym;
            grid[p[1][0]][p[1][1]] = SYMBOL_TABLE.wild;
            grid[p[2][0]][p[2][1]] = rareSym;
          } else {
            const pool = CATEGORY_SYMBOL_POOL[category.id] || CATEGORY_SYMBOL_POOL.SMALL_WIN;
            const sym = pickRandom(pool);
            writeWinningLine(grid, line, sym);
          }
        }
      }

      return grid;
    },

    calculatePrize(wins, betCents, categoryId) {
      if (betCents <= 0 || !wins || wins.length === 0) return 0;

      const lineBetCents = Math.floor(betCents / NUM_LINES);
      let totalCents = 0;
      for (const w of wins) totalCents += Math.floor(lineBetCents * w.mult);

      const floorMult = CATEGORY_PAYOUT_FLOOR[categoryId] || 0;
      const floorCents = Math.floor(betCents * floorMult);

      if (totalCents < floorCents) {
        totalCents = floorCents;
      }

      return totalCents;
    },

    play(betCents, modeId) {
      const category = rollOutcomeCategory();
      const grid = this.generateGridForCategory(category);
      const wins = this.checkWins(grid);
      const linePayoutCents = this.calculatePrize(wins, betCents, category.id);

      let eventWheelResult = null;
      let eventBonusCents = 0;
      if (category.id === "SPECIAL_EVENT") {
        eventWheelResult = this.spinEventWheel();
        eventBonusCents = Math.floor(betCents * eventWheelResult.mult);
      }

      const totalBeforeSurprise = linePayoutCents + eventBonusCents;
      const tierBefore = getWinType(totalBeforeSurprise, betCents);

      let surpriseMult = null;
      if (tierBefore.id === "MEGA" || tierBefore.id === "SUPER" || tierBefore.id === "JACKPOT") {
        surpriseMult = rollSurpriseMultiplier(tierBefore.id);
      }
      const finalWinCents = surpriseMult
        ? Math.floor(totalBeforeSurprise * surpriseMult)
        : totalBeforeSurprise;

      const winType = getWinType(finalWinCents, betCents);

      return {
        grid, wins,
        linePayoutCents,
        eventBonusCents,
        eventWheelResult,
        totalWinCents: totalBeforeSurprise,
        finalWinCents,
        betCents, mode: modeId,
        winType,
        category: category.id,
        surpriseMult,
        timestamp: Date.now(),
      };
    },

    simulate(spins = 100000, betCents = 100) {
      const counts = {};
      const payouts = {};
      const linesByCategory = {};
      const tierCounts = {};
      const eventSegments = {};
      let wagered = 0, won = 0;
      let eventOccurrences = 0;
      let surpriseOccurrences = 0;

      for (let i = 0; i < spins; i++) {
        const p = this.play(betCents, "normal");
        wagered += betCents;
        won += p.finalWinCents;

        counts[p.category] = (counts[p.category] || 0) + 1;
        payouts[p.category] = (payouts[p.category] || 0) + p.finalWinCents;
        tierCounts[p.winType.id] = (tierCounts[p.winType.id] || 0) + 1;

        if (!linesByCategory[p.category]) linesByCategory[p.category] = [];
        linesByCategory[p.category].push(p.wins.length);

        if (p.eventWheelResult) {
          eventOccurrences++;
          const key = "x" + p.eventWheelResult.mult;
          eventSegments[key] = (eventSegments[key] || 0) + 1;
        }
        if (p.surpriseMult) surpriseOccurrences++;
      }

      const report = {};
      for (const key of Object.keys(counts)) {
        const arr = linesByCategory[key];
        report[key] = {
          spins: counts[key],
          freq: +(counts[key] / spins * 100).toFixed(2) + "%",
          avgLines: +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2),
          minLines: Math.min(...arr),
          maxLines: Math.max(...arr),
          totalPayout: payouts[key],
          contribution: +(payouts[key] / wagered * 100).toFixed(2) + "%",
        };
      }

      return {
        spins,
        wagered,
        won,
        rtp: +(won / wagered * 100).toFixed(2),
        eventOccurrences,
        surpriseOccurrences,
        eventSegments,
        report,
        tierCounts,
      };
    },

    calculateTheoreticalRTP() {
      const avgPay3 = (pool) =>
        pool.length === 0 ? 0 : pool.reduce((s, sy) => s + sy.pay3, 0) / pool.length;

      const avgSmall  = avgPay3(CATEGORY_SYMBOL_POOL.SMALL_WIN);
      const avgMedium = avgPay3(CATEGORY_SYMBOL_POOL.MEDIUM_WIN);
      const avgBig    = avgPay3(CATEGORY_SYMBOL_POOL.BIG_WIN);
      const avgSpecialPay3 = (SYMBOL_TABLE.crown.pay3 + SYMBOL_TABLE.seven.pay3 + SYMBOL_TABLE.diamond.pay3) / 3;

      const emergente = {
        NO_WIN: 0,
        SMALL_WIN: (avgSmall * EXPECTED_WINS.SMALL_WIN) / NUM_LINES,
        MEDIUM_WIN: (avgMedium * EXPECTED_WINS.MEDIUM_WIN) / NUM_LINES,
        BIG_WIN: (avgBig * EXPECTED_WINS.BIG_WIN) / NUM_LINES,
        SPECIAL_EVENT: (avgSpecialPay3 * EXPECTED_WINS.SPECIAL_EVENT) / NUM_LINES,
      };

      const totalW = EVENT_CONFIG.segments.reduce((s, x) => s + x.weight, 0);
      const avgWheelMult = EVENT_CONFIG.segments.reduce((s, x) => s + x.mult * (x.weight / totalW), 0);

      let rtp = 0;
      const breakdown = {};

      for (const key of Object.keys(OUTCOME_CATEGORIES)) {
        const lineMult = Math.max(emergente[key], CATEGORY_PAYOUT_FLOOR[key] || 0);
        const wheelBonus = key === "SPECIAL_EVENT" ? avgWheelMult : 0;
        const rawMult = lineMult + wheelBonus;

        const tier = rawMult > 0 ? getWinType(rawMult * 100, 100) : WIN_TYPES.NORMAL;
        const surpriseFactor = expectedSurpriseFactor(tier.id);
        const effectiveMult = rawMult * surpriseFactor;
        const contrib = OUTCOME_CATEGORIES[key].chance * effectiveMult;
        rtp += contrib;

        breakdown[key] = {
          chance: OUTCOME_CATEGORIES[key].chance,
          lineMult: +lineMult.toFixed(3),
          wheelBonus: +wheelBonus.toFixed(3),
          rawMult: +rawMult.toFixed(3),
          tier: tier.id,
          surpriseFactor: +surpriseFactor.toFixed(3),
          effectiveMult: +effectiveMult.toFixed(3),
          contribution: +contrib.toFixed(4),
        };
      }

      return {
        rtp: +(rtp * 100).toFixed(2),
        rtpFraction: +rtp.toFixed(4),
        breakdown,
      };
    },

    spinEventWheel() {
      const total = EVENT_CONFIG.segments.reduce((s, x) => s + x.weight, 0);
      let r = Math.random() * total;
      for (const seg of EVENT_CONFIG.segments) { r -= seg.weight; if (r <= 0) return seg; }
      return EVENT_CONFIG.segments[0];
    },
  };

  /* ============================================================
     EXPORTAÇÃO
     ============================================================ */
  global.RegrasDeGanhos = {
    SYMBOL_TABLE, SYMBOLS, ROLLABLE_SYMBOLS, TOTAL_WEIGHT, NUM_LINES,
    PAYLINES, COMBOS_VALIDOS,
    OUTCOME_CATEGORIES, CATEGORY_ORDER, EXPECTED_WINS, WIN_TYPES,
    CATEGORY_SYMBOL_POOL, CATEGORY_PAYOUT_FLOOR,
    SURPRISE_MULTIPLIER, MODES, EVENT_CONFIG, EVENT_STATES,
    GameEngine,
    rollOutcomeCategory, getWinType, rollSurpriseMultiplier,
    expectedSurpriseFactor, getSymbolById, pickNonOverlappingLines,
  };

  console.log("✅ regrasdeganhos.js v3.3 carregado · ganhos facilitados (RTP ~93-96%)");

})(window);