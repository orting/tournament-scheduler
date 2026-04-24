"use strict";

/**
 * Tournament Builder – v3 (Auto workflow + auto-updating bracket with seed labels)
 * - Randomize groups => auto create group matches + auto create bracket
 * - Bracket auto-updates on group result changes
 * - Bracket shows seed labels (#1 Group A) until that group is decided
 * - Knockout winners propagate forward
 * - localStorage persistence
 */

const STORAGE_KEY = "tournament_builder_state_v3";

// Sentinel id used for cross-group manual tiebreak UI
const CROSS_UI_ID = "__cross__";

/* -----------------------------
   Utilities
----------------------------- */

const $ = (id) => document.getElementById(id);

function safeOn(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function clampInt(val, min, max) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let _bracketLinesInitialized = false;

function drawBracketConnectors() {
  if (!state.knockout) return;

  const canvas = document.getElementById("bracketCanvas");
  if (!canvas) return;

  const svg = canvas.querySelector("svg.bracket-lines");
  if (!svg) return;

  // Make sure SVG matches the content size (not just the visible viewport)
  const w = canvas.scrollWidth;
  const h = canvas.scrollHeight;

  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = "";

  const canvasRect = canvas.getBoundingClientRect();

  // DOM lookup: matchId -> element
  const matchEls = [...canvas.querySelectorAll("[data-match-id]")];
  const elById = new Map(matchEls.map(el => [el.dataset.matchId, el]));

  // Build mapping from prevMatchId -> nextMatchId (from your knockout model)
  // nextRoundMatch.aSeed / bSeed are {fromMatchId: "..."} per your code.
  const ko = state.knockout;

  for (let r = 0; r < ko.rounds.length - 1; r++) {
    const nextRound = ko.rounds[r + 1];

    for (const next of nextRound) {
      for (const sideKey of ["aSeed", "bSeed"]) {
        const side = next[sideKey];
        if (!side || !side.fromMatchId) continue;

        const prevId = side.fromMatchId;
        const nextId = next.id;

        const prevEl = elById.get(prevId);
        const nextEl = elById.get(nextId);
        if (!prevEl || !nextEl) continue;

        const p = prevEl.getBoundingClientRect();
        const n = nextEl.getBoundingClientRect();

        // points relative to canvas (so scrolling doesn't break alignment)
        const px = p.right - canvasRect.left;
        const py = p.top - canvasRect.top + p.height / 2;

        const nx = n.left - canvasRect.left;
        const ny = n.top - canvasRect.top + n.height / 2;

        const midX = (px + nx) / 2;

        // Draw an elbow connector: right-center -> midX -> next left-center
        const d = `M ${px} ${py} L ${midX} ${py} L ${midX} ${ny} L ${nx} ${ny}`;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        svg.appendChild(path);
      }
    }
  }

  // Initialize resize handler once
  if (!_bracketLinesInitialized) {
    _bracketLinesInitialized = true;
    window.addEventListener("resize", () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          alignBracketMatches();
          drawBracketConnectors()
        });
      });
    });
  }
}

function alignBracketMatches() {
  const canvas = document.getElementById("bracketCanvas");
  if (!canvas) return;

  const roundWraps = [...canvas.querySelectorAll(".round-matches")]
    .sort((a, b) => Number(a.dataset.round) - Number(b.dataset.round));
  if (roundWraps.length === 0) return;

  const getMatches = (wrap) =>
    [...wrap.querySelectorAll(".match")]
      .sort((a, b) => Number(a.dataset.matchIndex) - Number(b.dataset.matchIndex));

  const canvasRect = canvas.getBoundingClientRect();

  // Reset tops for later rounds before measuring
  for (let r = 1; r < roundWraps.length; r++) {
    for (const el of getMatches(roundWraps[r])) el.style.top = "0px";
  }

  // Round 0 baseline centers in CANVAS coordinates
  const baseWrap = roundWraps[0];
  const baseMatches = getMatches(baseWrap);
  if (baseMatches.length === 0) return;

  // Height baseline (includes flex gap if round 0 uses it)
  const baseHeight = baseWrap.scrollHeight;
  for (const wrap of roundWraps) wrap.style.minHeight = baseHeight + "px";

  let prevCentersCanvas = baseMatches.map((el) => {
    const r = el.getBoundingClientRect();
    return (r.top - canvasRect.top) + (r.height / 2);
  });

  // Helper: median (robust against outliers)
  function median(nums) {
    if (!nums.length) return 0;
    const a = [...nums].sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // Position each subsequent round using CANVAS coordinates + auto-calibration
  for (let r = 1; r < roundWraps.length; r++) {
    const wrap = roundWraps[r];
    const matches = getMatches(wrap);

    const wrapRect = wrap.getBoundingClientRect();

    // Top of the ABSOLUTE POSITIONING ORIGIN in canvas coords.
    // top=0 for abs children is the padding edge, so subtract border (clientTop) but not padding.
    const wrapOriginCanvas = (wrapRect.top - canvasRect.top) + wrap.clientTop;

    // First pass: place using computed desired centers
    const desiredCenters = []; // per match i
    for (let i = 0; i < matches.length; i++) {
      const el = matches[i];

      const p1 = prevCentersCanvas[i * 2];
      const p2 = prevCentersCanvas[i * 2 + 1];
      if (p1 == null || p2 == null) {
        desiredCenters.push(null);
        continue;
      }

      const desiredCenterCanvas = (p1 + p2) / 2;
      desiredCenters.push(desiredCenterCanvas);

      const h = el.getBoundingClientRect().height;
      const topWithinWrap = desiredCenterCanvas - wrapOriginCanvas - (h / 2);

      el.style.top = `${topWithinWrap}px`;
    }

    // Second pass: measure actual centers and compute the constant delta for this round
    const deltas = [];
    for (let i = 0; i < matches.length; i++) {
      const target = desiredCenters[i];
      if (target == null) continue;

      const rr = matches[i].getBoundingClientRect();
      const actualCenterCanvas = (rr.top - canvasRect.top) + (rr.height / 2);

      deltas.push(actualCenterCanvas - target);
    }

    // If everything is consistently off, this delta corrects it
    const roundDelta = median(deltas);

    if (roundDelta !== 0) {
      for (const el of matches) {
        const curTop = parseFloat(el.style.top || "0");
        el.style.top = `${curTop - roundDelta}px`;
      }
    }

    // Recompute this round’s centers in CANVAS coords after calibration
    prevCentersCanvas = matches.map((el) => {
      const rr = el.getBoundingClientRect();
      return (rr.top - canvasRect.top) + (rr.height / 2);
    });
  }
}

/**
 * Returns {G,K,q,r} where:
 *  - G = number of groups
 *  - K = total knockout spots (qualifierCount)
 *  - q = floor(K/G) full ranks that qualify in every group
 *  - r = remainder spots (K % G)
 */
function getQualificationParams() {
  const G = state.groups?.length ?? 0;
  const K = Math.min(state.qualifierCount ?? 0, state.participants?.length ?? 0);
  const q = G > 0 ? Math.floor(K / G) : 0;
  const r = G > 0 ? (K % G) : 0;
  return { G, K, q, r };
}

function getCrossGroupTie() {
  // ✅ Freeze while the cross-group manual panel is open
  if (ui.activeGroupId === CROSS_UI_ID && ui.mode === "manual") {
    return { candidatePids: [...ui.crossCandidates], places: ui.crossPlaces };
  }

  // If an override exists, don't re-detect
  if (state.crossGroupTiebreak) return null;

  const { q, r } = getQualificationParams();
  if (r === 0) return null;

  // Determine group size spread (you said diff <= 1)
  const sizes = state.groups.map(g => g.memberIds.length);
  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);
  const sizesDiffer = maxSize > minSize;

  // Compute adjusted wins for the rank-(q+1) candidate in each group
  const candidates = [];

  for (const g of state.groups) {
    const ranking = groupRanking(g.id);
    if (ranking.length < q + 1) continue;

    const candidatePid = ranking[q].pid;         // (q+1)th in this group
    const ignoreLowestInThisGroup = sizesDiffer && (g.memberIds.length === maxSize);

    const lowestPid = ignoreLowestInThisGroup
      ? ranking[ranking.length - 1].pid
      : null;

    let wins = 0;

    for (const m of state.groupMatches) {
      if (m.groupId !== g.id) continue;
      if (!m.winnerId) continue;

      const involved = (m.aId === candidatePid || m.bId === candidatePid);
      if (!involved) continue;

      const opponent = (m.aId === candidatePid) ? m.bId : m.aId;

      // If groups differ in size, ignore matches vs lowest only in larger groups
      if (lowestPid && opponent === lowestPid) continue;

      if (m.winnerId === candidatePid) wins += 1;
    }

    candidates.push({ pid: candidatePid, groupId: g.id, wins });
  }

  if (candidates.length === 0) return null;

  // Sort by adjusted wins desc
  candidates.sort((a, b) => b.wins - a.wins);

  // If we can fill the remainder spots without ambiguity, no cross-group tie UI
  if (candidates.length <= r) return null;

  const cutoffWins = candidates[r - 1].wins;
  const nextWins = candidates[r]?.wins;

  // If the boundary isn't tied, no manual tiebreak needed
  if (nextWins === undefined || cutoffWins !== nextWins) return null;

  // Tie group = everyone with wins == cutoffWins
  const tiedGroup = candidates.filter(c => c.wins === cutoffWins);

  // If tiedGroup size exceeds remaining places at this boundary -> manual tiebreak needed
  if (tiedGroup.length <= r) return null;

  return {
    candidatePids: tiedGroup.map(c => c.pid),
    places: r
  };
}

