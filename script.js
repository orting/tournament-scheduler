"use strict";

/**
 * Tournament Builder (Vanilla JS)
 * - Groups (random assignment)
 * - Round-robin group matches (each pair once)
 * - Win/lose results (winner selection)
 * - Standings
 * - Total qualifiers across groups (A): pick #1 from each group, then #2, etc.
 * - Knockout bracket with byes, auto-advancement, winner propagation
 * - localStorage save/load, reset
 * - Bracket becomes "dirty" if group results change after bracket creation
 */

const STORAGE_KEY = "tournament_builder_state_v2";

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

function toggleVisibility(elementId, buttonId, label) {
  const el = document.getElementById(elementId);
  const btn = document.getElementById(buttonId);
  if (!el || !btn) return;

  const isHidden = el.classList.toggle("hidden");
  btn.textContent = `${isHidden ? "Show" : "Hide"} ${label}`;
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
    groupMatches: [], // {id, groupId, aId, bId, winnerId: null}

    knockout: null, // { qualifiedIds: [], rounds: [ [ {id,aId,bId,winnerId} ] ] }
    knockoutDirty: false
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
   Getters
----------------------------- */

function participantName(id) {
  return state.participants.find((p) => p.id === id)?.name ?? "TBD";
}

function isGroupStageComplete() {
  return state.groupMatches.length > 0 && state.groupMatches.every((m) => !!m.winnerId);
}

/* -----------------------------
   Standings / Qualifiers
----------------------------- */

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
      points: s.wins // 1 point per win
    };
  });

  rows.sort((a, b) =>
    (b.points - a.points) ||
    (b.wins - a.wins) ||
    (a.losses - b.losses) ||
    a.name.localeCompare(b.name)
  );

  return rows;
}

/**
 * Total qualifiers across groups (A):
 * Pick in rounds: #1 from each group, then #2 from each group, etc.
 * until qualifierCount is reached.
 */
function computeQualifiersTotal() {
  const total = Math.min(state.qualifierCount, state.participants.length);
  if (!state.groups.length) return [];

  const rankings = state.groups.map((g) => ({
    groupId: g.id,
    groupName: g.name,
    ranking: groupRanking(g.id)
  }));

  const picked = [];
  let rankIndex = 0;

  while (picked.length < total) {
    let pickedSomething = false;

    for (const gr of rankings) {
      const row = gr.ranking[rankIndex];
      if (row && !picked.includes(row.pid)) {
        picked.push(row.pid);
        pickedSomething = true;
        if (picked.length >= total) break;
      }
    }

    if (!pickedSomething) break;
    rankIndex += 1;
  }

  return picked;
}

/* -----------------------------
   Knockout Bracket
----------------------------- */

function findGroupRankInfo(pid) {
  for (const g of state.groups) {
    const r = groupRanking(g.id);
    const idx = r.findIndex((x) => x.pid === pid);
    if (idx >= 0) return { groupId: g.id, rank: idx + 1, wins: r[idx].wins };
  }
  return { groupId: null, rank: 999, wins: 0 };
}

function buildKnockout(qualifiedIds) {
  // Seed: by more wins first, then better group rank
  const seeded = [...qualifiedIds]
    .map((pid) => {
      const info = findGroupRankInfo(pid);
      return { pid, wins: info.wins, rank: info.rank };
    })
    .sort((a, b) => (b.wins - a.wins) || (a.rank - b.rank))
    .map((x) => x.pid);

  const bracketSize = nextPowerOfTwo(seeded.length);
  const byes = bracketSize - seeded.length;
  const slots = [...seeded, ...Array(byes).fill(null)];

  // First round pairing: i vs (end - i)
  const firstRound = [];
  for (let i = 0; i < bracketSize / 2; i++) {
    const a = slots[i];
    const b = slots[bracketSize - 1 - i];

    firstRound.push({
      id: uid(),
      aId: a,
      bId: b,
      // auto-advance if bye
      winnerId: a && !b ? a : (b && !a ? b : null)
    });
  }

  const rounds = [firstRound];

  // Pre-create subsequent rounds (empty, will be filled by propagation)
  let matches = firstRound.length;
  while (matches > 1) {
    matches = matches / 2;
    rounds.push(
      Array.from({ length: matches }, () => ({
        id: uid(),
        aId: null,
        bId: null,
        winnerId: null
      }))
    );
  }

  const ko = { qualifiedIds: seeded, rounds };
  propagateKnockout(ko);
  return ko;
}

