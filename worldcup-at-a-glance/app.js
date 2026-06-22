"use strict";

/*
  WorldCup at a Glance — Reliable Mode v2

  Principles:
  - No hard-coded fixtures.
  - No hard-coded player stats.
  - No manual date corrections.
  - No service worker cache.
  - Display only what the live/fallback data source provides.
*/

const ENDPOINTS = {
  apiGames: "https://worldcup26.ir/api/get/games",
  apiGroups: "https://worldcup26.ir/api/get/groups",
  apiTeams: "https://worldcup26.ir/api/get/teams",
  apiStadiums: "https://worldcup26.ir/api/get/stadiums",
  fallbackMatches: "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/refs/heads/main/football.matches.json",
  fallbackGroups: "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/refs/heads/main/football.matchtables.json",
  fallbackTeams: "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/refs/heads/main/football.teams.json",
  fallbackStadiums: "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/refs/heads/main/football.stadiums.json"
};

const state = {
  matches: [],
  standings: [],
  playerStats: [],
  sourceNotes: [],
  filter: "all",
  search: "",
  group: "all",
  refreshCount: 0,
  lastStatsSignature: ""
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function firstValue(obj, keys, fallback = "") {
  if (!obj || typeof obj !== "object") return fallback;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function unwrapPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["data", "games", "matches", "groups", "teams", "stadiums", "response", "results"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function noCacheUrl(url, token) {
  const u = new URL(url);
  u.searchParams.set("_refresh", token);
  return u.toString();
}

async function fetchJson(url, label, token) {
  const response = await fetch(noCacheUrl(url, token), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });
  if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
  return response.json();
}

async function fetchFirstAvailable(primaryUrl, fallbackUrl, label, token) {
  try {
    const data = await fetchJson(primaryUrl, `${label} API`, token);
    state.sourceNotes.push(`${label}: live API`);
    return data;
  } catch (apiError) {
    console.warn(apiError);
    try {
      const data = await fetchJson(fallbackUrl, `${label} fallback`, token);
      state.sourceNotes.push(`${label}: GitHub fallback`);
      return data;
    } catch (fallbackError) {
      console.warn(fallbackError);
      state.sourceNotes.push(`${label}: unavailable`);
      return [];
    }
  }
}

function parseDateFlexible(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number") {
    const d = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  const dmY = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmY) {
    const [, dd, mm, yyyy, hh = "0", min = "0", ss = "0"] = dmY;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function normalizeTeam(value) {
  if (value && typeof value === "object") {
    return firstValue(value, ["name", "team", "country", "title", "short_name", "full_name"], "TBD");
  }
  return value ? String(value) : "TBD";
}

function normalizeVenue(value) {
  if (value && typeof value === "object") {
    return firstValue(value, ["name", "stadium", "venue", "city"], "");
  }
  return value ? String(value) : "";
}

function extractScore(obj, side) {
  const keys = side === "home"
    ? ["home_score", "homeScore", "score_home", "homeGoals", "home_goals", "home_result", "home_result_score", "team1_score", "a_score"]
    : ["away_score", "awayScore", "score_away", "awayGoals", "away_goals", "away_result", "away_result_score", "team2_score", "b_score"];

  const value = firstValue(obj, keys, null);
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function normalizeStatus(obj, date, homeScore, awayScore) {
  const raw = String(firstValue(obj, ["status", "state", "match_status", "game_status", "phase"], "")).toLowerCase();

  if (/live|playing|in[- ]?progress|first half|second half|halftime|half time/.test(raw)) return "live";
  if (/complete|completed|finished|full[- ]?time|ended|final/.test(raw)) return "finished";
  if (/scheduled|fixture|not started|upcoming|pending/.test(raw)) return "upcoming";

  if (homeScore !== null || awayScore !== null) return "finished";
  if (date && date.getTime() < Date.now()) return "finished";
  return "upcoming";
}

function normalizeMatch(row, index) {
  const home = normalizeTeam(firstValue(row, ["home", "home_team", "team1", "team_a", "a", "localteam", "homeTeam"], ""));
  const away = normalizeTeam(firstValue(row, ["away", "away_team", "team2", "team_b", "b", "visitorteam", "awayTeam"], ""));
  const rawDate = firstValue(row, ["date", "datetime", "kickoff", "kickoff_time", "time", "start_time", "match_date"], "");
  const date = parseDateFlexible(rawDate);
  const homeScore = extractScore(row, "home");
  const awayScore = extractScore(row, "away");

  return {
    id: firstValue(row, ["id", "game_id", "match_id"], `match-${index}`),
    home,
    away,
    date,
    rawDate,
    group: String(firstValue(row, ["group", "group_name", "stage", "round", "league"], "")),
    matchday: String(firstValue(row, ["matchday", "match_day", "day"], "")),
    venue: normalizeVenue(firstValue(row, ["venue", "stadium", "location"], "")),
    homeScore,
    awayScore,
    status: normalizeStatus(row, date, homeScore, awayScore),
    original: row
  };
}

function normalizeMatches(payload) {
  return unwrapPayload(payload)
    .map(normalizeMatch)
    .filter((m) => m.home && m.away && !/^tbd$/i.test(m.home + m.away));
}

function normalizeStandingTeam(row) {
  const team = normalizeTeam(firstValue(row, ["team", "name", "country", "team_name"], ""));
  return {
    team,
    played: Number(firstValue(row, ["played", "p", "mp", "matches_played"], 0)) || 0,
    wins: Number(firstValue(row, ["wins", "w", "won"], 0)) || 0,
    draws: Number(firstValue(row, ["draws", "d", "drawn"], 0)) || 0,
    losses: Number(firstValue(row, ["losses", "l", "lost"], 0)) || 0,
    goalsFor: Number(firstValue(row, ["goals_for", "gf", "goalsFor", "scored"], 0)) || 0,
    goalsAgainst: Number(firstValue(row, ["goals_against", "ga", "goalsAgainst", "conceded"], 0)) || 0,
    goalDiff: Number(firstValue(row, ["goal_difference", "gd", "goalDiff"], 0)) || 0,
    points: Number(firstValue(row, ["points", "pts"], 0)) || 0
  };
}

function normalizeStandings(payload) {
  const raw = unwrapPayload(payload);

  return raw.map((groupObj, idx) => {
    const groupName = String(firstValue(groupObj, ["group", "group_name", "name", "title"], `Group ${idx + 1}`));
    const teamsRaw = unwrapPayload(groupObj.teams || groupObj.table || groupObj.standings || groupObj.rows || groupObj);
    const teams = teamsRaw
      .map(normalizeStandingTeam)
      .filter((t) => t.team && t.team !== "TBD")
      .sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor);

    return { group: groupName, teams };
  }).filter((g) => g.teams.length);
}

function deriveStandingsFromMatches(matches) {
  const groups = new Map();

  for (const match of matches) {
    if (match.status !== "finished") continue;
    if (match.homeScore === null || match.awayScore === null) continue;

    const groupName = match.group || "Group";
    if (!groups.has(groupName)) groups.set(groupName, new Map());
    const table = groups.get(groupName);

    for (const team of [match.home, match.away]) {
      if (!table.has(team)) {
        table.set(team, { team, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0 });
      }
    }

    const h = table.get(match.home);
    const a = table.get(match.away);
    const hs = Number(match.homeScore);
    const as = Number(match.awayScore);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;

    h.played += 1; a.played += 1;
    h.goalsFor += hs; h.goalsAgainst += as;
    a.goalsFor += as; a.goalsAgainst += hs;

    if (hs > as) { h.wins += 1; h.points += 3; a.losses += 1; }
    else if (as > hs) { a.wins += 1; a.points += 3; h.losses += 1; }
    else { h.draws += 1; a.draws += 1; h.points += 1; a.points += 1; }

    h.goalDiff = h.goalsFor - h.goalsAgainst;
    a.goalDiff = a.goalsFor - a.goalsAgainst;
  }

  return [...groups.entries()].map(([group, table]) => ({
    group,
    teams: [...table.values()].sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor)
  }));
}

function playerNameFromValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") return firstValue(value, ["name", "player", "player_name", "full_name", "display_name"], "").trim();
  return "";
}

function extractEventRows(row) {
  const arrays = [row.events, row.incidents, row.timeline, row.goals, row.goal_scorers, row.scorers, row.statistics, row.stats, row.actions];
  const rows = [];
  for (const value of arrays) {
    if (Array.isArray(value)) rows.push(...value);
  }
  for (const key of ["details", "match_details", "data"]) {
    if (row[key] && typeof row[key] === "object") {
      for (const nested of ["events", "incidents", "timeline", "goals", "scorers"]) {
        if (Array.isArray(row[key][nested])) rows.push(...row[key][nested]);
      }
    }
  }
  return rows;
}

function extractPlayerStatsFromMatches(matches) {
  const players = new Map();

  function add(name, field, amount = 1) {
    const cleanName = playerNameFromValue(name);
    if (!cleanName) return;
    const key = cleanName.toLowerCase();
    if (!players.has(key)) players.set(key, { name: cleanName, country: "", goals: 0, assists: 0, mvp: 0 });
    players.get(key)[field] += amount;
  }

  for (const match of matches) {
    const row = match.original || {};

    for (const event of extractEventRows(row)) {
      if (!event || typeof event !== "object") continue;
      const type = String(firstValue(event, ["type", "event", "kind", "category"], "")).toLowerCase();
      const player = firstValue(event, ["player", "scorer", "player_name", "name", "goal_scorer"], "");
      const assist = firstValue(event, ["assist", "assist_name", "assisted_by", "assist_player"], "");
      if (/goal|scorer/.test(type) || event.scorer || event.goal_scorer) add(player, "goals");
      if (assist) add(assist, "assists");
    }

    for (const key of ["home_scorers", "away_scorers", "scorers", "goal_scorers"]) {
      const value = row[key];
      if (Array.isArray(value)) value.forEach((name) => add(name, "goals"));
    }

    for (const key of ["home_assists", "away_assists", "assists"]) {
      const value = row[key];
      if (Array.isArray(value)) value.forEach((name) => add(name, "assists"));
    }

    const mvp = firstValue(row, ["mvp", "player_of_the_match", "motm", "man_of_the_match"], "");
    if (mvp) add(mvp, "mvp");
  }

  return [...players.values()].sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name));
}
function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function scoreText(match) {
  if (match.homeScore === null && match.awayScore === null) return "vs";
  return `${match.homeScore ?? "–"} - ${match.awayScore ?? "–"}`;
}