/**
 * Returns a Set(pid) of teams that are tied ACROSS a qualification boundary
 * inside this group, but ONLY when the group is decided.
 *
 * Boundaries considered:
 * 1) Between q and q+1 (guaranteed qualifier cutoff) when q >= 1
 * 2) Between q+1 and q+2 (remainder-candidate cutoff) when r > 0
 *
 * "Tied across boundary" means the points value is equal on both sides
 * of the boundary, so internal tiebreak resolution is required.
 */
function tiedAtQualificationBoundaries(groupId) {
  const g = state.groups.find(gr => gr.id === groupId);
  if (!g) return new Set();

  // ✅ If a tiebreak has been applied, the tie is resolved
  if (g.tiebreak) return new Set();

  // Existing logic follows
  if (!isGroupDecided(groupId)) return new Set();

  const ranking = groupRanking(groupId);
  const { q, r } = getQualificationParams();

  // If group smaller than relevant boundary, nothing to do
  if (!ranking || ranking.length === 0) return new Set();

  const boundaries = [];
  if (q >= 1) boundaries.push(q);
  if (r > 0) boundaries.push(q + 1);

  const tied = new Set();

  for (const a of boundaries) {
    // boundary at rank a splits [1..a] vs [a+1..]
    const leftIdx = a - 1;
    const rightIdx = a;

    if (leftIdx < 0 || rightIdx >= ranking.length) continue;

    // IMPORTANT: ranking entries must have a numeric "points"
    // (in your app points==wins; groupRanking should already provide it)
    const leftPts = ranking[leftIdx].points;
    const rightPts = ranking[rightIdx].points;

    if (leftPts == null || rightPts == null) continue;
    if (leftPts !== rightPts) continue;

    const pts = leftPts;

    // Expand tie block around the boundary
    let start = leftIdx;
    let end = rightIdx;

    while (start - 1 >= 0 && ranking[start - 1].points === pts) start--;
    while (end + 1 < ranking.length && ranking[end + 1].points === pts) end++;

    for (let i = start; i <= end; i++) {
      tied.add(ranking[i].pid);
    }
  }

  return tied;
}

function allBoundaryTiedPids() {
  const tied = new Set();
  for (const g of state.groups) {
    if (!isGroupDecided(g.id)) continue;
    const t = tiedAtQualificationBoundaries(g.id);
    for (const pid of t) tied.add(pid);
  }
  return tied;
}

function groupStatus(groupId) {
  if (!isGroupDecided(groupId)) return "in-progress";
  const tied = tiedAtQualificationBoundaries(groupId);
  return tied.size > 0 ? "undecided-tie" : "decided";
}

function applyManualTiebreakToGroup(groupId, resolvedOrder) {
  const g = state.groups.find(gr => gr.id === groupId);
  if (!g) return;

  // Ensure resolvedOrder is an array of unique pids
  const uniq = [...new Set(resolvedOrder)];
  if (uniq.length !== resolvedOrder.length) {
    console.warn("Manual tiebreak: duplicate participants in resolvedOrder");
    return;
  }

  // Optional safety: only allow manual tiebreak when group is decided
  if (!isGroupDecided(groupId)) {
    console.warn("Manual tiebreak: group not decided yet");
    return;
  }

  // Optional safety: ensure these pids belong to the group
  const groupSet = new Set(g.memberIds);
  for (const pid of uniq) {
    if (!groupSet.has(pid)) {
      console.warn("Manual tiebreak: pid not in group", pid);
      return;
    }
  }

  // Optional safety: ensure the manual order covers exactly the current boundary-tied set
  // (this avoids accidentally reordering unrelated players)
  const tied = tiedAtQualificationBoundaries(groupId);
  if (tied.size > 0) {
    const tiedArr = [...tied];
    const manualSet = new Set(uniq);
    const same =
      tiedArr.every(pid => manualSet.has(pid)) &&
      uniq.every(pid => tied.has(pid));

    if (!same) {
      console.warn("Manual tiebreak: order must match tied-at-boundary set", {
        tied: tiedArr,
        provided: uniq
      });
      return;
    }
  }

  g.tiebreak = {
    type: "manual",
    resolvedOrder: uniq
  };

  rebuildKnockoutAuto();
  saveState();
  renderAll();
}

