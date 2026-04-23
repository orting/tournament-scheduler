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
    knockout: null
  };
}

let state = loadState() ?? defaultState();

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

  // Sort: points desc, wins desc, losses asc, name
  rows.sort((a, b) =>
    (b.points - a.points) ||
    (b.wins - a.wins) ||
    (a.losses - b.losses) ||
    a.name.localeCompare(b.name)
  );

  return rows;
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
  const total = Math.min(state.qualifierCount, state.participants.length);
  if (!state.groups.length) return [];

  const rankings = state.groups.map((g) => ({
    groupId: g.id,
    ranking: groupRanking(g.id)
  }));

  const picked = [];
  let rankIndex = 0;

  while (picked.length < total) {
    let pickedSomething = false;

    for (const gr of rankings) {
      const row = gr.ranking[rankIndex];
      if (row && picked.length < total) {
        picked.push({ groupId: gr.groupId, rank: rankIndex + 1 });
        pickedSomething = true;
      }
    }

    if (!pickedSomething) break;
    rankIndex += 1;
  }

  return picked;
}

function seedLabel(seedRef) {
  return `#${seedRef.rank} ${groupName(seedRef.groupId)}`;
}

/**
 * Resolve a seedRef to a participant id ONLY if the group is decided.
 * Otherwise return null (so bracket shows seed label).
 */
function resolveSeedPid(seedRef) {
  if (!seedRef) return null;
  if (!isGroupDecided(seedRef.groupId)) return null;

  const ranking = groupRanking(seedRef.groupId);
  const row = ranking[seedRef.rank - 1];
  return row ? row.pid : null;
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
      const m1 = prev[i * 2];
      const m2 = prev[i * 2 + 1];

      cur[i].aSeed = { fromMatchId: m1.id };
      cur[i].bSeed = { fromMatchId: m2.id };

      // If current winner is no longer valid, clear it
      const aPid = competitorPid(ko, cur[i].aSeed);
      const bPid = competitorPid(ko, cur[i].bSeed);
      if (cur[i].winnerPid && cur[i].winnerPid !== aPid && cur[i].winnerPid !== bPid) {
        cur[i].winnerPid = null;
      }

      // Auto-advance if exactly one side is known and the other is absent/unknown
      // (This mainly affects bye paths early on)
      if (aPid && !bPid) cur[i].winnerPid = aPid;
      if (bPid && !aPid) cur[i].winnerPid = bPid;
    }
  }

  // Also auto-advance in first round for byes when a competitor becomes known
  const first = ko.rounds[0];
  for (const m of first) {
    const aPid = competitorPid(ko, m.aSeed);
    const bPid = competitorPid(ko, m.bSeed);

    // If one side is a bye (null seed), propagate the known one
    if (m.aSeed && !m.bSeed && aPid) m.winnerPid = aPid;
    if (m.bSeed && !m.aSeed && bPid) m.winnerPid = bPid;

    // If winner exists but no longer matches competitors, clear
    if (m.winnerPid && m.winnerPid !== aPid && m.winnerPid !== bPid) {
      m.winnerPid = null;
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
  if (!side) return "BYE";
  if (side.groupId && side.rank) return seedLabel(side);
  if (side.fromMatchId) return `W(${side.fromMatchId.slice(0, 6)})`;
  return "TBD";
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
    memberIds: []
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

    const decided = isGroupDecided(g.id);
    const badge = document.createElement("p");
    badge.className = "muted";
    badge.textContent = decided ? "Group decided ✅" : "Group in progress…";
    el.appendChild(badge);

    const ranking = groupRanking(g.id);
    const table = document.createElement("table");
    table.className = "table";
    table.innerHTML = `
      <thead>
        <tr><th>Rank</th><th>Player</th><th>W</th><th>L</th><th>Pts</th></tr>
      </thead>
      <tbody>
        ${ranking.map((r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(r.name)}</td>
            <td>${r.wins}</td>
            <td>${r.losses}</td>
            <td>${r.points}</td>
          </tr>
        `).join("")}
      </tbody>
    `;
    el.appendChild(table);

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
    wrap.className = "group";
    wrap.innerHTML = `<h3>${escapeHtml(g.name)} matches</h3>`;

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

  bHost.className = "stack";
  bHost.innerHTML = "";

  state.knockout.rounds.forEach((round, rIdx) => {
    const card = document.createElement("div");
    card.className = "bracket-round";
    card.innerHTML = `<h3>Round ${rIdx + 1}</h3>`;

    round.forEach((m) => {
      const row = document.createElement("div");
      row.className = "match";

      // Display labels (seed-based) by default
      const aLabel = m.aSeed ? seedOrFlowLabel(state.knockout, m.aSeed) : "BYE";
      const bLabel = m.bSeed ? seedOrFlowLabel(state.knockout, m.bSeed) : "BYE";

      const aPid = competitorPid(state.knockout, m.aSeed);
      const bPid = competitorPid(state.knockout, m.bSeed);

      // "Group decided" rule:
      // show real name only if that seed is a real seedRef AND its group is decided,
      // or if it comes from a previous match winner (then show pid name if winner exists)
      const aDisplay = aPid ? participantName(aPid) : null;
      const bDisplay = bPid ? participantName(bPid) : null;

      const names = document.createElement("div");
      names.className = "names";

      // main line: seed/flow labels
      names.innerHTML = `<strong>${escapeHtml(aLabel)}</strong> <span class="vs">vs</span> <strong>${escapeHtml(bLabel)}</strong>`;
      row.appendChild(names);

      // secondary line: actual participants when known
      const sub = document.createElement("div");
      sub.className = "muted";
      sub.style.fontSize = "13px";
      sub.style.marginTop = "6px";
      sub.textContent =
        (aDisplay || bDisplay)
          ? `${aDisplay ?? "TBD"} vs ${bDisplay ?? "TBD"}`
          : "Participants TBD";
      row.appendChild(sub);

      const select = document.createElement("select");
      select.appendChild(new Option("Winner…", ""));

      if (aPid) select.appendChild(new Option(participantName(aPid), aPid));
      if (bPid) select.appendChild(new Option(participantName(bPid), bPid));

      // Enable ONLY when both participants are known
      select.disabled = !(aPid && bPid);

      select.value = m.winnerPid ?? "";

      select.addEventListener("change", (e) => {
        const val = String(e.target.value || "");
        m.winnerPid = val ? val : null;

        propagateKnockoutWinners(state.knockout);

        saveState();
        renderKnockout();
      });

      row.appendChild(select);
      card.appendChild(row);
    });

    bHost.appendChild(card);
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
}

function renderButtons() {
  const assignBtn = $("assignGroupsBtn");
  const matchesBtn = $("makeMatchesBtn");
  const bracketBtn = $("makeBracketBtn");

  if (assignBtn) assignBtn.disabled = state.participants.length === 0;

  // These buttons are now optional / legacy because we auto-build:
  if (matchesBtn) matchesBtn.disabled = state.groups.length === 0;
  if (bracketBtn) bracketBtn.disabled = state.groups.length === 0;
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