function statusLabel(status) {
  if (status === "live") return "Live";
  if (status === "finished") return "Finished";
  return "Upcoming";
}

function filteredMatches() {
  const q = state.search.trim().toLowerCase();

  return state.matches.filter((m) => {
    if (state.filter !== "all" && m.status !== state.filter) return false;
    if (state.group !== "all" && m.group !== state.group) return false;

    if (q) {
      const haystack = `${m.home} ${m.away} ${m.group} ${m.venue}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  }).sort((a, b) => {
    const ad = a.date ? a.date.getTime() : Number.MAX_SAFE_INTEGER;
    const bd = b.date ? b.date.getTime() : Number.MAX_SAFE_INTEGER;
    if (state.filter === "finished") return bd - ad;
    return ad - bd;
  });
}

function renderMatches() {
  const root = $("matchesList");
  const rows = filteredMatches();
  $("matchCount").textContent = `${rows.length} shown`;

  if (!rows.length) {
    root.innerHTML = `<div class="empty">No matches available for this filter from the data source.</div>`;
    return;
  }

  root.innerHTML = rows.map((m) => `
    <article class="match">
      <div class="date">${escapeHtml(formatDate(m.date))}</div>
      <div class="group-tag">${escapeHtml(m.group || "—")}</div>
      <div class="teams">${escapeHtml(m.home)} <span class="muted">vs</span> ${escapeHtml(m.away)}<br><small>${escapeHtml(m.venue || "")}</small></div>
      <div class="score">${escapeHtml(scoreText(m))}</div>
      <div class="badge ${escapeHtml(m.status)}">${escapeHtml(statusLabel(m.status))}</div>
    </article>
  `).join("");
}

function renderGroupOptions() {
  const select = $("groupFilter");
  const groups = [...new Set(state.matches.map((m) => m.group).filter(Boolean))].sort();
  select.innerHTML = `<option value="all">All groups</option>` + groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
  select.value = state.group;
}

function renderStandings() {
  const root = $("standingsList");
  if (!state.standings.length) {
    root.innerHTML = `<div class="empty">Standings are not available from the live source yet.</div>`;
    return;
  }

  root.innerHTML = state.standings.map((group) => `
    <section class="group-block">
      <h3>${escapeHtml(group.group)}</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>#</th><th>Team</th><th>Pts</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th></tr>
          </thead>
          <tbody>
            ${group.teams.map((t, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${escapeHtml(t.team)}</td>
                <td><strong>${t.points}</strong></td>
                <td>${t.played}</td>
                <td>${t.wins}</td>
                <td>${t.draws}</td>
                <td>${t.losses}</td>
                <td>${t.goalsFor}</td>
                <td>${t.goalsAgainst}</td>
                <td>${t.goalDiff}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `).join("");
}

function renderStats() {
  state.lastStatsSignature = JSON.stringify(state.playerStats);
  const scorers = state.playerStats.filter((p) => p.goals > 0).slice(0, 8);
  $("topScorers").innerHTML = scorers.length
    ? scorers.map((p, i) => `
      <div class="stat-item">
        <span class="rank">${i + 1}</span>
        <span>${escapeHtml(p.name)}${p.country ? ` (${escapeHtml(p.country)})` : ""}</span>
        <strong>${p.goals} goal${p.goals === 1 ? "" : "s"}${p.assists ? `, ${p.assists} assist${p.assists === 1 ? "" : "s"}` : ""}</strong>
      </div>
    `).join("")
    : `<div class="empty">Top scorers are not available from the refreshed source. No manual scorer data is shown.<br><small>Refresh #${state.refreshCount}</small></div>`;

  const extras = state.playerStats.filter((p) => p.assists > 0 || p.mvp > 0).slice(0, 8);
  $("extraStats").innerHTML = extras.length
    ? extras.map((p, i) => `
      <div class="stat-item">
        <span class="rank">${i + 1}</span>
        <span>${escapeHtml(p.name)}</span>
        <strong>${p.assists ? `${p.assists} assist${p.assists === 1 ? "" : "s"}` : ""}${p.assists && p.mvp ? " · " : ""}${p.mvp ? `${p.mvp} MVP` : ""}</strong>
      </div>
    `).join("")
    : `<div class="empty">Assists and MVP data are not available from the refreshed source. No manual MVP/assist data is shown.<br><small>Refresh #${state.refreshCount}</small></div>`;
}

function renderLoadingState() {
  $("matchesList").innerHTML = `<div class="empty">Refreshing match data…</div>`;
  $("standingsList").innerHTML = `<div class="empty">Refreshing standings…</div>`;
  $("topScorers").innerHTML = `<div class="empty">Refreshing dynamic top-scorer data…</div>`;
  $("extraStats").innerHTML = `<div class="empty">Refreshing dynamic assists/MVP data…</div>`;
}
function renderAll() {
  renderGroupOptions();
  renderMatches();
  renderStandings();
  renderStats();
}

async function loadData() {
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.refreshCount += 1;

  $("refreshBtn").disabled = true;
  $("statusText").textContent = `Refreshing #${state.refreshCount}…`;
  state.sourceNotes = [];
  state.matches = [];
  state.standings = [];
  state.playerStats = [];
  renderLoadingState();

  try {
    const [gamesPayload, groupsPayload] = await Promise.all([
      fetchFirstAvailable(ENDPOINTS.apiGames, ENDPOINTS.fallbackMatches, "matches", token),
      fetchFirstAvailable(ENDPOINTS.apiGroups, ENDPOINTS.fallbackGroups, "standings", token)
    ]);

    state.matches = normalizeMatches(gamesPayload);
    const sourceStandings = normalizeStandings(groupsPayload);
    state.standings = sourceStandings.length ? sourceStandings : deriveStandingsFromMatches(state.matches);
    state.playerStats = extractPlayerStatsFromMatches(state.matches);

    $("statusText").textContent = `Loaded #${state.refreshCount} · ${state.sourceNotes.join(" · ")}`;
    $("lastUpdated").textContent = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium"
    }).format(new Date());

    renderAll();
  } catch (error) {
    console.error(error);
    $("statusText").textContent = `Unable to load data #${state.refreshCount}`;
    $("matchesList").innerHTML = `<div class="empty">Data could not be loaded. Try Refresh again later.</div>`;
    $("standingsList").innerHTML = `<div class="empty">Standings could not be loaded.</div>`;
    $("topScorers").innerHTML = `<div class="empty">Top scorers could not be loaded from source.</div>`;
    $("extraStats").innerHTML = `<div class="empty">Assists/MVP could not be loaded from source.</div>`;
  } finally {
    $("refreshBtn").disabled = false;
  }
}
function setupEvents() {
  $("refreshBtn").addEventListener("click", loadData);
  $("searchInput").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderMatches();
  });
  $("groupFilter").addEventListener("change", (event) => {
    state.group = event.target.value;
    renderMatches();
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      state.filter = button.dataset.filter || "all";
      renderMatches();
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  loadData();
});