function clearGroupTiebreak(groupId) {
  const g = state.groups.find(gr => gr.id === groupId);
  if (!g) return;

  g.tiebreak = null;

  rebuildKnockoutAuto();
  saveState();
  renderAll();
}

function isGuaranteedFromGroup(groupId, pid) {
  const g = state.groups.find(gr => gr.id === groupId);
  if (!g) return false;

  // If a manual tiebreak exists, it authoritatively resolves the group
  const ranking = groupRanking(groupId);
  const { q } = getQualificationParams();
  const idx = ranking.findIndex(r => r.pid === pid);
  if (idx === -1) return false;

  // ✅ Case 1: group is decided -> final rank determines guarantee
  if (isGroupDecided(groupId)) {
    return idx + 1 <= q;
  }

  // ❌ Don’t allow guarantees while a boundary tie exists
  if (tiedAtQualificationBoundaries(groupId).size > 0) return false;

  // ✅ Case 2: early clinch while group still in progress
  const clinched = clinchedRanksForGroup(groupId);
  return clinched.get(idx + 1) === pid;
}

function hasManualCrossGroupTiebreak() {
  return !!state.crossGroupTiebreak;
}

function hasUnresolvedCrossGroupTie() {
  return !!getCrossGroupTie();
}

function bracketSideLabel(ko, side) {
  const { q } = getQualificationParams();

  // CASE 1: No side object at all
  // This can mean either a real BYE *or* a withheld remainder seed.
  if (!side) {
    // If a cross-group tie is unresolved, this is NOT a real bye
    if (hasUnresolvedCrossGroupTie()) {
      return "TBD";
    }
    return "BYE";
  }

  // CASE 2: We can resolve a concrete participant
  const pid = competitorPid(ko, side);
  if (pid) {
    return participantName(pid);
  }

  // CASE 3: Seed from group, but not resolvable yet
  if (side.groupId && side.rank) {
    // Remainder seed blocked by cross-group tie
    if (hasUnresolvedCrossGroupTie() && side.rank > q) {
      return "TBD";
    }
    return seedLabel(side);
  }

  // CASE 4: Waiting on earlier match
  if (side.fromMatchId) {
    return "TBD";
  }

  return "TBD";
}

/* -----------------------------
   State
----------------------------- */

function defaultState() {
  return {
    participants: [], // {id, name}
    groupCount: 0,
    qualifierCount: 0,

    groups: [], // {id, name, memberIds: []}
    groupMatches: [], // {id, groupId, aId, bId, winnerId}

    // knockout is derived from groups+results:
    // {
    //   seeds: [ { groupId, rank } ... ],
    //   rounds: [ [ {id,aSeed,bSeed,winnerPid} ] ... ]
    // }
    knockout: null,

    // null unless a cross-group tiebreak is active
    crossGroupTiebreak: null
    // {
    //   candidatePids: [...],
    //   resolvedOrder: [...], // ordered list
    //   places: m
    // }
  };
}