function propagateKnockout(ko) {
  // Fill later rounds based on winners of previous rounds
  for (let r = 1; r < ko.rounds.length; r++) {
    const prev = ko.rounds[r - 1];
    const cur = ko.rounds[r];

    for (let i = 0; i < cur.length; i++) {
      const m1 = prev[i * 2];
      const m2 = prev[i * 2 + 1];

      const a = m1?.winnerId ?? null;
      const b = m2?.winnerId ?? null;

      cur[i].aId = a;
      cur[i].bId = b;

      // Auto-advance if one side is present
      if (a && !b) cur[i].winnerId = a;
      else if (b && !a) cur[i].winnerId = b;
      else if (!a && !b) cur[i].winnerId = null;
      else {
        // both present: keep winner if still valid, else clear
        if (cur[i].winnerId !== a && cur[i].winnerId !== b) {
          cur[i].winnerId = null;
        }
      }
    }
  }
}

/* -----------------------------
   Actions (Setup Steps)
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

  // reset downstream
  state.groups = [];
  state.groupMatches = [];
  state.knockout = null;
  state.knockoutDirty = false;

  saveState();
  renderAll();

  // show participant editor if present
  $("participantEditor")?.classList.remove("hidden");
}

function randomizeGroups() {
  if (!state.participants.length) return;

  const gCount = Math.max(1, state.groupCount);
  const ids = shuffle(state.participants.map((p) => p.id));

  state.groups = Array.from({ length: gCount }, (_, i) => ({
    id: uid(),
    name: `Group ${String.fromCharCode(65 + i)}`,
    memberIds: []
  }));

  // deal in round-robin
  ids.forEach((pid, idx) => {
    state.groups[idx % gCount].memberIds.push(pid);
  });

  state.groupMatches = [];
  state.knockout = null;
  state.knockoutDirty = false;

  saveState();
  renderAll();
}

function createGroupMatches() {
  if (!state.groups.length) return;

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

  state.groupMatches = matches;
  state.knockout = null;
  state.knockoutDirty = false;

  saveState();
  renderAll();
}

function createKnockoutBracket() {
  if (!isGroupStageComplete()) return;

  const qualified = computeQualifiersTotal();
  state.knockout = buildKnockout(qualified);
  state.knockoutDirty = false;

  saveState();
  renderAll();
}

function updateKnockoutBracket() {
  if (!isGroupStageComplete()) return;
  if (!state.knockout) return;

  const qualified = computeQualifiersTotal();
  state.knockout = buildKnockout(qualified);
  state.knockoutDirty = false;

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
    editor.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }

  editor.classList.remove("hidden");
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
      renderGroups(); // names affect groups/standings display
      renderGroupMatches(); // names affect match display
      renderQualifiersAndBracket(); // names affect knockout display
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

        // If a bracket already exists, mark it out-of-date (do not auto rebuild)
        if (state.knockout) state.knockoutDirty = true;

        saveState();
        renderGroups(); // standings update
        renderQualifiersAndBracket();
        renderButtons();
      });

      row.appendChild(select);
      wrap.appendChild(row);
    });

    host.appendChild(wrap);
  }
}

function renderQualifiersAndBracket() {
  const qHost = $("qualifiersView");
  const bHost = $("bracketView");
  if (!qHost || !bHost) return;

  if (!state.groupMatches.length) {
    qHost.className = "stack muted";
    qHost.textContent = "No qualifiers yet.";
    bHost.className = "stack muted";
    bHost.textContent = "No bracket yet.";
    return;
  }

  const total = Math.min(state.qualifierCount, state.participants.length);
  const qualified = computeQualifiersTotal();

  qHost.className = "stack";
  qHost.innerHTML = `
    <div class="subcard">
      <h3>Qualifiers (total ${total})</h3>
      <div class="pills">
        ${qualified.map((pid) => `<span class="pill">${escapeHtml(participantName(pid))}</span>`).join("")}
      </div>
      <p class="muted">
        Selection rule: take #1 from each group, then #2 from each group, and so on until filled.
      </p>
      ${isGroupStageComplete()
        ? `<p class="muted">Group stage complete ✅ You can create/update the knockout bracket.</p>`
        : `<p class="muted">Group stage not complete yet — fill in all match winners to create the bracket.</p>`
      }
    </div>
  `;

  if (!state.knockout) {
    bHost.className = "stack muted";
    bHost.textContent = "No bracket yet. Click “Create Knockout Bracket”.";
    return;
  }

  // If bracket exists, keep it propagated for display
  propagateKnockout(state.knockout);

  bHost.className = "stack";
  bHost.innerHTML = "";

  if (state.knockoutDirty) {
    const warn = document.createElement("div");
    warn.className = "subcard";
    warn.innerHTML = `
      <p><strong>Bracket is out of date.</strong> Group results changed. Click <em>Update Bracket</em>.</p>
    `;
    bHost.appendChild(warn);
  }

  state.knockout.rounds.forEach((round, rIdx) => {
    const card = document.createElement("div");
    card.className = "bracket-round";
    card.innerHTML = `<h3>Round ${rIdx + 1}</h3>`;

    round.forEach((m) => {
      const row = document.createElement("div");
      row.className = "match";

      const aName = m.aId ? participantName(m.aId) : "TBD";
      const bName = m.bId ? participantName(m.bId) : "TBD";

      const names = document.createElement("div");
      names.className = "names";
      names.innerHTML = `<strong>${escapeHtml(aName)}</strong> <span class="vs">vs</span> <strong>${escapeHtml(bName)}</strong>`;
      row.appendChild(names);

      const select = document.createElement("select");
      select.appendChild(new Option("Winner…", ""));

      if (m.aId) select.appendChild(new Option(aName, m.aId));
      if (m.bId) select.appendChild(new Option(bName, m.bId));

      // allow selection only when both present; byes auto-advance
      select.disabled = !(m.aId && m.bId);

      // set current winner
      select.value = m.winnerId ?? "";

      select.addEventListener("change", (e) => {
        const val = String(e.target.value || "");
        m.winnerId = val ? val : null;

        propagateKnockout(state.knockout);
        saveState();
        renderQualifiersAndBracket();
      });

      row.appendChild(select);
      card.appendChild(row);
    });

    bHost.appendChild(card);
  });

  // Champion
  const lastRound = state.knockout.rounds[state.knockout.rounds.length - 1];
  const final = lastRound?.[0];
  if (final?.winnerId) {
    const champ = document.createElement("div");
    champ.className = "subcard";
    champ.innerHTML = `<h3>🏆 Champion: ${escapeHtml(participantName(final.winnerId))}</h3>`;
    bHost.appendChild(champ);
  }
}

function renderButtons() {
  const assignBtn = $("assignGroupsBtn");
  const matchesBtn = $("makeMatchesBtn");
  const bracketBtn = $("makeBracketBtn");
  const updateBtn = $("updateBracketBtn");

  if (assignBtn) assignBtn.disabled = state.participants.length === 0;
  if (matchesBtn) matchesBtn.disabled = state.groups.length === 0;

  // Bracket creation should require group stage complete
  if (bracketBtn) bracketBtn.disabled = !isGroupStageComplete();

  // Update button is optional in HTML
  if (updateBtn) updateBtn.disabled = !(state.knockout && state.knockoutDirty && isGroupStageComplete());
}

function renderAll() {
  renderParticipantEditor();
  renderGroups();
  renderGroupMatches();
  renderQualifiersAndBracket();
  renderButtons();
}

/* -----------------------------
   HTML safety (prevent injection in template strings)
----------------------------- */

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* -----------------------------
   Event bindings