let state = loadState() ?? defaultState();
let ui = {
  activeGroupId: null,     // which group has the tiebreak panel open
  mode: null,              // "manual"
  manualOrder: [],         // array of pids (current ordering)
  crossPlaces: 0,
  crossCandidates: [],
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function resetState() {
  state = defaultState();
  saveState();
  renderAll();
}

/* -----------------------------
   Lookups
----------------------------- */

function participantName(pid) {
  return state.participants.find((p) => p.id === pid)?.name ?? "TBD";
}

function groupName(gid) {
  return state.groups.find((g) => g.id === gid)?.name ?? "Group ?";
}

/* -----------------------------
   Group completion + standings
----------------------------- */

function matchesForGroup(groupId) {
  return state.groupMatches.filter((m) => m.groupId === groupId);
}

function isGroupDecided(groupId) {
  const ms = matchesForGroup(groupId);
  if (ms.length === 0) return false;
  return ms.every((m) => !!m.winnerId);
}

function computeStandingsByGroup() {
  // Map(groupId => Map(pid => {wins, losses}))
  const standings = new Map();

  for (const g of state.groups) {
    const m = new Map();
    for (const pid of g.memberIds) m.set(pid, { wins: 0, losses: 0 });
    standings.set(g.id, m);
  }

  for (const match of state.groupMatches) {
    if (!match.winnerId) continue;
    const groupMap = standings.get(match.groupId);
    if (!groupMap) continue;

    const loserId = match.winnerId === match.aId ? match.bId : match.aId;

    if (groupMap.has(match.winnerId)) groupMap.get(match.winnerId).wins += 1;
    if (groupMap.has(loserId)) groupMap.get(loserId).losses += 1;
  }

  return standings;
}

function groupRanking(groupId) {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return [];

  const standings = computeStandingsByGroup().get(groupId) ?? new Map();

  const rows = g.memberIds.map((pid) => {
    const s = standings.get(pid) ?? { wins: 0, losses: 0 };
    return {
      pid,
      name: participantName(pid),
      wins: s.wins,
      losses: s.losses,
      points: s.wins
    };
  });

  // Sort: points desc,H2H,  wins desc, losses asc, name
  rows.sort((a, b) => {
    // Primary: points
    if (b.points !== a.points) return b.points - a.points;

    // Head-to-head (only meaningful if both have same points)
    const h2h = headToHeadWinner(a.pid, b.pid, groupId);
    if (h2h === a.pid) return -1;
    if (h2h === b.pid) return 1;

    // Fallbacks
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;

    return a.name.localeCompare(b.name);
  });

  // Apply stored tiebreak override to tied participants
  if (g.tiebreak?.resolvedOrder?.length) {
    const order = new Map(
      g.tiebreak.resolvedOrder.map((pid, i) => [pid, i])
    );

    rows.sort((a, b) => {
      const ia = order.get(a.pid);
      const ib = order.get(b.pid);

      // Only affects participants included in resolvedOrder
      if (ia != null && ib != null) return ia - ib;
      if (ia != null) return -1;
      if (ib != null) return 1;
      return 0;
    });
  }

  return rows;
}

/**
 * For a group, compute remaining matches per player.
 */
function remainingMatchesByPlayer(groupId) {
  const g = state.groups.find(x => x.id === groupId);
  if (!g) return new Map();

  const remaining = new Map();
  g.memberIds.forEach(pid => remaining.set(pid, 0));

  const matches = state.groupMatches.filter(m => m.groupId === groupId);
  for (const m of matches) {
    if (!m.winnerId) {
      remaining.set(m.aId, remaining.get(m.aId) + 1);
      remaining.set(m.bId, remaining.get(m.bId) + 1);
    }
  }
  return remaining;
}

/**
 * Returns a Set of participant IDs who are GUARANTEED
 * to make the knockout stage, regardless of remaining group matches.
 */
function clinchedQualifiers() {
  const totalSlots = Math.min(state.qualifierCount, state.participants.length);
  if (!state.groups.length) return new Set();

  const standingsByGroup = computeStandingsByGroup();
  const remainingByGroup = new Map(
    state.groups.map(g => [g.id, remainingMatchesByPlayer(g.id)])
  );

  // Build player records
  const players = [];
  for (const g of state.groups) {
    const standings = standingsByGroup.get(g.id);
    const remaining = remainingByGroup.get(g.id);

    for (const pid of g.memberIds) {
      const wins = standings.get(pid).wins;
      const remainingMatches = remaining.get(pid);
      players.push({
        pid,
        wins,
        maxWins: wins + remainingMatches
      });
    }
  }

  const qualified = new Set();

  for (const candidate of players) {
    // Worst case: candidate stays at current wins
    const candidateWorstWins = candidate.wins;

    // Count how many players could finish STRICTLY above candidate
    let couldFinishAbove = 0;

    for (const other of players) {
      if (other === candidate) continue;

      // In worst case, other overtakes candidate
      if (other.maxWins > candidateWorstWins) {
        couldFinishAbove++;
      }
    }

    if (couldFinishAbove < totalSlots) {
      qualified.add(candidate.pid);
    }
  }

  return qualified;
}

function clinchedQualifiersExcludingBoundaryTies() {
  const qualified = clinchedQualifiers(); // your existing function that returns Set(pid)

  // If a group is decided and has a boundary-tie, nobody in that tie can be clinched.
  for (const g of state.groups) {
    if (!isGroupDecided(g.id)) continue;
    const tied = tiedAtQualificationBoundaries(g.id);
    for (const pid of tied) qualified.delete(pid);
  }
  return qualified;
}

/**
 * Determine which ranks in a group are clinched.
 * Returns: Map(rank -> pid)
 */
function clinchedRanksForGroup(groupId) {
  const ranking = groupRanking(groupId);
  if (ranking.length === 0) return new Map();

  const remaining = remainingMatchesByPlayer(groupId);
  const clinched = new Map();

  // Precompute max possible wins for each player
  const maxWins = new Map();
  ranking.forEach(r => {
    const rem = remaining.get(r.pid) ?? 0;
    maxWins.set(r.pid, r.wins + rem);
  });

  // For each rank position r (1-based)
  for (let i = 0; i < ranking.length; i++) {
    const current = ranking[i];
    const targetRank = i + 1;

    let canBePassed = false;

    // Anyone below this rank who could still surpass?
    for (let j = i + 1; j < ranking.length; j++) {
      const challenger = ranking[j];

      // Challenger can surpass or tie?
      if (maxWins.get(challenger.pid) >= current.wins) {
        canBePassed = true;
        break;
      }
    }

    if (!canBePassed) {
      clinched.set(targetRank, current.pid);
    } else {
      // Once a rank is not clinched, lower ranks cannot be clinched either
      break;
    }
  }

  return clinched;
}

/**
 * Returns the winner pid if there is a decided head-to-head match
 * between a and b in the same group. Otherwise null.
 */
function headToHeadWinner(aPid, bPid, groupId) {
  const match = state.groupMatches.find(
    (m) =>
      m.groupId === groupId &&
      ((m.aId === aPid && m.bId === bPid) ||
       (m.aId === bPid && m.bId === aPid))
  );

  return match?.winnerId ?? null;
}

/* -----------------------------
   Seeds (Total qualifiers across groups: A)
----------------------------- */

/**
 * Returns seed refs in pick order:
 * #1 from each group, then #2 from each group, etc. until total qualifiers filled.
 * seedRef = { groupId, rank } where rank starts at 1.
 */
function computeSeedRefsTotal() {
  const { q, r } = getQualificationParams();
  if (!state.groups.length) return [];

  const seeds = [];

  //
  // 1) Guaranteed qualifiers: ranks 1..q from every group
  //
  for (const g of state.groups) {
    const ranking = groupRanking(g.id);
    for (let rank = 1; rank <= q && rank <= ranking.length; rank++) {
      seeds.push({ groupId: g.id, rank });
    }
  }

  //
  // 2) Remainder spots (rank q+1), possibly resolved manually
  //
  if (r > 0) {
    // ✅ Manual cross-group resolution exists
    if (
      state.crossGroupTiebreak &&
      state.crossGroupTiebreak.places === r
    ) {
      const chosen = state.crossGroupTiebreak.resolvedOrder.slice(0, r);

      for (const pid of chosen) {
        const g = state.groups.find(gr => gr.memberIds.includes(pid));
        if (g) {
          seeds.push({ groupId: g.id, rank: q + 1 });
        }
      }

      return seeds;
    }

    // 2) Remainder spots (rank q+1)
    if (r > 0) {
      const crossTie = getCrossGroupTie();

      // ✅ Case A: manual resolution exists → use it
      if (
        state.crossGroupTiebreak &&
        state.crossGroupTiebreak.places === r
      ) {
        const chosen = state.crossGroupTiebreak.resolvedOrder.slice(0, r);

        for (const pid of chosen) {
          const g = state.groups.find(gr => gr.memberIds.includes(pid));
          if (g) seeds.push({ groupId: g.id, rank: q + 1 });
        }
      }

      // ✅ Case B: no tie exists → safe to auto-select
      else if (!crossTie) {
        const candidates = [];

        for (const g of state.groups) {
          const ranking = groupRanking(g.id);
          if (ranking.length >= q + 1) {
            const row = ranking[q];
            candidates.push({
              groupId: g.id,
              pid: row.pid,
              wins: row.points
            });
          }
        }

        candidates.sort((a, b) => b.wins - a.wins);

        for (const c of candidates.slice(0, r)) {
          seeds.push({ groupId: c.groupId, rank: q + 1 });
        }
      }

      // ❌ Case C: cross-group tie exists but unresolved
      // → DO NOTHING (leave remainder spots empty)
    }
  }

  return seeds;
}

function seedLabel(seedRef) {
  return `#${seedRef.rank} ${groupName(seedRef.groupId)}`;
}

/**
 * Resolve a seedRef to a participant id ONLY if that rank is clinched.
 * Otherwise return null (so bracket shows seed label).
 */
function resolveSeedPid(seedRef) {
  if (!seedRef) return null;

  const { groupId, rank } = seedRef;
  const g = state.groups.find(gr => gr.id === groupId);
  if (!g) return null;

  const ranking = groupRanking(groupId);
  const idx = rank - 1;

  if (idx < 0 || idx >= ranking.length) return null;

  // ✅ FINAL: if group decided and no boundary tie, ranking is authoritative
  if (
    isGroupDecided(groupId) &&
    tiedAtQualificationBoundaries(groupId).size === 0
  ) {
    return ranking[idx].pid;
  }

  // ✅ Otherwise fall back to early-clinch logic
  const clinched = clinchedRanksForGroup(groupId);
  return clinched.get(rank) ?? null;
}


/* -----------------------------
   Knockout creation + propagation
----------------------------- */

function buildKnockoutFromSeeds(seeds) {
  const bracketSize = nextPowerOfTwo(seeds.length);
  const byes = bracketSize - seeds.length;
  const slots = [...seeds, ...Array(byes).fill(null)];

  // First round: i vs (end-i)
  const firstRound = [];
  for (let i = 0; i < bracketSize / 2; i++) {
    const aSeed = slots[i];
    const bSeed = slots[bracketSize - 1 - i];

    // winnerPid stays null until both resolved and user picks
    // NOTE: If a side is a bye (null seed), it effectively auto-advances once the other side resolves.
    firstRound.push({
      id: uid(),
      aSeed,
      bSeed,
      winnerPid: null
    });
  }

  // Pre-create later rounds as empty
  const rounds = [firstRound];
  let matches = firstRound.length;
  while (matches > 1) {
    matches = matches / 2;
    rounds.push(
      Array.from({ length: matches }, () => ({
        id: uid(),
        aSeed: null,
        bSeed: null,
        winnerPid: null
      }))
    );
  }

  const ko = { seeds, rounds };
  propagateKnockoutWinners(ko);
  return ko;
}

/**
 * Derive competitor PIDs for a match (a/b):
 * - If aSeed/bSeed is a seedRef: resolve it to PID if group decided
 * - If aSeed/bSeed is a special object: { fromMatchId } (winner flows from previous)
 */
function competitorPid(ko, side) {
  if (!side) return null;

  // seedRef: {groupId, rank}
  if (side.groupId && side.rank) {
    return resolveSeedPid(side);
  }

  // fromMatch: {fromMatchId:"..."}
  if (side.fromMatchId) {
    const found = findMatchById(ko, side.fromMatchId);
    return found?.winnerPid ?? null;
  }

  return null;
}

function findMatchById(ko, matchId) {
  for (const rnd of ko.rounds) {
    for (const m of rnd) {
      if (m.id === matchId) return m;
    }
  }
  return null;
}

function propagateKnockoutWinners(ko) {
  // Fill later rounds with "fromMatchId" pointers
  for (let r = 1; r < ko.rounds.length; r++) {
    const prev = ko.rounds[r - 1];
    const cur = ko.rounds[r];

    for (let i = 0; i < cur.length; i++) {
      const srcA = prev[i * 2];
      const srcB = prev[i * 2 + 1];

      cur[i].aSeed = srcA ? { fromMatchId: srcA.id } : null;
      cur[i].bSeed = srcB ? { fromMatchId: srcB.id } : null;
      cur[i].winnerPid = null;
    }
  }

  // ✅ IMPORTANT CHANGE:
  // Do NOT auto-advance if a cross-group tie is unresolved
  if (hasUnresolvedCrossGroupTie()) {
    return;
  }

  // Otherwise, allow auto-advance for real byes
  const first = ko.rounds[0];
  for (const m of first) {
    const aPid = competitorPid(ko, m.aSeed);
    const bPid = competitorPid(ko, m.bSeed);

    if (aPid && !bPid) {
      m.winnerPid = aPid;
    } else if (!aPid && bPid) {
      m.winnerPid = bPid;
    }
  }
}

/**
 * Rebuild knockout entirely (auto-update), preserving winners only when still valid.
 * This is called whenever group results change.
 */
function rebuildKnockoutAuto() {
  if (!state.groups.length) {
    state.knockout = null;
    return;
  }

  const seeds = computeSeedRefsTotal();
  const old = state.knockout;
  const fresh = buildKnockoutFromSeeds(seeds);

  // Try to preserve first-round winner selections when the competitors are unchanged
  if (old && old.rounds && old.rounds[0] && fresh.rounds[0]) {
    const oldFirst = old.rounds[0];
    const freshFirst = fresh.rounds[0];

    const oldByKey = new Map();
    for (const m of oldFirst) {
      const key = matchupKey(old, m);
      oldByKey.set(key, m.winnerPid ?? null);
    }

    for (const m of freshFirst) {
      const key = matchupKey(fresh, m);
      const oldWinner = oldByKey.get(key);
      if (oldWinner) {
        const aPid = competitorPid(fresh, m.aSeed);
        const bPid = competitorPid(fresh, m.bSeed);
        if (oldWinner === aPid || oldWinner === bPid) {
          m.winnerPid = oldWinner;
        }
      }
    }
  }

  propagateKnockoutWinners(fresh);
  state.knockout = fresh;
}

function matchupKey(ko, match) {
  // Stable key based on seed labels (not participant names)
  const a = match.aSeed ? seedOrFlowLabel(ko, match.aSeed) : "BYE";
  const b = match.bSeed ? seedOrFlowLabel(ko, match.bSeed) : "BYE";
  return `${a}__vs__${b}`;
}

function seedOrFlowLabel(ko, side) {
  return bracketSideLabel(ko, side);
}

/* -----------------------------
   Actions (Workflow)
----------------------------- */

function buildParticipants() {
  const n = clampInt($("participantCount")?.value ?? 8, 2, 256);
  const g = clampInt($("groupCount")?.value ?? 2, 1, 64);
  const q = clampInt($("qualifierCount")?.value ?? 4, 2, n);

  state.groupCount = g;
  state.qualifierCount = Math.min(q, n);

  state.participants = Array.from({ length: n }, (_, i) => ({
    id: uid(),
    name: String(i + 1)
  }));

  state.groups = [];
  state.groupMatches = [];
  state.knockout = null;

  saveState();
  renderAll();

  $("participantEditor")?.classList.remove("hidden");
}

/**
 * NEW WORKFLOW:
 * Randomize Groups => auto create group matches => auto build bracket
 */
function randomizeGroupsAndAutoBuild() {
  if (!state.participants.length) return;

  const gCount = Math.max(1, state.groupCount);
  const ids = shuffle(state.participants.map((p) => p.id));

  state.groups = Array.from({ length: gCount }, (_, i) => ({
    id: uid(),
    name: `Group ${String.fromCharCode(65 + i)}`,
    memberIds: [],
    tiebreak: null
  }));

  ids.forEach((pid, idx) => {
    state.groups[idx % gCount].memberIds.push(pid);
  });

  // Auto create matches
  state.groupMatches = createMatchesForAllGroups();

  // Auto build bracket
  rebuildKnockoutAuto();

  saveState();
  renderAll();
}

function createMatchesForAllGroups() {
  const matches = [];
  for (const g of state.groups) {
    const ids = g.memberIds;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        matches.push({
          id: uid(),
          groupId: g.id,
          aId: ids[i],
          bId: ids[j],
          winnerId: null
        });
      }
    }
  }
  return matches;
}

// Optional legacy buttons (if still in your UI)
function recreateMatchesOnly() {
  if (!state.groups.length) return;
  state.groupMatches = createMatchesForAllGroups();
  rebuildKnockoutAuto();
  saveState();
  renderAll();
}

function rebuildBracketOnly() {
  rebuildKnockoutAuto();
  saveState();
  renderAll();
}

/* -----------------------------
   Rendering
   ----------------------------- */
function openCrossGroupManualTiebreak(candidatePids, places) {
  ui.activeGroupId = CROSS_UI_ID;
  ui.mode = "manual";
  ui.manualOrder = [...candidatePids];
  ui.crossPlaces = places;
  ui.crossCandidates = [...candidatePids];
  renderAll();
}

function applyCrossGroupManualTiebreak() {
  state.crossGroupTiebreak = {
    candidatePids: [...ui.crossCandidates],
    resolvedOrder: [...ui.manualOrder],
    places: ui.crossPlaces
  };

  rebuildKnockoutAuto(); // IMPORTANT
  saveState();
  ui.activeGroupId = null;
  ui.mode = null;
  ui.manualOrder = [];
  ui.crossPlaces = 0;
  ui.crossCandidates = [];
  renderAll();
}

function clearCrossGroupTiebreak() {
  state.crossGroupTiebreak = null;

  rebuildKnockoutAuto();
  saveState();
  renderAll();
}