----------------------------- */

safeOn("resetBtn", "click", resetState);
safeOn("saveBtn", "click", saveState);

safeOn("buildParticipantsBtn", "click", buildParticipants);
safeOn("assignGroupsBtn", "click", randomizeGroups);
safeOn("makeMatchesBtn", "click", createGroupMatches);

safeOn("makeBracketBtn", "click", createKnockoutBracket);
safeOn("updateBracketBtn", "click", updateKnockoutBracket);

safeOn("toggleParticipantsBtn", "click", () => {
  toggleVisibility("participantEditor", "toggleParticipantsBtn", "Participants");
});

safeOn("toggleGroupsBtn", "click", () => {
  toggleVisibility("groupsView", "toggleGroupsBtn", "Groups");
});

safeOn("toggleBracketBtn", "click", () => {
  toggleVisibility("qualifiersView", "toggleBracketBtn", "Bracket");
  toggleVisibility("bracketView", "toggleBracketBtn", "Bracket");
});

/* --
   Accordion
   -- */
function initAccordions() {
  document.querySelectorAll(".accordion").forEach(acc => {
    const header = acc.querySelector(".accordion-header");
    if (!header) return;

    header.addEventListener("click", () => {
      const isOpen = acc.dataset.open === "true";
      acc.dataset.open = isOpen ? "false" : "true";
    });
  });
}

/* -----------------------------
   Initial render
----------------------------- */

renderAll();
initAccordions()