function openManualTiebreak(groupId, tiedSet) {
  // Initialize order in current ranking order (more intuitive than random)
  const ranking = groupRanking(groupId);
  const tied = new Set(tiedSet);
  const ordered = ranking.filter(r => tied.has(r.pid)).map(r => r.pid);

  ui.activeGroupId = groupId;
  ui.mode = "manual";
  ui.manualOrder = ordered;

  renderAll();
}

function closeTiebreakPanel() {
  ui.activeGroupId = null;
  ui.mode = null;
  ui.manualOrder = [];
  renderAll();
}

function moveInManualOrder(index, delta) {
  const j = index + delta;
  if (j < 0 || j >= ui.manualOrder.length) return;

  const arr = [...ui.manualOrder];
  [arr[index], arr[j]] = [arr[j], arr[index]];
  ui.manualOrder = arr;

  renderAll();
}

function renderManualTiebreakPanel(group) {
  const panel = document.createElement("div");
  panel.className = "tiebreak-panel";

  const title = document.createElement("p");
  title.className = "muted";
  title.textContent = "Manual tiebreak: order the tied teams (top wins the tie).";
  panel.appendChild(title);

  const list = document.createElement("div");
  list.className = "tiebreak-list";

  ui.manualOrder.forEach((pid, idx) => {
    const row = document.createElement("div");
    row.className = "tiebreak-row";

    const name = document.createElement("div");
    name.className = "tiebreak-name";
    name.textContent = participantName(pid);

    const controls = document.createElement("div");
    controls.className = "tiebreak-row-controls";

    const up = document.createElement("button");
    up.className = "secondary";
    up.textContent = "↑";
    up.disabled = idx === 0;
    up.onclick = () => moveInManualOrder(idx, -1);

    const down = document.createElement("button");
    down.className = "secondary";
    down.textContent = "↓";
    down.disabled = idx === ui.manualOrder.length - 1;
    down.onclick = () => moveInManualOrder(idx, +1);

    controls.appendChild(up);
    controls.appendChild(down);

    row.appendChild(name);
    row.appendChild(controls);
    list.appendChild(row);
  });

  panel.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "row";

  const save = document.createElement("button");
  save.textContent = "Save tiebreak";
  save.onclick = () => {
    applyManualTiebreakToGroup(group.id, ui.manualOrder);
    closeTiebreakPanel();
  };

  const cancel = document.createElement("button");
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  cancel.onclick = closeTiebreakPanel;

  actions.appendChild(save);
  actions.appendChild(cancel);

  panel.appendChild(actions);

  return panel;
}

function renderManualCrossGroupPanel() {
  const panel = document.createElement("div");
  panel.className = "tiebreak-panel";

  const title = document.createElement("p");
  title.className = "muted";
  title.textContent = `Cross-group tiebreak: order tied teams (top ${ui.crossPlaces} qualify).`;
  panel.appendChild(title);

  const list = document.createElement("div");
  list.className = "tiebreak-list";

  ui.manualOrder.forEach((pid, idx) => {
    const row = document.createElement("div");
    row.className = "tiebreak-row";

    const name = document.createElement("div");
    name.className = "tiebreak-name";
    const g = state.groups.find(gr => gr.memberIds.includes(pid));
    name.textContent = `${participantName(pid)} (${g ? g.name : "?"})`;

    const controls = document.createElement("div");
    controls.className = "tiebreak-row-controls";

    const up = document.createElement("button");
    up.className = "secondary";
    up.textContent = "↑";
    up.disabled = idx === 0;
    up.onclick = () => moveInManualOrder(idx, -1);

    const down = document.createElement("button");
    down.className = "secondary";
    down.textContent = "↓";
    down.disabled = idx === ui.manualOrder.length - 1;
    down.onclick = () => moveInManualOrder(idx, +1);

    controls.appendChild(up);
    controls.appendChild(down);

    row.appendChild(name);
    row.appendChild(controls);
    list.appendChild(row);
  });

  panel.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "row";

  const save = document.createElement("button");
  save.textContent = "Save cross-group tiebreak";
  save.onclick = applyCrossGroupManualTiebreak;

  const cancel = document.createElement("button");
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  cancel.onclick = () => {
    ui.activeGroupId = null;
    ui.mode = null;
    ui.manualOrder = [];
    ui.crossPlaces = 0;
    ui.crossCandidates = [];
    renderAll();
  };

  actions.appendChild(save);
  actions.appendChild(cancel);
  panel.appendChild(actions);

  return panel;
}

function renderGroupTiebreakControls(group, tiedSet) {
  const container = document.createElement("div");
  container.className = "tiebreak-controls";

  const heading = document.createElement("p");
  heading.className = "muted";
  heading.textContent = "Tie at qualification boundary needs resolution:";
  container.appendChild(heading);

  const btnManual = document.createElement("button");
  btnManual.textContent = "Resolve manually";
  btnManual.onclick = () => openManualTiebreak(group.id, tiedSet);

  const row = document.createElement("div");
  row.className = "row";
  row.appendChild(btnManual);

  container.appendChild(row);

  return container;
}

function renderParticipantEditor() {
  const wrap = $("participantInputs");
  const editor = $("participantEditor");
  if (!wrap || !editor) return;

  if (!state.participants.length) {
    wrap.innerHTML = "";
    editor.classList.add("hidden");
    return;
  }

  wrap.innerHTML = "";

  state.participants.forEach((p, idx) => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "10px";
    row.style.margin = "6px 0";

    const label = document.createElement("label");
    label.style.flex = "1";
    label.style.display = "flex";
    label.style.flexDirection = "column";
    label.style.gap = "6px";
    label.textContent = `Participant ${idx + 1}`;

    const input = document.createElement("input");
    input.value = p.name;
    input.placeholder = String(idx + 1);

    input.addEventListener("input", (e) => {
      const v = String(e.target.value ?? "").trim();
      p.name = v.length ? v : String(idx + 1);
      saveState();
      // Names affect multiple views
      renderGroups();
      renderGroupMatches();
      renderKnockout();
      renderQualifiers();
    });

    label.appendChild(input);
    row.appendChild(label);
    wrap.appendChild(row);
  });
}

function renderGroups() {
  const host = $("groupsView");
  if (!host) return;

  if (!state.groups.length) {
    host.className = "stack muted";
    host.textContent = "No groups yet.";
    return;
  }

  host.className = "stack";
  host.innerHTML = "";

  for (const g of state.groups) {
    const el = document.createElement("div");
    el.className = "group";

    const title = document.createElement("h3");
    title.textContent = g.name;
    el.appendChild(title);

    const pills = document.createElement("div");
    pills.className = "pills";
    g.memberIds.forEach((pid) => {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = participantName(pid);
      pills.appendChild(pill);
    });
    el.appendChild(pills);

    const status = groupStatus(g.id);
    const badge = document.createElement("p");
    badge.className = "muted";

    if (status === "decided") {
      badge.textContent = "✅ Group decided";
    } else if (status === "undecided-tie") {
      badge.textContent = "⚠️ Group undecided (tie at qualification boundary)";
    } else {
      badge.textContent = "Group in progress…";
    }
    el.appendChild(badge);

    const tiedSet = tiedAtQualificationBoundaries(g.id);
    const ranking = groupRanking(g.id);
    const boundaryTied = allBoundaryTiedPids();
    const table = document.createElement("table");
    table.className = "table";
    table.innerHTML = `
      <thead>
        <tr><th>Rank</th><th>Player</th><th>W</th><th>L</th><th>Pts</th></tr>
      </thead>
      <tbody>
        ${ranking.map((r, i) => {
          const rank = i + 1;
          const isQualified = isGuaranteedFromGroup(g.id, r.pid);
          const isTied = tiedSet.has(r.pid);
          const marker = isTied ? " ⚠️" : (isQualified ? " ✅" : "");
          return `
            <tr class="${isTied ? "tie-boundary" : ""}">
	      <td>${rank}${marker}</td>
              <td>${escapeHtml(r.name)}</td>
              <td>${r.wins}</td>
              <td>${r.losses}</td>
              <td>${r.points}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    `;
    el.appendChild(table);

    // Show tiebreak resolution controls only when needed
    const needsResolution = isGroupDecided(g.id) && tiedSet.size > 0 && !g.tiebreak;

    if (needsResolution) {
      const controls = renderGroupTiebreakControls(g, tiedSet);
      el.appendChild(controls);
    }
    if (ui.activeGroupId === g.id) {
      if (ui.mode === "manual") {
        el.appendChild(renderManualTiebreakPanel(g));
      }
    }

    if (g.tiebreak) {
      const tb = document.createElement("div");
      tb.className = "tiebreak-controls";

      const msg = document.createElement("p");
      msg.className = "muted";
      msg.textContent = `Tiebreak applied (${g.tiebreak.type}).`;
      tb.appendChild(msg);

      const row = document.createElement("div");
      row.className = "row";

      const clear = document.createElement("button");
      clear.className = "secondary";
      clear.textContent = "Clear tiebreak";
      clear.onclick = () => clearGroupTiebreak(g.id);

      row.appendChild(clear);
      tb.appendChild(row);

      el.appendChild(tb);
    }

    host.appendChild(el);
  }
}

function renderGroupMatches() {
  const host = $("groupMatchesView");
  if (!host) return;

  if (!state.groupMatches.length) {
    host.className = "stack muted";
    host.textContent = "No matches yet.";
    return;
  }

  host.className = "stack";
  host.innerHTML = "";

  for (const g of state.groups) {
    const wrap = document.createElement("div");
    wrap.className = "group matches-grid";
    wrap.innerHTML = `<h3 class="group-matches-heading">${escapeHtml(g.name)} matches</h3>`;

    const matches = state.groupMatches.filter((m) => m.groupId === g.id);

    matches.forEach((m) => {
      const row = document.createElement("div");
      row.className = "match";

      const names = document.createElement("div");
      names.className = "names";
      const aName = participantName(m.aId);
      const bName = participantName(m.bId);
      names.innerHTML = `<strong>${escapeHtml(aName)}</strong> <span class="vs">vs</span> <strong>${escapeHtml(bName)}</strong>`;
      row.appendChild(names);

      const select = document.createElement("select");
      select.appendChild(new Option("Winner…", ""));
      select.appendChild(new Option(aName, m.aId));
      select.appendChild(new Option(bName, m.bId));
      select.value = m.winnerId ?? "";

      select.addEventListener("change", (e) => {
        const val = String(e.target.value || "");
        m.winnerId = val ? val : null;

        // AUTO UPDATE BRACKET ON EVERY GROUP RESULT CHANGE
        rebuildKnockoutAuto();

        saveState();
        renderGroups();       // standings update
        renderQualifiers();   // qualifiers/seed refs update
        renderKnockout();     // bracket update
        renderButtons();
      });

      row.appendChild(select);
      wrap.appendChild(row);
    });

    host.appendChild(wrap);
  }
}

function renderQualifiers() {
  const qHost = $("qualifiersView");
  if (!qHost) return;

  if (!state.groups.length) {
    qHost.className = "stack muted";
    qHost.textContent = "No qualifiers yet.";
    return;
  }

  const total = Math.min(state.qualifierCount, state.participants.length);
  const seeds = computeSeedRefsTotal();

  qHost.className = "stack";
  qHost.innerHTML = `
    <div class="subcard">
      <h3>Qualifiers (total ${total})</h3>
      <div class="pills">
        ${seeds.map((s) => {
          const pid = resolveSeedPid(s);
          const txt = pid ? `${seedLabel(s)} → ${participantName(pid)}` : seedLabel(s);
          return `<span class="pill">${escapeHtml(txt)}</span>`;
        }).join("")}
      </div>
      <p class="muted">
        Bracket uses seed labels until a group is decided (all match winners set for that group).
      </p>
    </div>
  `;
  const cross = getCrossGroupTie();

  // CASE 1: Cross-group tiebreak already resolved manually
  if (hasManualCrossGroupTiebreak()) {
    const card = document.createElement("div");
    card.className = "tiebreak-panel";

    const msg = document.createElement("p");
    msg.className = "muted";
    msg.textContent =
      "Cross-group qualification tie resolved manually.";
    card.appendChild(msg);

    const details = document.createElement("p");
    details.textContent =
      "Qualified (in order): " +
      state.crossGroupTiebreak.resolvedOrder
        .slice(0, state.crossGroupTiebreak.places)
        .map(pid => participantName(pid))
        .join(", ");
    card.appendChild(details);

    const row = document.createElement("div");
    row.className = "row";

    const clearBtn = document.createElement("button");
    clearBtn.className = "secondary";
    clearBtn.textContent = "Clear cross-group tiebreak";
    clearBtn.onclick = clearCrossGroupTiebreak;

    row.appendChild(clearBtn);
    card.appendChild(row);

    qHost.appendChild(card);
  }

  // CASE 2: Cross-group tie exists and needs resolution
  else if (cross) {
    const card = document.createElement("div");
    card.className = "tiebreak-panel";

    const msg = document.createElement("p");
    msg.className = "muted";
    msg.textContent =
      `Cross-group tie for the last ${cross.places} qualification spot(s).`;
    card.appendChild(msg);

    const btn = document.createElement("button");
    btn.textContent = "Resolve cross-group tie manually";
    btn.onclick = () =>
      openCrossGroupManualTiebreak(cross.candidatePids, cross.places);

    card.appendChild(btn);
    qHost.appendChild(card);
  }

  // CASE 3: Manual cross-group panel currently open
  if (ui.activeGroupId === "__cross__" && ui.mode === "manual") {
    qHost.appendChild(renderManualCrossGroupPanel());
  }
}

function renderKnockout() {
  const bHost = $("bracketView");
  if (!bHost) return;

  if (!state.knockout) {
    bHost.className = "stack muted";
    bHost.textContent = "No bracket yet. Randomize groups to auto-create it.";
    return;
  }

  // Keep propagation current
  propagateKnockoutWinners(state.knockout);

  bHost.className = "";       // bracketView itself stays a normal container
  bHost.innerHTML = "";

  // Canvas holds both SVG lines and the bracket columns so they scroll together
  const canvas = document.createElement("div");
  canvas.className = "bracket-canvas";
  canvas.id = "bracketCanvas";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("bracket-lines");

  const grid = document.createElement("div");
  grid.className = "bracket-classic";

  // order matters: svg behind, grid in front
  canvas.appendChild(svg);
  canvas.appendChild(grid);
  bHost.appendChild(canvas);

  state.knockout.rounds.forEach((round, rIdx) => {
    const col = document.createElement("div");
    col.className = "bracket-round";
    col.dataset.round = String(rIdx);

    col.innerHTML = `<h3 class="bracket-round-heading">Round ${rIdx + 1}</h3>`;

    const matchesWrap = document.createElement("div");
    matchesWrap.className = "round-matches";
    matchesWrap.dataset.round = String(rIdx);

    round.forEach((m, i) => {
      const row = document.createElement("div");
      row.className = "match";
      row.dataset.matchId = m.id;
      row.dataset.matchIndex = String(i);

      const aLabel = seedOrFlowLabel(state.knockout, m.aSeed);
      const bLabel = seedOrFlowLabel(state.knockout, m.bSeed);

      const aPid = competitorPid(state.knockout, m.aSeed);
      const bPid = competitorPid(state.knockout, m.bSeed);

      const names = document.createElement("div");
      names.className = "names";
      names.innerHTML = `
        <strong>${escapeHtml(aLabel)}</strong>
        <span class="vs">vs</span>
        <strong>${escapeHtml(bLabel)}</strong>
      `;
      row.appendChild(names);

      // const sub = document.createElement("div");
      // sub.className = "muted";
      // sub.style.fontSize = "12px";
      // sub.textContent =
      //   aPid || bPid
      //     ? `${aPid ? participantName(aPid) : "TBD"} vs ${bPid ? participantName(bPid) : "TBD"}`
      //     : "Participants TBD";
      // row.appendChild(sub);

      const select = document.createElement("select");
      select.appendChild(new Option("Winner…", ""));
      if (aPid) select.appendChild(new Option(participantName(aPid), aPid));
      if (bPid) select.appendChild(new Option(participantName(bPid), bPid));

      select.disabled = !(aPid && bPid);
      select.value = m.winnerPid ?? "";

      select.addEventListener("change", (e) => {
        m.winnerPid = e.target.value || null;
        propagateKnockoutWinners(state.knockout);
        saveState();
        renderKnockout();
      });

      matchesWrap.appendChild(row);
    });

    col.appendChild(matchesWrap);
    grid.appendChild(col);
  });

  // Champion
  const lastRound = state.knockout.rounds[state.knockout.rounds.length - 1];
  const final = lastRound?.[0];
  if (final?.winnerPid) {
    const champ = document.createElement("div");
    champ.className = "subcard";
    champ.innerHTML = `<h3>🏆 Champion: ${escapeHtml(participantName(final.winnerPid))}</h3>`;
    bHost.appendChild(champ);
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      alignBracketMatches();
      drawBracketConnectors();
    });
  });
}

function renderButtons() {
  const assignBtn = $("assignGroupsBtn");
  const matchesBtn = $("makeMatchesBtn");
  const bracketBtn = $("makeBracketBtn");

  if (assignBtn) assignBtn.disabled = state.participants.length === 0;
}

function renderAll() {
  renderParticipantEditor();
  renderGroups();
  renderGroupMatches();
  renderQualifiers();
  renderKnockout();
  renderButtons();
}

/* -----------------------------
   Event bindings
----------------------------- */

safeOn("resetBtn", "click", resetState);
safeOn("saveBtn", "click", saveState);

safeOn("buildParticipantsBtn", "click", buildParticipants);

// NEW: randomize triggers matches + bracket auto-setup
safeOn("assignGroupsBtn", "click", randomizeGroupsAndAutoBuild);

/* -----------------------------
   Initial render
----------------------------- */

renderAll();
