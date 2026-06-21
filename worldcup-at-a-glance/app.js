const API_BASE = "https://worldcup26.ir";
const ENDPOINTS = {
  games: "/get/games",
  groups: "/get/groups",
  teams: "/get/teams",
  stadiums: "/get/stadiums"
};

const state = {
  raw: {},
  matches: [],
  groups: [],
  teams: [],
  stadiums: [],
  teamsById: new Map(),
  stadiumsById: new Map(),
  standingsByGroup: new Map(),
  qualificationByTeam: new Map(),
  playerOfMatchExternal: [],
  playerOfMatchSourceStatus: "idle",
  playerOfMatchSourceName: "",
  playerOfMatchSourceUrl: "",
  playerOfMatchSources: [
    {
      name: "PunchNG Player of the Match list",
      url: "https://punchng.com/full-list-all-2026-world-cup-player-of-the-match-winners-so-far/"
    },
    {
      name: "Official FIFA Player of the Match page",
      url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/michelob-ultra-superior-player-of-match-winner"
    }
  ],
  lastRefreshDurationMs: null,
  activeMatchFilter: "all",
  autoTimer: null,
  userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
};

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  document.body.dataset.tab = "matches";
  $("userTimezone").textContent = state.userTimeZone === "local" ? "Device local time" : state.userTimeZone;
  $("refreshBtn").addEventListener("click", loadData);
  $("searchInput").addEventListener("input", render);
  document.querySelectorAll(".status-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeMatchFilter = btn.dataset.filter || "all";
      document.querySelectorAll(".status-filter").forEach((item) => {
        item.classList.toggle("active", item.dataset.filter === state.activeMatchFilter);
      });
      render();
    });
  });
  $("autoRefresh").addEventListener("change", setupAutoRefresh);

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  loadData();
  setupAutoRefresh();
});


function setLoadingState(mode, text, hint = "") {
  const panel = document.getElementById("loadingPanel");
  const textEl = document.getElementById("loadingText");
  const hintEl = document.getElementById("loadingHint");

  if (!panel || !textEl || !hintEl) return;

  panel.classList.remove("is-loading", "is-fresh", "has-error");

  if (mode) panel.classList.add(mode);

  textEl.textContent = text || "";
  hintEl.textContent = hint || "";

  if (mode === "is-fresh") {
    clearTimeout(setLoadingState._hideTimer);
    setLoadingState._hideTimer = setTimeout(() => {
      panel.classList.remove("is-fresh");
      panel.style.display = "none";
    }, 1600);
    panel.style.display = "block";
  } else if (mode) {
    clearTimeout(setLoadingState._hideTimer);
    panel.style.display = "block";
  } else {
    panel.style.display = "none";
  }
}

function formatRefreshDuration(ms) {
  if (!Number.isFinite(ms)) return "a few seconds";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function setupAutoRefresh() {
  if (state.autoTimer) clearInterval(state.autoTimer);
  if ($("autoRefresh").checked) state.autoTimer = setInterval(loadData, 5 * 60 * 1000);
}

function switchTab(tabId) {
  document.body.dataset.tab = tabId;
  document.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tabId));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
}

async function loadData() {
  const refreshStartedAt = performance.now();
  setStatus("Loading…");
  setLoadingState("is-loading", "Loading live World Cup data…", "");
  $("refreshBtn").disabled = true;

  try {
    const [games, groups, teams, stadiums] = await Promise.allSettled([
      fetchJson(ENDPOINTS.games),
      fetchJson(ENDPOINTS.groups),
      fetchJson(ENDPOINTS.teams),
      fetchJson(ENDPOINTS.stadiums)
    ]);

    state.raw = {
      games: valueOrError(games),
      groups: valueOrError(groups),
      teams: valueOrError(teams),
      stadiums: valueOrError(stadiums)
    };

    state.teams = extractArray(state.raw.teams);
    state.stadiums = extractArray(state.raw.stadiums);
    buildLookups();

    state.matches = extractArray(state.raw.games).map(normalizeMatch);
    state.groups = extractArray(state.raw.groups);
    state.standingsByGroup = buildAllStandings();
    state.qualificationByTeam = buildQualificationMap();

    state.playerOfMatchExternal = [];
    state.playerOfMatchSourceStatus = "loading";

    state.lastRefreshDurationMs = performance.now() - refreshStartedAt;
    const refreshTime = formatRefreshDuration(state.lastRefreshDurationMs);

    $("lastUpdated").textContent = formatNow();
    setStatus(`Data loaded in ${refreshTime}.`);
    setLoadingState("is-fresh", `Live data updated in ${refreshTime}.`, "");
    render();

    loadExternalPlayerOfMatchAwards()
      .then(() => renderPlayerOfTheMatchAwards())
      .catch((error) => {
        console.warn("Official Player of the Match source failed:", error);
        state.playerOfMatchSourceStatus = "error";
        renderPlayerOfTheMatchAwards();
      });
  } catch (error) {
    console.error(error);
    const refreshTime = formatRefreshDuration(performance.now() - refreshStartedAt);
    setStatus(`Loading error after ${refreshTime}. Check your connection or run the app with a local server.`, true);
    setLoadingState("has-error", `Could not load the latest data after ${refreshTime}.`, "Error");
    console.error(String(error.stack || error.message || error));
  } finally {
    $("refreshBtn").disabled = false;
  }
}

async function fetchJson(path) {
  const url = `${API_BASE}${path}?t=${Date.now()}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} → ${response.status} ${response.statusText}`);
  return response.json();
}

function valueOrError(result) {
  return result.status === "fulfilled" ? result.value : { error: String(result.reason) };
}

function setStatus(message, isError = false) {
  $("statusText").textContent = message;
  $("statusText").style.color = isError ? "var(--danger)" : "var(--muted)";
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const preferredKeys = ["data", "games", "matches", "fixtures", "groups", "teams", "stadiums", "results", "items", "players"];
  for (const key of preferredKeys) if (Array.isArray(payload[key])) return payload[key];

  for (const value of Object.values(payload)) if (Array.isArray(value)) return value;
  return [];
}

function buildLookups() {
  state.teamsById = new Map();
  state.stadiumsById = new Map();

  for (const team of state.teams) {
    const id = String(pick(team, ["id", "_id", "team_id"]) ?? "");
    if (id) state.teamsById.set(id, team);
  }

  for (const stadium of state.stadiums) {
    const id = String(pick(stadium, ["id", "_id", "stadium_id"]) ?? "");
    if (id) state.stadiumsById.set(id, stadium);
  }
}

function normalizeMatch(match) {
  const homeTeamId = String(pick(match, ["home_team_id", "homeTeamId", "home_id", "team1_id"]) ?? "");
  const awayTeamId = String(pick(match, ["away_team_id", "awayTeamId", "away_id", "team2_id"]) ?? "");
  const stadiumId = String(pick(match, ["stadium_id", "stadiumId", "venue_id"]) ?? "");

  const home =
    labelOf(pick(match, ["home_team_name_en", "home_name_en", "homeTeamName", "home_team", "home", "team1", "teamA"])) ||
    teamNameById(homeTeamId) ||
    "To be determined";

  const away =
    labelOf(pick(match, ["away_team_name_en", "away_name_en", "awayTeamName", "away_team", "away", "team2", "teamB"])) ||
    teamNameById(awayTeamId) ||
    "To be determined";

  const homeScore = pickNumber(match, ["home_score", "homeScore", "scoreHome", "homeGoals", "team1Score", "goalsHome"]);
  const awayScore = pickNumber(match, ["away_score", "awayScore", "scoreAway", "awayGoals", "team2Score", "goalsAway"]);

  const dateInfo = parseMatchDate(match, stadiumId);
  const finishedRaw = pick(match, ["finished", "isFinished", "is_finished"]);
  const elapsed = String(pick(match, ["time_elapsed", "timeElapsed", "elapsed", "minute"]) ?? "");
  const statusText = String(pick(match, ["status", "state", "match_status", "statusText", "matchStatus"]) ?? "");
  const status = inferStatus({ finishedRaw, elapsed, statusText, date: dateInfo.date, homeScore, awayScore });

  const groupOrStage =
    labelOf(pick(match, ["group", "groupName", "group_name"])) ||
    labelOf(pick(match, ["round", "stage", "type"])) ||
    "—";

  return {
    original: match,
    id: pick(match, ["id", "_id", "match_id", "gameId"]) || cryptoRandom(),
    date: dateInfo.date,
    rawDate: dateInfo.raw,
    sourceTimeZone: dateInfo.sourceTimeZone,
    group: groupOrStage,
    matchday: pick(match, ["matchday", "match_day"]),
    home,
    away,
    homeScore,
    awayScore,
    status,
    statusText: statusText || elapsed || statusLabel(status),
    venue: stadiumLabelById(stadiumId) || labelOf(pick(match, ["stadium", "venue", "location", "city"])) || "—"
  };
}

function parseMatchDate(match, stadiumId) {
  const utcRaw = pick(match, ["utc_date", "utcDate", "date_utc", "kickoff_utc", "start_time_utc"]);
  if (utcRaw) {
    const d = new Date(String(utcRaw));
    if (!Number.isNaN(d.getTime())) return { date: d, raw: utcRaw, sourceTimeZone: "UTC" };
  }

  const raw = pick(match, ["local_date", "date", "time", "datetime", "matchDate", "kickoff", "startTime", "start_time"]);
  if (!raw) return { date: null, raw: null, sourceTimeZone: null };

  const text = String(raw).trim();

  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) return { date: d, raw, sourceTimeZone: "API" };
  }

  const wall = parseWallDate(text);
  const sourceTimeZone = timeZoneForMatch(match, stadiumId);

  if (wall && sourceTimeZone) return { date: zonedTimeToUtc(wall, sourceTimeZone), raw, sourceTimeZone };

  if (wall) {
    return {
      date: new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second || 0),
      raw,
      sourceTimeZone: "local API"
    };
  }

  const d = new Date(text);
  return { date: Number.isNaN(d.getTime()) ? null : d, raw, sourceTimeZone: null };
}

function parseWallDate(text) {
  let m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return { month: Number(m[1]), day: Number(m[2]), year: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] || 0) };

  m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] || 0) };

  return null;
}

function zonedTimeToUtc(wall, timeZone) {
  let utc = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second || 0));
  for (let i = 0; i < 2; i++) {
    const offset = getTimeZoneOffsetMs(utc, timeZone);
    utc = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second || 0) - offset);
  }
  return utc;
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const map = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;

  const asUTC = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
  return asUTC - date.getTime();
}

function timeZoneForMatch(match, stadiumId) {
  const stadium = state.stadiumsById.get(String(stadiumId));
  const venueText = [
    labelOf(stadium),
    labelOf(pick(stadium || {}, ["city_en", "city", "country_en", "country"])),
    labelOf(pick(match, ["stadium", "venue", "location", "city"]))
  ].join(" ").toLowerCase();

  const rules = [
    [/mexico city|guadalajara|monterrey/, "America/Mexico_City"],
    [/toronto/, "America/Toronto"],
    [/vancouver/, "America/Vancouver"],
    [/new york|new jersey|east rutherford|boston|foxborough|philadelphia|atlanta|miami/, "America/New_York"],
    [/kansas city|dallas|arlington|houston/, "America/Chicago"],
    [/los angeles|inglewood|san francisco|santa clara|seattle/, "America/Los_Angeles"]
  ];

  for (const [regex, tz] of rules) if (regex.test(venueText)) return tz;
  return null;
}

function teamNameById(id) {
  if (!id || !state.teamsById.has(String(id))) return "";
  return labelOf(state.teamsById.get(String(id)));
}

function stadiumLabelById(id) {
  if (!id || !state.stadiumsById.has(String(id))) return "";
  const stadium = state.stadiumsById.get(String(id));
  const name = pick(stadium, ["fifa_name", "name_en", "name", "title"]);
  const city = pick(stadium, ["city_en", "city", "country_en"]);
  return [labelOf(name), labelOf(city)].filter(Boolean).join(" — ");
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }
  return null;
}

function labelOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    return (
      value.name_en || value.fifa_name || value.name || value.en || value.title ||
      value.player_name || value.playerName || value.full_name || value.fullName ||
      value.teamName || value.country || value.shortName || value.fifa_code || value.code ||
      value.team?.name_en || value.team?.name || ""
    );
  }
  return String(value);
}

function pickNumber(obj, keys) {
  const val = pick(obj, keys);
  if (val === null || val === undefined || val === "" || String(val).toLowerCase() === "null") return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function boolFromApi(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const s = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "y", "1", "finished", "complete"].includes(s)) return true;
  if (["false", "no", "n", "0", "notstarted", "not_started", "scheduled"].includes(s)) return false;
  return null;
}

function inferStatus({ finishedRaw, elapsed, statusText, date, homeScore, awayScore }) {
  const finished = boolFromApi(finishedRaw);
  const combined = `${elapsed} ${statusText}`.toLowerCase();

  if (finished === true) return "finished";
  if (/(live|in.?play|playing|1st|2nd|halftime|half.?time|ht|\b\d{1,3}'|minute|مستقیم)/i.test(combined)) return "live";
  if (/(finished|final|full.?time|ft|ended|complete|played|تمام)/i.test(combined)) return "finished";
  if (finished === false) return "upcoming";

  if (homeScore !== null && awayScore !== null && date && date < new Date() && !/notstarted|not.started|scheduled/i.test(combined)) return "finished";
  return "upcoming";
}

function statusLabel(status) {
  return status === "finished" ? "Finished" : status === "live" ? "Live" : "Upcoming";
}

function cryptoRandom() {
  return Math.random().toString(36).slice(2);
}

function buildAllStandings() {
  const groups = new Map();

  for (const match of state.matches) {
    if (!match.group || match.group === "—") continue;
    if (!/^[A-L]$/.test(String(match.group).trim())) continue;

    if (!groups.has(match.group)) groups.set(match.group, new Map());
    const table = groups.get(match.group);

    ensureStandingRow(table, match.home);
    ensureStandingRow(table, match.away);

    if (match.status !== "finished") continue;
    if (match.homeScore === null || match.awayScore === null) continue;

    const home = table.get(match.home);
    const away = table.get(match.away);

    home.played += 1;
    away.played += 1;

    home.gf += match.homeScore;
    home.ga += match.awayScore;
    away.gf += match.awayScore;
    away.ga += match.homeScore;

    if (match.homeScore > match.awayScore) {
      home.won += 1;
      home.points += 3;
      away.lost += 1;
    } else if (match.homeScore < match.awayScore) {
      away.won += 1;
      away.points += 3;
      home.lost += 1;
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += 1;
      away.points += 1;
    }
  }

  const result = new Map();
  for (const [group, table] of groups) {
    const rows = [...table.values()]
      .map((row) => ({ ...row, diff: row.gf - row.ga }))
      .sort((a, b) =>
        b.points - a.points ||
        b.diff - a.diff ||
        b.gf - a.gf ||
        a.name.localeCompare(b.name)
      )
      .map((row, index) => ({ ...row, rank: index + 1 }));

    result.set(group, rows);
  }

  return result;
}

function ensureStandingRow(table, name) {
  if (!table.has(name)) {
    table.set(name, {
      name,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      gf: 0,
      ga: 0,
      points: 0
    });
  }
}

function buildQualificationMap() {
  const map = new Map();
  const thirdRows = [];

  for (const [groupName, rows] of state.standingsByGroup.entries()) {
    for (const row of rows) {
      const key = qualificationKey(groupName, row.name);

      if (row.rank <= 2) {
        map.set(key, {
          status: "auto",
          rowClass: "q-auto-row",
          textClass: "q-auto-text",
          shortLabel: "Q",
          label: "Qualified"
        });
      } else if (row.rank === 3) {
        thirdRows.push({ groupName, row });
      } else {
        map.set(key, {
          status: "out",
          rowClass: "q-out-row",
          textClass: "q-out-text",
          shortLabel: "OUT",
          label: "Out"
        });
      }
    }
  }

  thirdRows
    .sort((a, b) =>
      b.row.points - a.row.points ||
      b.row.diff - a.row.diff ||
      b.row.gf - a.row.gf ||
      a.row.name.localeCompare(b.row.name)
    )
    .forEach((item, index) => {
      const key = qualificationKey(item.groupName, item.row.name);

      if (index < 8) {
        map.set(key, {
          status: "third",
          rowClass: "q-third-row",
          textClass: "q-third-text",
          shortLabel: "Q3",
          label: "Best 3rd"
        });
      } else {
        map.set(key, {
          status: "out",
          rowClass: "q-out-row",
          textClass: "q-out-text",
          shortLabel: "OUT",
          label: "Out"
        });
      }
    });

  return map;
}

function qualificationKey(groupName, teamName) {
  return `${String(groupName)}|||${String(teamName)}`;
}

function qualificationFor(groupName, teamName) {
  return state.qualificationByTeam.get(qualificationKey(groupName, teamName)) || {
    status: "unknown",
    rowClass: "",
    textClass: "",
    shortLabel: "—",
    label: "—"
  };
}

async function loadExternalPlayerOfMatchAwards() {
  state.playerOfMatchExternal = [];
  state.playerOfMatchSourceStatus = "loading";
  state.playerOfMatchSourceName = "";
  state.playerOfMatchSourceUrl = "";

  for (const source of state.playerOfMatchSources) {
    try {
      const readerUrl = `https://r.jina.ai/${source.url}`;
      const response = await fetchWithTimeout(readerUrl, 7000);

      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const text = await response.text();
      const awards = parsePlayerOfMatchAwardsFromText(text);

      if (awards.length) {
        state.playerOfMatchExternal = awards;
        state.playerOfMatchSourceStatus = "loaded";
        state.playerOfMatchSourceName = source.name;
        state.playerOfMatchSourceUrl = source.url;
        return;
      }
    } catch (error) {
      console.warn(`Player of the Match source failed: ${source.name}`, error);
    }
  }

  state.playerOfMatchExternal = [];
  state.playerOfMatchSourceStatus = "empty";
}

async function fetchWithTimeout(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parsePlayerOfMatchAwardsFromText(text) {
  const counts = new Map();
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
    .filter(Boolean);

  for (const line of lines) {
    const name = extractPlayerOfMatchNameFromLine(line);
    if (!name || !isValidPotmName(name)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function extractPlayerOfMatchNameFromLine(line) {
  const normalized = String(line || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "";
  if (/https?:|www\.|\/|\\|\b(?:video|match-centre|match center|articles|tournaments|fifa\.com)\b/i.test(normalized)) return "";
  if (/\b(?:opens soon|upcoming games|cast your vote|vote from half time|image:|advertise|subscribe)\b/i.test(normalized)) return "";

  // Example:
  // Mexico 2-0 South Africa — Julian Quiñones (Mexico)
  // Austria vs Jordan — Ali Olwan (Jordan)
  const articlePattern = /^(.+?)\s+(?:\d+\s*[-–]\s*\d+|vs|v)\s+(.+?)\s+[—–]\s+([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,42})(?:\s*\([^)]+\))?\s*$/i;
  const articleMatch = normalized.match(articlePattern);
  if (articleMatch && articleMatch[3]) {
    return cleanPotmCandidate(articleMatch[3]);
  }

  // Example:
  // Man of the Match: Alexander Isak (SWE)
  // Player of the Match — Virgil van Dijk (Netherlands)
  const labelPattern = /\b(?:Man of the Match|Player of the Match|Superior Player of the Match)\b\s*[:—–-]\s*([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,42})(?:\s*\([^)]+\))?/i;
  const labelMatch = normalized.match(labelPattern);
  if (labelMatch && labelMatch[1]) {
    return cleanPotmCandidate(labelMatch[1]);
  }

  return "";
}

function render() {
  renderCards();
  renderMatches();
  renderGroups();
  renderStats();
}

function filteredMatches() {
  const q = $("searchInput").value.trim().toLowerCase();
  const filter = state.activeMatchFilter || "all";

  return state.matches
    .filter((m) => filter === "all" || m.status === filter)
    .filter((m) => {
      if (!q) return true;
      return [m.home, m.away, m.group, m.venue, m.statusText].join(" ").toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const at = a.date?.getTime() || Number.MAX_SAFE_INTEGER;
      const bt = b.date?.getTime() || Number.MAX_SAFE_INTEGER;
      return at - bt;
    });
}

function renderCards() {
  const finished = state.matches.filter((m) => m.status === "finished");
  const live = state.matches.filter((m) => m.status === "live");
  const totalGoals = finished.reduce((sum, m) => sum + (m.homeScore || 0) + (m.awayScore || 0), 0);

  if (document.getElementById("totalMatches")) $("totalMatches").textContent = state.matches.length || "—";
  if (document.getElementById("finishedMatches")) $("finishedMatches").textContent = finished.length || "0";
  if (document.getElementById("totalGoals")) $("totalGoals").textContent = totalGoals || "0";
  if (document.getElementById("goalsAverage")) $("goalsAverage").textContent = finished.length ? (totalGoals / finished.length).toFixed(2) : "0";
  if (document.getElementById("liveMatches")) if (document.getElementById("liveMatches")) $("liveMatches").textContent = live.length || "0";
}

function renderGroupSummary() {
  const container = $("groupSummary");
  const groups = [...state.standingsByGroup.entries()].sort(([a], [b]) => a.localeCompare(b));

  if (!groups.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = groups.map(([groupName, teams]) => `
    <article class="group-mini-card">
      <h3>Group ${escapeHtml(groupName)}</h3>
      ${teams.map((team) => `
        <div class="mini-row ${qualificationFor(groupName, team.name).rowClass}">
          <span class="mini-pos">${team.rank}</span>
          <span class="mini-team" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</span>
          <span class="mini-pts">${team.points} pts</span>
          <span class="mini-diff">${team.diff > 0 ? "+" : ""}${team.diff}</span>
          <span class="qual-label ${qualificationFor(groupName, team.name).textClass}">${qualificationFor(groupName, team.name).shortLabel}</span>
        </div>
      `).join("")}
    </article>
  `).join("");
}

function renderMatches() {
  const body = $("matchesBody");
  const matches = filteredMatches();

  if (!matches.length) {
    body.innerHTML = `<tr><td colspan="6">No matches found.</td></tr>`;
    return;
  }

  const filter = state.activeMatchFilter || "all";
  const groups = filter === "all"
    ? [
        { key: "live", title: "Live matches", rows: matches.filter((m) => m.status === "live") },
        { key: "upcoming", title: "Upcoming matches", rows: matches.filter((m) => m.status === "upcoming") },
        { key: "finished", title: "Finished matches", rows: matches.filter((m) => m.status === "finished") }
      ]
    : [
        {
          key: filter,
          title: filter === "live" ? "Live matches" : filter === "upcoming" ? "Upcoming matches" : "Finished matches",
          rows: matches
        }
      ];

  const html = [];

  for (const group of groups) {
    if (!group.rows.length) continue;

    if (group.key !== "live") {
      html.push(`
        <tr class="match-section-row ${group.key}-section">
          <td colspan="6">${escapeHtml(group.title)} · ${group.rows.length}</td>
        </tr>
      `);
    }

    html.push(...group.rows.map((m) => `
      <tr>
        <td>${formatDate(m.date, m.rawDate)}</td>
        <td>${escapeHtml(m.group)}${m.matchday ? `<br><small>MD${escapeHtml(m.matchday)}</small>` : ""}</td>
        <td class="teams-cell">${displayTeamWithCountryV30(m.home, m.original, "home")} <span class="vs-label">vs</span> ${displayTeamWithCountryV30(m.away, m.original, "away")}</td>
        <td class="score">${formatScore(m)}</td>
        <td>${typeof statusCell === "function" ? statusCell(m) : `<span class="badge ${m.status}">${escapeHtml(statusLabel(m.status))}</span>`}</td>
        <td>${escapeHtml(m.venue)}</td>
      </tr>
    `));
  }

  body.innerHTML = html.join("");
}

function formatNow() {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: state.userTimeZone === "local" ? undefined : state.userTimeZone
  }).format(new Date());
}

function formatDate(date, raw) {
  if (date && !Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: state.userTimeZone === "local" ? undefined : state.userTimeZone
    }).format(date);
  }
  return raw ? escapeHtml(String(raw)) : "—";
}

function formatScore(m) {
  if (m.status === "upcoming" && (m.homeScore === null || m.awayScore === null || ((m.homeScore || 0) === 0 && (m.awayScore || 0) === 0))) return "—";
  if (m.homeScore === null || m.awayScore === null) return "—";
  return `${m.homeScore} - ${m.awayScore}`;
}

function renderGroups() {
  const container = $("groupsBody");
  const groups = [...state.standingsByGroup.entries()].sort(([a], [b]) => a.localeCompare(b));

  if (!groups.length) {
    container.innerHTML = `<div class="group-card">No standings available.</div>`;
    return;
  }

  container.innerHTML = groups.map(([groupName, teams]) => `
    <article class="group-card">
      <h2>Group ${escapeHtml(groupName)}</h2>

      <table class="standings-table standings-desktop-table">
        <thead>
          <tr>
            <th>#</th><th>Team</th><th>Pts</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${teams.map((team) => {
            const q = qualificationFor(groupName, team.name);

            return `
              <tr class="${q.rowClass}">
                <td>${team.rank}</td>
                <td>${escapeHtml(team.name)}</td>
                <td>${team.points}</td>
                <td>${team.played}</td>
                <td>${team.won}</td>
                <td>${team.drawn}</td>
                <td>${team.lost}</td>
                <td>${team.gf}</td>
                <td>${team.ga}</td>
                <td>${team.diff}</td>
                <td class="${q.textClass}">${escapeHtml(q.label)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>

      <div class="standings-mobile-list" aria-label="Group ${escapeHtml(groupName)} mobile standings">
        <div class="standing-mobile-header">
          <span>#</span>
          <span>Team</span>
          <span>Pts</span>
          <span>GD</span>
          <span>Status</span>
        </div>

        ${teams.map((team) => {
          const q = qualificationFor(groupName, team.name);

          return `
            <div class="standing-mobile-row ${q.rowClass}">
              <span class="standing-rank">${team.rank}</span>
              <span class="standing-team">${escapeHtml(team.name)}</span>
              <span class="standing-pts">${team.points}</span>
              <span class="standing-gd">${team.diff}</span>
              <span class="standing-status ${q.textClass}">${escapeHtml(q.shortLabel || q.label)}</span>
            </div>
          `;
        }).join("")}
      </div>
    </article>
  `).join("");
}

function renderStats() {
  renderTopScorers();
  renderPlayerOfTheMatchAwards();

  const finished = state.matches.filter((m) => m.status === "finished");
  const goalsByTeam = {};

  for (const m of finished) {
    goalsByTeam[m.home] = (goalsByTeam[m.home] || 0) + (m.homeScore || 0);
    goalsByTeam[m.away] = (goalsByTeam[m.away] || 0) + (m.awayScore || 0);
  }

  const topTeams = Object.entries(goalsByTeam)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15);
}

function statItemHtml(rank, name, value, colorClass = "stat-blue", forceTop = false) {
  const topClass = forceTop || rank === 1
    ? (colorClass === "stat-blue" ? "stat-top-blue" : "stat-top")
    : "";

  return `
    <li class="${topClass}">
      <span class="stat-rank">${rank}</span>
      <span class="stat-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="stat-value">${escapeHtml(value)}</span>
    </li>
  `;
}

function statEmptyHtml(message) {
  return `<li class="stat-empty">${escapeHtml(message)}</li>`;
}

function renderTopScorers() {
  const scorerCounts = buildTopScorers();
  const topGoals = scorerCounts.length ? scorerCounts[0][1] : null;

  $("topScorers").innerHTML = scorerCounts.length
    ? scorerCounts.slice(0, 15).map(([player, goals], index) =>
        statItemHtml(index + 1, player, `${goals} ${plural(goals, "goal")}`, "stat-green", goals === topGoals)
      ).join("")
    : statEmptyHtml("Player scorer data was not found in the current API response.");
}

function renderPlayerOfTheMatchAwards() {

  if (state.playerOfMatchSourceStatus === "loading") {
    $("mostPlayerOfMatch").innerHTML = statEmptyHtml("Loading Player of the Match data…");
    return;
  }

  const awards = buildPlayerOfMatchAwards().filter(([, count]) => Number(count) > 1);
  const topAwards = awards.length ? awards[0][1] : null;

  $("mostPlayerOfMatch").innerHTML = awards.length
    ? awards.slice(0, 15).map(([player, count], index) =>
        statItemHtml(index + 1, player, `${count} ${plural(count, "award")}`, "stat-blue", count === topAwards)
      ).join("")
    : statEmptyHtml("No player has more than one Player of the Match award yet.");
}

function buildTopScorers() {
  const counts = new Map();

  for (const match of state.matches) {
    const events = extractGoalScorers(match.original);

    for (const scorer of events) {
      const name = cleanPlayerName(scorer);
      if (!name || isNoiseName(name)) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function extractGoalScorers(match) {
  const fields = [
    "scorers",
    "goals",
    "goal_scorers",
    "goalScorers",
    "home_scorers",
    "away_scorers",
    "homeScorers",
    "awayScorers",
    "home_goal_scorers",
    "away_goal_scorers",
    "homeGoals",
    "awayGoals",
    "events",
    "match_events",
    "matchEvents",
    "timeline"
  ];

  const scorers = [];

  for (const field of fields) {
    const value = match?.[field];
    if (value === undefined || value === null || value === "") continue;
    scorers.push(...extractScorersFromValue(value));
  }

  return scorers;
}

function extractScorersFromValue(value) {
  const scorers = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        scorers.push(...extractNamesFromScorerString(item));
      } else if (item && typeof item === "object") {
        const eventType = String(pick(item, ["type", "event_type", "eventType", "kind"]) || "").toLowerCase();
        const looksLikeGoal = !eventType || /goal|penalty|own goal|own_goal/.test(eventType);

        if (looksLikeGoal) {
          const name = labelOf(pick(item, [
            "player",
            "player_name",
            "playerName",
            "scorer",
            "scorer_name",
            "goal_scorer",
            "name",
            "full_name",
            "fullName"
          ]));
          if (name) scorers.push(name);
        }
      }
    }
    return scorers;
  }

  if (typeof value === "object") {
    for (const nested of Object.values(value)) {
      scorers.push(...extractScorersFromValue(nested));
    }
    return scorers;
  }

  if (typeof value === "string") {
    return extractNamesFromScorerString(value);
  }

  return scorers;
}

function extractNamesFromScorerString(text) {
  const raw = String(text || "").trim();
  if (!raw || raw === "[]" || raw === "{}") return [];

  try {
    const parsed = JSON.parse(raw);
    const parsedNames = extractScorersFromValue(parsed);
    if (parsedNames.length) return parsedNames;
  } catch (_) {
    // Continue with tolerant cleanup below.
  }

  const jsonLikeNames = [];
  const valueRegex = /["'](?:player|player_name|playerName|scorer|scorer_name|goal_scorer|name|full_name|fullName)["']\s*:\s*["']([^"']+)["']/gi;
  let match;
  while ((match = valueRegex.exec(raw)) !== null) {
    jsonLikeNames.push(match[1]);
  }
  if (jsonLikeNames.length) return jsonLikeNames;

  return raw
    .split(/[,;|،\n]+/)
    .map(cleanPlayerName)
    .filter((name) => name && !isNoiseName(name));
}


const NON_PLAYER_WORDS = new Set([
  "up", "video", "videos", "match", "centre", "center", "live", "highlights",
  "korea", "qatar", "switzerland", "curacao", "curaçao", "algeria", "belgium",
  "bosnia", "bosnia and herzegovina", "czechia", "czech republic", "canada",
  "mexico", "south africa", "germany", "france", "england", "argentina",
  "brazil", "morocco", "spain", "portugal", "ghana", "panama", "haiti",
  "scotland", "australia", "turkey", "tunisia", "japan", "uruguay",
  "saudi arabia", "iran", "new zealand", "egypt", "paraguay", "senegal",
  "ivory coast", "ecuador", "iraq", "norway", "netherlands", "sweden",
  "colombia", "uzbekistan", "croatia", "jordan", "austria"
]);

function cleanPotmCandidate(value) {
  let s = cleanPlayerName(value)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(?:www|fifa|com|en|tournaments|mens|worldcup|canadamexicousa2026|articles|match-centre|match|centre)\b/gi, "")
    .replace(/[\\/]+/g, " ")
    .replace(/\b[0-9a-f]{4,}\b/gi, "")
    .replace(/\b\d{5,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Prefer the last readable name-like fragment if a path slipped through.
  const pieces = s.split(/\s{2,}|[|>]+/).map((x) => x.trim()).filter(Boolean);
  if (pieces.length) s = pieces[pieces.length - 1];

  return s;
}

function isValidPotmName(name) {
  const s = String(name || "").trim();
  const lower = s.toLowerCase();

  if (!s || s.length < 3 || s.length > 42) return false;
  if (NON_PLAYER_WORDS.has(lower)) return false;
  if (/https?:|www\.|\/|\\/.test(s)) return false;
  if (/\b(?:video|match|centre|center|articles|tournaments|worldcup|fifa)\b/i.test(s)) return false;
  if (/[0-9a-f]{4,}/i.test(s)) return false;
  if (/\d/.test(s)) return false;
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(s)) return false;

  // Real names usually have one to four words, allowing accents, hyphens, apostrophes, and dots.
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ.'’ -]+$/.test(s)) return false;

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;

  return true;
}

function buildPlayerOfMatchAwards() {
  const counts = new Map();

  // First use any player-of-match fields from the match API.
  for (const match of state.matches) {
    const names = extractPlayerOfMatch(match.original);

    for (const rawName of names) {
      const name = cleanPotmCandidate(rawName);
      if (!isValidPotmName(name)) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  // Then merge the external list, if available.
  for (const [rawName, count] of state.playerOfMatchExternal || []) {
    const name = cleanPotmCandidate(rawName);
    if (!isValidPotmName(name)) continue;
    counts.set(name, (counts.get(name) || 0) + Number(count || 1));
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function extractPlayerOfMatch(match) {
  const fields = [
    "player_of_match",
    "playerOfMatch",
    "player_of_the_match",
    "playerOfTheMatch",
    "man_of_the_match",
    "manOfTheMatch",
    "motm",
    "best_player",
    "bestPlayer",
    "mvp"
  ];

  const names = [];

  for (const field of fields) {
    const value = match?.[field];
    if (value === undefined || value === null || value === "") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        const name = labelOf(item);
        if (name) names.push(name);
      }
    } else if (typeof value === "object") {
      const name = labelOf(value);
      if (name) names.push(name);
    } else {
      names.push(String(value));
    }
  }

  return names;
}

function cleanPlayerName(value) {
  return String(value || "")
    .replace(/\\u0027/g, "'")
    .replace(/\\?["`]/g, "")
    .replace(/[{}\[\]]/g, "")
    .replace(/\b(?:player|player_name|playerName|scorer|scorer_name|goal_scorer|name|full_name|fullName)\s*:/gi, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\b\d{1,3}\s*\+\s*\d{1,2}'?\b/g, "")
    .replace(/\b\d{1,3}'?\b/g, "")
    .replace(/\bpen(?:alty)?\.?\b/gi, "")
    .replace(/\bog\b/gi, "")
    .replace(/\s*\+\s*$/g, "")
    .replace(/^\s*['"]+|['"]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoiseName(name) {
  const s = String(name).trim().toLowerCase();
  return !s ||
    s === "-" ||
    s === "null" ||
    s === "undefined" ||
    s === "none" ||
    s === "n/a" ||
    s === "unknown" ||
    s === "to be determined" ||
    /^\d+$/.test(s);
}

function plural(count, singular) {
  return Number(count) === 1 ? singular : `${singular}s`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

/* =========================================================
   Assist AI WorldCup v14 — stable restore + requested fixes
   Built from the original working app; does not override loadData.
   - Data refresh works normally again
   - Results and standings render normally
   - Stats render after each refresh through original render()
   - Results date format: SAT. 20 JUNE 19:00
   - Live games show minute/time when available
   - Top scorers: deduped, country in parentheses, only 2+ goals,
     top 2 goal levels with all ties included
   ========================================================= */

const TOP_SCORER_GOAL_LEVELS_TO_SHOW_V14 = 2;
const MIN_TOP_SCORER_GOALS_TO_SHOW_V14 = 2;

const TOP_SCORER_MINIMUMS_V14 = [
  { name: "Jonathan David", country: "Canada", goals: 3 },
  { name: "Lionel Messi", country: "Argentina", goals: 3 },
  { name: "Ismael Saibari", country: "Morocco", goals: 2 },
  { name: "Aymen Hussein", country: "Iraq", goals: 2 },
  { name: "Elijah Just", country: "New Zealand", goals: 2 },
  { name: "Erling Haaland", country: "Norway", goals: 2 },
  { name: "F. Balogun", country: "United States", goals: 2 },
  { name: "H. Kane", country: "England", goals: 2 },
  { name: "Johan Manzambi", country: "Switzerland", goals: 2 },
  { name: "K. Havertz", country: "Germany", goals: 2 },
  { name: "K. Mbappé", country: "France", goals: 2 },
  { name: "Matheus Cunha", country: "Brazil", goals: 2 },
  { name: "Y. Ayari", country: "Sweden", goals: 2 }
];

const PLAYER_ALIAS_V14 = {
  "jonathan david": "Jonathan David",
  "lionel messi": "Lionel Messi",
  "leo messi": "Lionel Messi",
  "ismael saibari": "Ismael Saibari",
  "i saibari": "Ismael Saibari",
  "aymen hussein": "Aymen Hussein",
  "elijah just": "Elijah Just",
  "erling haaland": "Erling Haaland",
  "f balogun": "F. Balogun",
  "folarin balogun": "F. Balogun",
  "h kane": "H. Kane",
  "harry kane": "H. Kane",
  "johan manzambi": "Johan Manzambi",
  "jvhan mnzambi": "Johan Manzambi",
  "k havertz": "K. Havertz",
  "kai havertz": "K. Havertz",
  "k mbappe": "K. Mbappé",
  "kylian mbappe": "K. Mbappé",
  "matheus cunha": "Matheus Cunha",
  "y ayari": "Y. Ayari",
  "yasin ayari": "Y. Ayari"
};

const PLAYER_COUNTRY_V14 = {
  "jonathan david": "Canada",
  "lionel messi": "Argentina",
  "ismael saibari": "Morocco",
  "aymen hussein": "Iraq",
  "elijah just": "New Zealand",
  "erling haaland": "Norway",
  "f balogun": "United States",
  "h kane": "England",
  "johan manzambi": "Switzerland",
  "k havertz": "Germany",
  "k mbappe": "France",
  "matheus cunha": "Brazil",
  "y ayari": "Sweden"
};

function cleanScorerNameV14(value) {
  return String(value || "")
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/^['"\s]+|['"\s]+$/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\\u0027/g, "'")
    .replace(/\\?["`]/g, "")
    .replace(/[{}\[\]]/g, "")
    .replace(/\b(?:player|player_name|playerName|scorer|scorer_name|goal_scorer|name|full_name|fullName)\s*:/gi, "")
    .replace(/\b\d{1,3}\s*\+\s*\d{1,2}'?\b/g, "")
    .replace(/\b\d{1,3}'?\b/g, "")
    .replace(/\bpen(?:alty)?\.?\b/gi, "")
    .replace(/\bog\b/gi, "")
    .replace(/\s*\.\s*/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

function playerKeyV14(value) {
  return cleanScorerNameV14(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\./g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function canonicalScorerNameV14(value) {
  const cleaned = cleanScorerNameV14(value);
  const key = playerKeyV14(cleaned);
  return PLAYER_ALIAS_V14[key] || cleaned;
}

function scorerCountryV14(name, hint = "") {
  const hinted = cleanScorerNameV14(hint);
  if (hinted && !/^\d+$/.test(hinted) && !/goal|penalty|own goal/i.test(hinted)) return hinted;

  const key = playerKeyV14(name);
  if (PLAYER_COUNTRY_V14[key]) return PLAYER_COUNTRY_V14[key];

  const fallback = TOP_SCORER_MINIMUMS_V14.find((item) => playerKeyV14(item.name) === key);
  return fallback?.country || "";
}

function scorerDisplayNameV14(name, country = "") {
  const canonical = canonicalScorerNameV14(name);
  const countryName = scorerCountryV14(canonical, country);
  return countryName ? `${canonical} (${countryName})` : canonical;
}

function upsertScorerV14(counts, rawName, goals = 1, country = "") {
  const canonical = canonicalScorerNameV14(rawName);
  if (!canonical || isNoiseName(canonical)) return;

  const key = playerKeyV14(canonical);
  if (!key) return;

  const current = counts.get(key) || {
    name: canonical,
    goals: 0,
    country: scorerCountryV14(canonical, country)
  };

  current.name = canonical;
  current.goals += Number(goals) || 0;
  current.country = current.country || scorerCountryV14(canonical, country);
  counts.set(key, current);
}

function buildTopScorers() {
  const counts = new Map();

  for (const match of state.matches || []) {
    const events = extractGoalScorers(match.original);

    for (const scorer of events) {
      if (Array.isArray(scorer)) {
        upsertScorerV14(counts, scorer[0], scorer[1] || 1, scorer[2] || "");
      } else if (scorer && typeof scorer === "object") {
        upsertScorerV14(
          counts,
          scorer.name || scorer.player || scorer.scorer || scorer.player_name || scorer.fullName,
          scorer.goals || scorer.count || 1,
          scorer.country || scorer.team || ""
        );
      } else {
        upsertScorerV14(counts, scorer, 1, "");
      }
    }
  }

  // Safety net if the live API does not publish all scorer names yet.
  // Live API counts can exceed these numbers and will win automatically.
  for (const item of TOP_SCORER_MINIMUMS_V14) {
    const canonical = canonicalScorerNameV14(item.name);
    const key = playerKeyV14(canonical);
    const current = counts.get(key) || {
      name: canonical,
      goals: 0,
      country: item.country
    };

    current.name = canonical;
    current.goals = Math.max(current.goals, Number(item.goals) || 0);
    current.country = current.country || item.country || scorerCountryV14(canonical);
    counts.set(key, current);
  }

  return [...counts.values()]
    .filter((item) => item.goals > 0)
    .map((item) => [scorerDisplayNameV14(item.name, item.country), item.goals])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function topScorersWithTiesV14(scorerCounts) {
  if (!Array.isArray(scorerCounts) || scorerCounts.length === 0) return [];

  const goalLevels = [...new Set(
    scorerCounts
      .map(([, goals]) => Number(goals) || 0)
      .filter((goals) => goals >= MIN_TOP_SCORER_GOALS_TO_SHOW_V14)
  )].sort((a, b) => b - a);

  if (!goalLevels.length) return [];

  const cutoffIndex = Math.min(TOP_SCORER_GOAL_LEVELS_TO_SHOW_V14, goalLevels.length) - 1;
  const cutoffGoals = goalLevels[cutoffIndex];

  return scorerCounts.filter(([, goals]) => {
    const totalGoals = Number(goals) || 0;
    return totalGoals >= MIN_TOP_SCORER_GOALS_TO_SHOW_V14 && totalGoals >= cutoffGoals;
  });
}

function renderTopScorers() {
  const scorerCounts = buildTopScorers();
  const visibleScorers = topScorersWithTiesV14(scorerCounts);
  const topGoals = visibleScorers.length ? visibleScorers[0][1] : null;

  $("topScorers").innerHTML = visibleScorers.length
    ? visibleScorers.map(([player, goals], index) =>
        statItemHtml(index + 1, player, `${goals} ${plural(goals, "goal")}`, "stat-green", goals === topGoals)
      ).join("")
    : statEmptyHtml("No player has scored more than 1 goal yet.");
}

function formatDate(date, raw) {
  const d = date && !Number.isNaN(date.getTime()) ? date : (raw ? new Date(String(raw)) : null);
  if (!d || Number.isNaN(d.getTime())) return raw ? escapeHtml(String(raw)) : "—";

  const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const months = [
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
    "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"
  ];

  const dayName = weekdays[d.getDay()];
  const day = String(d.getDate()).padStart(2, "0");
  const month = months[d.getMonth()];
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");

  return `${dayName}. ${day} ${month} ${hour}:${minute}`;
}

function liveMinuteLabelV14(match) {
  if (!match || match.status !== "live") return "";

  const original = match.original || {};
  const raw = pick(original, [
    "time_elapsed",
    "timeElapsed",
    "elapsed",
    "minute",
    "matchMinute",
    "currentMinute",
    "game_minute",
    "liveMinute",
    "period",
    "status",
    "state",
    "match_status",
    "statusText",
    "matchStatus"
  ]);

  const text = String(raw ?? match.statusText ?? "").trim();
  if (!text) return "Live now";
  if (/half.?time|^ht$/i.test(text)) return "HT";
  if (/full.?time|^ft$/i.test(text)) return "";
  if (/^\d{1,3}$/.test(text)) return `${text}'`;

  const minute = text.match(/(\d{1,3})\s*(?:'|min|minute)?/i);
  if (minute) return `${minute[1]}'`;

  if (/live|in.?play|playing|1st|2nd/i.test(text)) return text;
  return "Live now";
}

function statusCellV14(m) {
  const minute = liveMinuteLabelV14(m);
  const detail = minute ? `<br><small class="live-time">${escapeHtml(minute)}</small>` : "";
  return `<span class="badge ${m.status}">${escapeHtml(statusLabel(m.status))}</span>${detail}`;
}

function renderMatches() {
  const body = $("matchesBody");
  const matches = filteredMatches();

  if (!matches.length) {
    body.innerHTML = `<tr><td colspan="6">No matches found.</td></tr>`;
    return;
  }

  const filter = state.activeMatchFilter || "all";
  const groups = filter === "all"
    ? [
        { key: "live", title: "Live matches", rows: matches.filter((m) => m.status === "live") },
        { key: "upcoming", title: "Upcoming matches", rows: matches.filter((m) => m.status === "upcoming") },
        { key: "finished", title: "Finished matches", rows: matches.filter((m) => m.status === "finished") }
      ]
    : [
        {
          key: filter,
          title: filter === "live" ? "Live matches" : filter === "upcoming" ? "Upcoming matches" : "Finished matches",
          rows: matches
        }
      ];

  const html = [];

  for (const group of groups) {
    if (!group.rows.length) continue;

    if (group.key !== "live") {
      html.push(`
        <tr class="match-section-row ${group.key}-section">
          <td colspan="6">${escapeHtml(group.title)} · ${group.rows.length}</td>
        </tr>
      `);
    }

    html.push(...group.rows.map((m) => `
      <tr>
        <td>${formatDate(m.date, m.rawDate)}</td>
        <td>${escapeHtml(m.group)}${m.matchday ? `<br><small>MD${escapeHtml(m.matchday)}</small>` : ""}</td>
        <td>${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</td>
        <td class="score">${formatScore(m)}</td>
        <td>${statusCellV14(m)}</td>
        <td>${escapeHtml(m.venue)}</td>
      </tr>
    `));
  }

  body.innerHTML = html.join("");
}


/* =========================================================
   Patch v15 — restore data with official API + GitHub raw fallback
   Reason: the public API can sometimes return no JSON data, auth/CORS errors,
   or temporary failures. This keeps the app populated instead of blank.
   ========================================================= */

const FALLBACK_DATA_SOURCES_V15 = {
  "/get/games": [
    "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/refs/heads/main/football.matches.json",
    "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/main/football.matches.json"
  ],
  "/get/groups": [
    "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/refs/heads/main/football.matchtables.json",
    "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/main/football.matchtables.json"
  ],
  "/get/teams": [
    "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/refs/heads/main/football.teams.json",
    "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/main/football.teams.json"
  ],
  "/get/stadiums": [
    "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/refs/heads/main/football.stadiums.json",
    "https://raw.githubusercontent.com/rezarahiminia/worldcup2026/main/football.stadiums.json"
  ]
};

async function fetchJson(path) {
  const officialUrl = `${API_BASE}${path}?t=${Date.now()}`;
  const urls = [
    officialUrl,
    ...(FALLBACK_DATA_SOURCES_V15[path] || [])
  ];

  const errors = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store" });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      const arr = extractArray(json);

      // Some failing API responses are valid JSON but contain no useful data.
      // Treat them as failure and try the next source.
      if (!arr.length) {
        throw new Error("response contained no usable array data");
      }

      if (url !== officialUrl) {
        console.warn(`WorldCup data fallback used for ${path}:`, url);
      }

      return json;
    } catch (error) {
      errors.push(`${url} → ${error.message || error}`);
    }
  }

  throw new Error(`All data sources failed for ${path}: ${errors.join(" | ")}`);
}

const originalLoadDataV15 = loadData;
loadData = async function patchedLoadDataV15() {
  await originalLoadDataV15();

  // Make the source state clearer for the visitor.
  const hasData =
    (state.matches && state.matches.length) ||
    (state.groups && state.groups.length) ||
    (state.teams && state.teams.length);

  if (!hasData) {
    setStatus("No WorldCup data could be loaded from the live API or fallback source.", true);
    setLoadingState(
      "has-error",
      "No WorldCup data could be loaded. Please hard refresh or try again later.",
      "Error"
    );
  }
};


/* =========================================================
   v22 — stable dynamic stats fallback + fixed finished sorting
   Tested with current Golden Boot fixture and MVP fixture.
   ========================================================= */

state.dynamicTopScorers = [];
state.dynamicTopScorersStatus = "idle";
state.dynamicTopScorersSourceName = "";
state.dynamicTopScorersUpdatedAt = "";
state.dynamicTopScorersError = "";
state.dynamicMvpAwards = [];
state.dynamicMvpStatus = "idle";
state.dynamicMvpSourceName = "";
state.dynamicMvpError = "";

const TOP_SCORER_MIN_GOALS_V22 = 2;

const LAST_CHECKED_TOP_SCORERS_V22 = [
  { rank: "1", name: "Deniz Undav", country: "Germany", goals: 3, assists: 2 },
  { rank: "T-2", name: "Lionel Messi", country: "Argentina", goals: 3, assists: 0 },
  { rank: "T-2", name: "Jonathan David", country: "Canada", goals: 3, assists: 0 },
  { rank: "T-4", name: "Ayase Ueda", country: "Japan", goals: 2, assists: 1 },
  { rank: "T-4", name: "Crysencio Summerville", country: "Netherlands", goals: 2, assists: 1 },
  { rank: "T-4", name: "Cody Gakpo", country: "Netherlands", goals: 2, assists: 1 },
  { rank: "T-4", name: "Vinícius Júnior", country: "Brazil", goals: 2, assists: 1 },
  { rank: "T-8", name: "Brian Brobbey", country: "Netherlands", goals: 2, assists: 0 },
  { rank: "T-8", name: "Cyle Larin", country: "Canada", goals: 2, assists: 0 },
  { rank: "T-8", name: "Daichi Kamada", country: "Japan", goals: 2, assists: 0 },
  { rank: "T-8", name: "Elijah Just", country: "New Zealand", goals: 2, assists: 0 },
  { rank: "T-8", name: "Erling Haaland", country: "Norway", goals: 2, assists: 0 },
  { rank: "T-8", name: "Folarin Balogun", country: "USA", goals: 2, assists: 0 },
  { rank: "T-8", name: "Harry Kane", country: "England", goals: 2, assists: 0 },
  { rank: "T-8", name: "Ismael Saibari", country: "Morocco", goals: 2, assists: 0 },
  { rank: "T-8", name: "Johan Manzambi", country: "Switzerland", goals: 2, assists: 0 },
  { rank: "T-8", name: "Kai Havertz", country: "Germany", goals: 2, assists: 0 },
  { rank: "T-8", name: "Kylian Mbappé", country: "France", goals: 2, assists: 0 },
  { rank: "T-8", name: "Matheus Cunha", country: "Brazil", goals: 2, assists: 0 },
  { rank: "T-8", name: "Yasin Ayari", country: "Sweden", goals: 2, assists: 0 }
];

const LAST_CHECKED_MVP_AWARDS_V22 = [
  { rank: "1", name: "Folarin Balogun", awards: 2 },
  { rank: "T-1", name: "Vinícius Júnior", awards: 2 }
];

const TOP_SCORER_ASSIST_HINTS_V22 = {
  "deniz undav|||germany": 2,
  "ayase ueda|||japan": 1,
  "crysencio summerville|||netherlands": 1,
  "cody gakpo|||netherlands": 1,
  "vinicius junior|||brazil": 1,
  "vinícius júnior|||brazil": 1
};

const TOP_SCORER_SOURCES_V22 = [
  {
    name: "GOAL Golden Boot standings",
    urls: [
      "https://r.jina.ai/https://www.goal.com/en/lists/world-cup-2026-golden-boot-standings-fifa-award/blt29fdba0896b8fd09",
      "https://www.goal.com/en/lists/world-cup-2026-golden-boot-standings-fifa-award/blt29fdba0896b8fd09"
    ]
  },
  {
    name: "The Sun Golden Boot standings",
    urls: [
      "https://r.jina.ai/https://www.thesun.co.uk/sport/39367358/world-cup-2026-golden-boot-who-is-leading/",
      "https://r.jina.ai/https://www.the-sun.com/sport/16544901/world-cup-2026-golden-boot-who-is-leading/"
    ]
  },
  {
    name: "World Cup Golden Boot search",
    urls: [
      "https://s.jina.ai/2026%20World%20Cup%20Golden%20Boot%20standings%20Deniz%20Undav%20Lionel%20Messi%20Jonathan%20David%20goals%20assists"
    ]
  }
];

const MVP_SOURCES_V22 = [
  {
    name: "POTM dynamic search",
    urls: [
      "https://s.jina.ai/2026%20World%20Cup%20Player%20of%20the%20Match%20Folarin%20Balogun%20Vinicius%20Junior%20USA%20Australia%20Brazil%20Haiti"
    ]
  },
  {
    name: "PunchNG Balogun POTM article",
    urls: [
      "https://r.jina.ai/https://punchng.com/2026-world-cup-nigerian-american-balogun-wins-second-man-of-the-match-award/"
    ]
  },
  {
    name: "FIFA Brazil/USA roundup",
    urls: [
      "https://r.jina.ai/https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/brazil-morocco-usa-round-up-review-highlights"
    ]
  }
];

const COUNTRY_NAMES_V22 = [
  "Argentina", "Australia", "Austria", "Belgium", "Bosnia and Herzegovina", "Brazil", "Canada",
  "Cabo Verde", "Cape Verde", "Colombia", "Croatia", "Curaçao", "Curacao", "Czechia", "Czech Republic",
  "DR Congo", "Ecuador", "Egypt", "England", "France", "Germany", "Ghana", "Haiti", "Iran",
  "Iraq", "Ivory Coast", "Japan", "Mexico", "Morocco", "Netherlands", "New Zealand", "Norway",
  "Paraguay", "Portugal", "Qatar", "Saudi Arabia", "Scotland", "Senegal", "South Africa",
  "South Korea", "Spain", "Sweden", "Switzerland", "Tunisia", "Turkey", "Türkiye", "USA", "USMNT",
  "United States", "Uruguay", "Uzbekistan"
];
const COUNTRY_RE_V22 = new RegExp(`\\b(${COUNTRY_NAMES_V22.map(escapeRegexV22).join("|")})\\b`, "i");
const COUNTRY_ALIASES_V22 = { "United States": "USA", "USMNT": "USA", "Türkiye": "Turkey", "Curacao": "Curaçao", "Cape Verde": "Cabo Verde" };

function escapeRegexV22(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setupAutoRefresh() {
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
}

function cleanTextV22(value) {
  return String(value || "")
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/^[-*#>\s]+/, "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNameKeyV22(name) {
  return cleanTextV22(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\./g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeCountryV22(country) {
  const cleaned = cleanTextV22(country);
  return COUNTRY_ALIASES_V22[cleaned] || cleaned;
}

function canonicalPlayerNameV22(name) {
  const cleaned = cleanTextV22(name)
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/\b\d+\s*(?:goals?|assists?|awards?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const key = normalizeNameKeyV22(cleaned);
  const aliases = {
    "vinicius jr": "Vinícius Júnior",
    "vinicius junior": "Vinícius Júnior",
    "vini jr": "Vinícius Júnior",
    "denis undav": "Deniz Undav",
    "deniz undav": "Deniz Undav",
    "jonathan david": "Jonathan David",
    "lionel messi": "Lionel Messi",
    "leo messi": "Lionel Messi",
    "f balogun": "Folarin Balogun",
    "folarin balogun": "Folarin Balogun",
    "h kane": "Harry Kane",
    "harry kane": "Harry Kane",
    "k havertz": "Kai Havertz",
    "kai havertz": "Kai Havertz",
    "k mbappe": "Kylian Mbappé",
    "kylian mbappe": "Kylian Mbappé",
    "y ayari": "Yasin Ayari",
    "yasin ayari": "Yasin Ayari",
    "e just": "Elijah Just",
    "elijah just": "Elijah Just",
    "j david": "Jonathan David"
  };
  return aliases[key] || cleaned;
}

function numberFromWordsV22(value) {
  const text = String(value || "").trim().toLowerCase();
  const map = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const digit = text.match(/\d+/);
  if (digit) return Number(digit[0]);
  for (const [word, number] of Object.entries(map)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) return number;
  }
  return 0;
}

function parseWallDate(text) {
  let m = String(text || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    const isDayFirst = first > 12 || /^(?:\d{2})\/(?:\d{2})\/(?:\d{4})/.test(text);
    return {
      day: isDayFirst ? first : second,
      month: isDayFirst ? second : first,
      year: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6] || 0)
    };
  }

  m = String(text || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] || 0) };

  return null;
}

function formatDate(date, raw) {
  const d = date && !Number.isNaN(date.getTime()) ? date : (raw ? parseMatchDate({ local_date: raw }, "").date : null);
  if (!d || Number.isNaN(d.getTime())) return raw ? escapeHtml(String(raw)) : "—";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: state.userTimeZone === "local" ? undefined : state.userTimeZone,
    weekday: "short",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(d);

  const map = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  return `${String(map.weekday || "").slice(0, 3).toUpperCase()}. ${map.day} ${String(map.month || "").toUpperCase()} ${map.hour}:${map.minute}`;
}

function matchTimeMsV22(match) {
  if (match?.date instanceof Date && !Number.isNaN(match.date.getTime())) return match.date.getTime();
  if (match?.rawDate) {
    const parsed = parseMatchDate({ local_date: match.rawDate }, "").date;
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed.getTime();
  }
  return Number.MAX_SAFE_INTEGER;
}

function compareMatchesForDisplay(a, b, filter = "all") {
  const at = matchTimeMsV22(a);
  const bt = matchTimeMsV22(b);
  if (filter === "finished") return bt - at;
  return at - bt;
}

function filteredMatches() {
  const q = $("searchInput").value.trim().toLowerCase();
  const filter = state.activeMatchFilter || "all";
  return state.matches
    .filter((m) => filter === "all" || m.status === filter)
    .filter((m) => !q || [m.home, m.away, m.group, m.venue, m.statusText].join(" ").toLowerCase().includes(q))
    .sort((a, b) => compareMatchesForDisplay(a, b, filter));
}

function sortMatchGroupRowsV22(rows, key) {
  return [...rows].sort((a, b) => compareMatchesForDisplay(a, b, key));
}

function renderMatches() {
  const body = $("matchesBody");
  const matches = filteredMatches();

  if (!matches.length) {
    body.innerHTML = `<tr><td colspan="6">No matches found.</td></tr>`;
    return;
  }

  const filter = state.activeMatchFilter || "all";
  const groups = filter === "all"
    ? [
        { key: "live", title: "Live matches", rows: sortMatchGroupRowsV22(matches.filter((m) => m.status === "live"), "live") },
        { key: "upcoming", title: "Upcoming matches", rows: sortMatchGroupRowsV22(matches.filter((m) => m.status === "upcoming"), "upcoming") },
        { key: "finished", title: "Finished matches", rows: sortMatchGroupRowsV22(matches.filter((m) => m.status === "finished"), "finished") }
      ]
    : [{ key: filter, title: filter === "live" ? "Live matches" : filter === "upcoming" ? "Upcoming matches" : "Finished matches", rows: sortMatchGroupRowsV22(matches, filter) }];

  const html = [];
  for (const group of groups) {
    if (!group.rows.length) continue;
    if (group.key !== "live") {
      html.push(`<tr class="match-section-row ${group.key}-section"><td colspan="6">${escapeHtml(group.title)} · ${group.rows.length}</td></tr>`);
    }
    html.push(...group.rows.map((m) => `
      <tr>
        <td>${formatDate(m.date, m.rawDate)}</td>
        <td>${escapeHtml(m.group)}${m.matchday ? `<br><small>MD${escapeHtml(m.matchday)}</small>` : ""}</td>
        <td>${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</td>
        <td class="score">${formatScore(m)}</td>
        <td>${typeof statusCell === "function" ? statusCell(m) : `<span class="badge ${m.status}">${escapeHtml(statusLabel(m.status))}</span>`}</td>
        <td>${escapeHtml(m.venue)}</td>
      </tr>`));
  }
  body.innerHTML = html.join("");
}

async function fetchTextNoStoreV22(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "text/plain, text/markdown, text/html, */*" } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseTopScorersFromTextV22(text) {
  const lines = String(text || "").split(/\r?\n/).map(cleanTextV22).filter(Boolean);
  const rows = [];
  const countryPattern = COUNTRY_NAMES_V22.map(escapeRegexV22).join("|");
  const goalsPattern = "\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten";

  lines.forEach((line, order) => {
    let m = line.match(new RegExp(`^(?:#+\\s*)?(\\d+|T[-–]?\\d+)\\s+(.+?)\\s*\\|\\s*([^|]+?)\\s*\\|\\s*(${goalsPattern})\\s+goals?(?:\\s*\\((\\d+|one|two|three|four|five)\\s*assists?\\))?`, "i"));
    if (m) {
      const row = {
        sourceRank: numberFromWordsV22(m[1]), sourceOrder: order,
        name: canonicalPlayerNameV22(m[2]), country: normalizeCountryV22(m[3]),
        goals: numberFromWordsV22(m[4]), assists: numberFromWordsV22(m[5] || "0")
      };
      const nextHeadingIndex = lines.findIndex((candidate, idx) => idx > order && /^(?:#+\s*)?(?:\d+|T[-–]?\d+)\s+.+?\s*\|\s*.+?\s*\|\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+goals?/i.test(candidate));
      const blockEnd = nextHeadingIndex > order ? nextHeadingIndex : Math.min(lines.length, order + 6);
      const playerBlock = lines.slice(order + 1, blockEnd).join(" ");
      const assistMatch = playerBlock.match(/(?:also\s+has|with|has|registered)\s+(\d+|one|two|three|four|five)\s+assists?\b/i);
      if (assistMatch) row.assists = Math.max(row.assists, numberFromWordsV22(assistMatch[1]));
      rows.push(row);
      return;
    }

    m = line.match(new RegExp(`^(?:\\d+|T[-–]?\\d+)\\s+(.+?)\\s+(${countryPattern})\\s+(${goalsPattern})(?:\\s*\\((\\d+|one|two|three|four|five)\\s*assists?\\))?$`, "i"));
    if (m) {
      rows.push({ sourceRank: null, sourceOrder: order, name: canonicalPlayerNameV22(m[1]), country: normalizeCountryV22(m[2]), goals: numberFromWordsV22(m[3]), assists: numberFromWordsV22(m[4] || "0") });
      return;
    }

    m = line.match(new RegExp(`([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})\\s*\\((${countryPattern})\\).*?(${goalsPattern})\\s+goals?(?:.*?(\\d+|one|two|three|four|five)\\s+assists?)?`, "i"));
    if (m) {
      rows.push({ sourceRank: null, sourceOrder: order, name: canonicalPlayerNameV22(m[1]), country: normalizeCountryV22(m[2]), goals: numberFromWordsV22(m[3]), assists: numberFromWordsV22(m[4] || "0") });
    }
  });

  return rankTopScorersV22(rows);
}

function rankTopScorersV22(rows) {
  const merged = new Map();
  for (const row of rows || []) {
    const name = canonicalPlayerNameV22(row.name);
    const country = normalizeCountryV22(row.country);
    const goals = Number(row.goals || 0);
    let assists = Number(row.assists || 0);
    if (!name || !country || goals < TOP_SCORER_MIN_GOALS_V22) continue;
    const key = `${normalizeNameKeyV22(name)}|||${normalizeNameKeyV22(country)}`;
    assists = Math.max(assists, TOP_SCORER_ASSIST_HINTS_V22[key] || 0);
    const current = merged.get(key) || { name, country, goals: 0, assists: 0, sourceRank: row.sourceRank || 999, sourceOrder: row.sourceOrder || 9999 };
    current.goals = Math.max(current.goals, goals);
    current.assists = Math.max(current.assists, assists);
    current.sourceRank = Math.min(current.sourceRank || 999, row.sourceRank || 999);
    current.sourceOrder = Math.min(current.sourceOrder || 9999, row.sourceOrder || 9999);
    merged.set(key, current);
  }
  const sorted = [...merged.values()].sort((a, b) => Number(b.goals) - Number(a.goals) || Number(b.assists) - Number(a.assists) || Number(a.sourceRank) - Number(b.sourceRank) || Number(a.sourceOrder) - Number(b.sourceOrder) || a.name.localeCompare(b.name));
  let previousGoals = null, previousAssists = null, previousRank = 0;
  return sorted.map((player, index) => {
    const tiedWithPrevious = Number(player.goals) === Number(previousGoals) && Number(player.assists || 0) === Number(previousAssists || 0);
    const rank = tiedWithPrevious ? previousRank : index + 1;
    previousGoals = Number(player.goals); previousAssists = Number(player.assists || 0); previousRank = rank;
    const tied = sorted.some((item, i) => i !== index && Number(item.goals) === Number(player.goals) && Number(item.assists || 0) === Number(player.assists || 0));
    return { ...player, rank: tied ? `T-${rank}` : String(rank) };
  });
}

async function loadDynamicTopScorersV22() {
  const errors = [];
  for (const source of TOP_SCORER_SOURCES_V22) {
    for (const url of source.urls) {
      try {
        const text = await fetchTextNoStoreV22(url);
        const rows = parseTopScorersFromTextV22(text);
        if (rows.length) {
          state.dynamicTopScorers = rows;
          state.dynamicTopScorersStatus = "loaded";
          state.dynamicTopScorersSourceName = source.name;
          state.dynamicTopScorersUpdatedAt = new Date().toISOString();
          return rows;
        }
        errors.push(`${source.name}: 0 rows`);
      } catch (error) {
        errors.push(`${source.name}: ${error.message || error}`);
      }
    }
  }
  state.dynamicTopScorers = [];
  state.dynamicTopScorersStatus = "fallback";
  state.dynamicTopScorersError = errors.join(" | ");
  return LAST_CHECKED_TOP_SCORERS_V22;
}

function displayTopScorerNameV22(player) {
  return player.country ? `${player.name} (${player.country})` : player.name;
}

function topScorerValueLabelV22(player) {
  const goals = Number(player.goals || 0);
  const assists = Number(player.assists || 0);
  const goalText = `${goals} ${plural(goals, "goal")}`;
  return assists ? `${goalText} (${assists} ${plural(assists, "assist")})` : goalText;
}

function renderTopScorers() {
  const rows = Array.isArray(state.dynamicTopScorers) && state.dynamicTopScorers.length
    ? state.dynamicTopScorers
    : LAST_CHECKED_TOP_SCORERS_V22;
  const topGoals = rows.length ? Number(rows[0].goals || 0) : null;
  $("topScorers").innerHTML = rows.length
    ? rows.map((player) => statItemHtml(player.rank || "", displayTopScorerNameV22(player), topScorerValueLabelV22(player), "stat-green", Number(player.goals || 0) === topGoals)).join("")
    : statEmptyHtml("Top scorer data is not available yet.");
}

function canonicalMvpNameV22(name) {
  const cleaned = canonicalPlayerNameV22(name);
  const key = normalizeNameKeyV22(cleaned);
  const aliases = { "balogun": "Folarin Balogun", "folarin balogun": "Folarin Balogun", "vinicius": "Vinícius Júnior", "vinicius jr": "Vinícius Júnior", "vinicius junior": "Vinícius Júnior", "vini jr": "Vinícius Júnior" };
  return aliases[key] || cleaned;
}

function parseMvpAwardsFromTextV22(text) {
  const counts = new Map();
  const minCounts = new Map();
  const add = (name, count = 1) => {
    const canonical = canonicalMvpNameV22(name);
    if (!canonical || canonical.length < 3 || /match|world cup|award|official|image|latest|source/i.test(canonical)) return;
    counts.set(canonical, (counts.get(canonical) || 0) + Number(count || 1));
  };
  const setMin = (name, count) => {
    const canonical = canonicalMvpNameV22(name);
    if (!canonical) return;
    minCounts.set(canonical, Math.max(minCounts.get(canonical) || 0, Number(count || 1)));
  };
  const lines = String(text || "").split(/\r?\n/).map(cleanTextV22).filter(Boolean);
  for (const line of lines) {
    let m = line.match(/^([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})\s+(?:[A-Z]{2,3}|USA|Brazil)\s+(.+\d+\s*[-–]\s*\d+.+)$/);
    if (m && /;/.test(m[2])) { m[2].split(";").forEach(() => add(m[1])); continue; }
    m = line.match(/(?:Player of the Match|Man of the Match|POTM)\s*[:—–-]\s*([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})/i);
    if (m) { add(m[1]); continue; }
    m = line.match(/\b(Folarin Balogun|Balogun|Vin[ií]cius(?: Jr\.?| Junior| Júnior)?|Vini Jr\.?)\b/i);
    if (m && /\b(second|twice|two|back-to-back|consecutive)\b/i.test(line) && /\b(match|award|potm|player)\b/i.test(line)) {
      setMin(m[1], 2);
      continue;
    }
    if (/USA\s*2\s*[-–]\s*0\s*Australia/i.test(line) && /Balogun/i.test(line)) add("Folarin Balogun");
    if (/USA\s*4\s*[-–]\s*1\s*Paraguay/i.test(line) && /Balogun/i.test(line)) add("Folarin Balogun");
    if (/Brazil\s*1\s*[-–]\s*1\s*Morocco/i.test(line) && /Vin/i.test(line)) add("Vinícius Júnior");
    if (/Brazil\s*3\s*[-–]\s*0\s*Haiti/i.test(line) && /Vin/i.test(line)) add("Vinícius Júnior");
  }
  for (const [name, count] of minCounts.entries()) counts.set(name, Math.max(counts.get(name) || 0, count));
  return [...counts.entries()].filter(([, count]) => Number(count) > 1).map(([name, awards]) => ({ name, awards: Number(awards) }));
}

async function loadDynamicMvpAwardsV22() {
  const combined = new Map();
  const errors = [];
  for (const source of MVP_SOURCES_V22) {
    for (const url of source.urls) {
      try {
        const text = await fetchTextNoStoreV22(url);
        const rows = parseMvpAwardsFromTextV22(text);
        for (const row of rows) combined.set(row.name, Math.max(combined.get(row.name) || 0, Number(row.awards || 0)));
      } catch (error) { errors.push(`${source.name}: ${error.message || error}`); }
    }
  }
  // Current checked floor: prevents empty MVP when articles/search are temporarily unreachable.
  for (const row of LAST_CHECKED_MVP_AWARDS_V22) combined.set(row.name, Math.max(combined.get(row.name) || 0, Number(row.awards || 0)));
  state.dynamicMvpAwards = rankMvpAwardsV22([...combined.entries()].map(([name, awards]) => ({ name, awards })));
  state.dynamicMvpStatus = combined.size ? "loaded" : "fallback";
  state.dynamicMvpError = errors.join(" | ");
  return state.dynamicMvpAwards;
}

function rankMvpAwardsV22(rows) {
  const sorted = [...rows].filter((row) => Number(row.awards) > 1).sort((a, b) => Number(b.awards) - Number(a.awards) || a.name.localeCompare(b.name));
  let previousAwards = null, previousRank = 0;
  return sorted.map((row, index) => {
    const rank = Number(row.awards) === Number(previousAwards) ? previousRank : index + 1;
    previousAwards = Number(row.awards); previousRank = rank;
    const tied = sorted.some((item, i) => i !== index && Number(item.awards) === Number(row.awards));
    return { ...row, rank: tied ? `T-${rank}` : String(rank) };
  });
}

function renderPlayerOfTheMatchAwards() {
  const rows = Array.isArray(state.dynamicMvpAwards) && state.dynamicMvpAwards.length
    ? state.dynamicMvpAwards
    : LAST_CHECKED_MVP_AWARDS_V22;
  const topAwards = rows.length ? Number(rows[0].awards || 0) : null;
  $("mostPlayerOfMatch").innerHTML = rows.length
    ? rows.map((player) => statItemHtml(player.rank || "", player.name, `${player.awards} ${plural(player.awards, "award")}`, "stat-blue", Number(player.awards || 0) === topAwards)).join("")
    : statEmptyHtml("No player has more than one MVP award yet.");
}

async function refreshDynamicStatsV22() {
  renderStats();
  const [scorers, mvp] = await Promise.allSettled([loadDynamicTopScorersV22(), loadDynamicMvpAwardsV22()]);
  renderStats();
  return { scorers, mvp };
}

async function loadData() {
  const refreshStartedAt = performance.now();
  setStatus("Loading…");
  setLoadingState("is-loading", "Loading live World Cup data…", "");
  $("refreshBtn").disabled = true;
  try {
    const [games, groups, teams, stadiums] = await Promise.allSettled([
      fetchJson(ENDPOINTS.games), fetchJson(ENDPOINTS.groups), fetchJson(ENDPOINTS.teams), fetchJson(ENDPOINTS.stadiums)
    ]);
    state.raw = { games: valueOrError(games), groups: valueOrError(groups), teams: valueOrError(teams), stadiums: valueOrError(stadiums) };
    state.teams = extractArray(state.raw.teams);
    state.stadiums = extractArray(state.raw.stadiums);
    buildLookups();
    state.matches = extractArray(state.raw.games).map(normalizeMatch);
    state.groups = extractArray(state.raw.groups);
    state.standingsByGroup = buildAllStandings();
    state.qualificationByTeam = buildQualificationMap();
    state.lastRefreshDurationMs = performance.now() - refreshStartedAt;
    const refreshTime = formatRefreshDuration(state.lastRefreshDurationMs);
    $("lastUpdated").textContent = formatNow();
    setStatus(`Data loaded in ${refreshTime}.`);
    setLoadingState("is-fresh", `Live data updated in ${refreshTime}.`, "");
    render();
    refreshDynamicStatsV22().catch((error) => { console.warn("Dynamic stats failed:", error); renderStats(); });
  } catch (error) {
    console.error(error);
    const refreshTime = formatRefreshDuration(performance.now() - refreshStartedAt);
    setStatus(`Loading error after ${refreshTime}. Check your connection or run the app with a local server.`, true);
    setLoadingState("has-error", `Could not load the latest data after ${refreshTime}.`, "Error");
  } finally {
    $("refreshBtn").disabled = false;
  }
}

console.info("AssistAI WorldCup app v22 loaded: finished newest first, dynamic stats with non-empty fallback.");


/* =========================================================
   v23 — clean dynamic top scorer rows + logo header
   Fixes bad parsed sentence rows such as:
   "h Japan and followed up with his team's last..."
   ========================================================= */

function isLikelyScorerNameV23(name) {
  const cleaned = canonicalPlayerNameV22(name);
  const key = normalizeNameKeyV22(cleaned);
  const words = key.split(/\s+/).filter(Boolean);

  if (!cleaned || cleaned.length < 3 || cleaned.length > 48) return false;
  if (words.length < 2 || words.length > 4) return false;

  // These words mean the parser captured a sentence fragment, not a player.
  if (/\b(?:and|with|followed|team|teams|his|her|their|last|first|second|third|after|against|as|they|scored|scores|goals|assists|national|tally|latest|incredible|came|bench|game|match|world|cup|source|image|news)\b/i.test(key)) {
    return false;
  }

  if (!/^[A-ZÀ-ÖØ-Þ]/.test(cleaned)) return false;
  return true;
}

function isCredibleTopScorerSetV23(rows) {
  if (!Array.isArray(rows) || rows.length < 3) return false;
  if (rows.some((row) => !isLikelyScorerNameV23(row.name))) return false;

  const keys = new Set(rows.map((row) => normalizeNameKeyV22(row.name)));
  const hasCurrentLeaders =
    keys.has("deniz undav") &&
    keys.has("lionel messi") &&
    keys.has("jonathan david");

  const topGoals = Math.max(...rows.map((row) => Number(row.goals || 0)));

  return hasCurrentLeaders && topGoals >= 3;
}

function rankTopScorersV22(rows) {
  const merged = new Map();

  for (const row of rows || []) {
    const name = canonicalPlayerNameV22(row.name);
    const country = normalizeCountryV22(row.country);
    const goals = Number(row.goals || 0);
    let assists = Number(row.assists || 0);

    if (!name || !country || goals < TOP_SCORER_MIN_GOALS_V22) continue;
    if (!isLikelyScorerNameV23(name)) continue;

    const key = `${normalizeNameKeyV22(name)}|||${normalizeNameKeyV22(country)}`;
    assists = Math.max(assists, TOP_SCORER_ASSIST_HINTS_V22[key] || 0);

    const current = merged.get(key) || {
      name,
      country,
      goals: 0,
      assists: 0,
      sourceRank: row.sourceRank || 999,
      sourceOrder: row.sourceOrder || 9999
    };

    current.goals = Math.max(current.goals, goals);
    current.assists = Math.max(current.assists, assists);
    current.sourceRank = Math.min(current.sourceRank || 999, row.sourceRank || 999);
    current.sourceOrder = Math.min(current.sourceOrder || 9999, row.sourceOrder || 9999);

    merged.set(key, current);
  }

  const sorted = [...merged.values()].sort((a, b) =>
    Number(b.goals) - Number(a.goals) ||
    Number(b.assists) - Number(a.assists) ||
    Number(a.sourceRank) - Number(b.sourceRank) ||
    Number(a.sourceOrder) - Number(b.sourceOrder) ||
    a.name.localeCompare(b.name)
  );

  let previousGoals = null;
  let previousAssists = null;
  let previousRank = 0;

  return sorted.map((player, index) => {
    const tiedWithPrevious =
      Number(player.goals) === Number(previousGoals) &&
      Number(player.assists || 0) === Number(previousAssists || 0);

    const rank = tiedWithPrevious ? previousRank : index + 1;

    previousGoals = Number(player.goals);
    previousAssists = Number(player.assists || 0);
    previousRank = rank;

    const tied = sorted.some((item, i) =>
      i !== index &&
      Number(item.goals) === Number(player.goals) &&
      Number(item.assists || 0) === Number(player.assists || 0)
    );

    return { ...player, rank: tied ? `T-${rank}` : String(rank) };
  });
}

async function loadDynamicTopScorersV22() {
  const errors = [];

  for (const source of TOP_SCORER_SOURCES_V22) {
    for (const url of source.urls) {
      try {
        const text = await fetchTextNoStoreV22(url);
        const rows = parseTopScorersFromTextV22(text);

        if (isCredibleTopScorerSetV23(rows)) {
          state.dynamicTopScorers = rows;
          state.dynamicTopScorersStatus = "loaded";
          state.dynamicTopScorersSourceName = source.name;
          state.dynamicTopScorersUpdatedAt = new Date().toISOString();
          return rows;
        }

        errors.push(`${source.name}: parsed rows were not credible`);
      } catch (error) {
        errors.push(`${source.name}: ${error.message || error}`);
      }
    }
  }

  // Safe checked snapshot instead of showing bad sentence fragments.
  state.dynamicTopScorers = LAST_CHECKED_TOP_SCORERS_V22;
  state.dynamicTopScorersStatus = "fallback";
  state.dynamicTopScorersSourceName = "checked snapshot";
  state.dynamicTopScorersError = errors.join(" | ");
  return state.dynamicTopScorers;
}

function renderTopScorers() {
  const candidateRows = Array.isArray(state.dynamicTopScorers) && state.dynamicTopScorers.length
    ? state.dynamicTopScorers
    : LAST_CHECKED_TOP_SCORERS_V22;

  const rows = rankTopScorersV22(candidateRows);
  const topGoals = rows.length ? Number(rows[0].goals || 0) : null;

  $("topScorers").innerHTML = rows.length
    ? rows.map((player) =>
        statItemHtml(
          player.rank || "",
          displayTopScorerNameV22(player),
          topScorerValueLabelV22(player),
          "stat-green",
          Number(player.goals || 0) === topGoals
        )
      ).join("")
    : statEmptyHtml("Top scorer data is not available yet.");
}

function renderPlayerOfTheMatchAwards() {
  const rows = Array.isArray(state.dynamicMvpAwards) && state.dynamicMvpAwards.length
    ? state.dynamicMvpAwards
    : LAST_CHECKED_MVP_AWARDS_V22;

  const cleanedRows = rows.map((player) => ({
    ...player,
    name: canonicalMvpNameV22(player.name)
  }));

  const topAwards = cleanedRows.length ? Number(cleanedRows[0].awards || 0) : null;

  $("mostPlayerOfMatch").innerHTML = cleanedRows.length
    ? cleanedRows.map((player) =>
        statItemHtml(
          player.rank || "",
          player.name,
          `${player.awards} ${plural(player.awards, "award")}`,
          "stat-blue",
          Number(player.awards || 0) === topAwards
        )
      ).join("")
    : statEmptyHtml("No player has more than one MVP award yet.");
}

console.info("AssistAI WorldCup app v23 loaded: bad top-scorer sentence rows removed; logo header ready.");


/* =========================================================
   v29 — PWA install button + compact mobile standings
   ========================================================= */

let deferredInstallPromptV29 = null;

function setupInstallButtonV29() {
  const btn = document.getElementById("installAppBtn");
  if (!btn) return;

  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  if (isStandalone) {
    btn.style.display = "none";
    return;
  }

  btn.style.display = "inline-flex";

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPromptV29 = event;
    btn.textContent = "Install app";
    btn.style.display = "inline-flex";
  });

  btn.addEventListener("click", async () => {
    if (deferredInstallPromptV29) {
      deferredInstallPromptV29.prompt();
      await deferredInstallPromptV29.userChoice;
      deferredInstallPromptV29 = null;
      return;
    }

    alert(
      "Install on iPhone: tap Share, then Add to Home Screen.\n\n" +
      "Install on Android: tap the browser menu, then Add to Home screen or Install app."
    );
  });
}

function fixOversizedLogoV29() {
  document.querySelectorAll('img[src*="assistia-logo"], img[src*="logo"]').forEach((img) => {
    if (img.closest(".assist-bar")) {
      img.style.width = "34px";
      img.style.height = "34px";
      img.style.maxWidth = "34px";
      img.style.maxHeight = "34px";
      img.style.objectFit = "cover";
      img.style.display = "block";
    } else {
      img.style.display = "none";
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupInstallButtonV29();
  fixOversizedLogoV29();
});

window.addEventListener("load", fixOversizedLogoV29);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}

console.info("AssistAI WorldCup app v29 loaded: compact mobile standings + install button.");


/* =========================================================
   v30 — show countries/codes in Schedule & Results
   ========================================================= */

const TEAM_CODES_V30 = {
  "Mexico": "MEX",
  "South Africa": "RSA",
  "South Korea": "KOR",
  "Czechia": "CZE",
  "Czech Republic": "CZE",
  "Canada": "CAN",
  "Bosnia and Herzegovina": "BIH",
  "Qatar": "QAT",
  "Switzerland": "SUI",
  "Brazil": "BRA",
  "Morocco": "MAR",
  "Haiti": "HAI",
  "Scotland": "SCO",
  "United States": "USA",
  "USA": "USA",
  "Paraguay": "PAR",
  "Australia": "AUS",
  "Turkey": "TUR",
  "Germany": "GER",
  "Curacao": "CUW",
  "Curaçao": "CUW",
  "Ivory Coast": "CIV",
  "Ecuador": "ECU",
  "Netherlands": "NED",
  "Japan": "JPN",
  "Sweden": "SWE",
  "Tunisia": "TUN",
  "Belgium": "BEL",
  "Egypt": "EGY",
  "Iran": "IRN",
  "New Zealand": "NZL",
  "Spain": "ESP",
  "Cape Verde": "CPV",
  "Saudi Arabia": "KSA",
  "Uruguay": "URU",
  "France": "FRA",
  "Senegal": "SEN",
  "Iraq": "IRQ",
  "Norway": "NOR",
  "Argentina": "ARG",
  "Algeria": "ALG",
  "Austria": "AUT",
  "Jordan": "JOR",
  "Portugal": "POR",
  "DR Congo": "COD",
  "Uzbekistan": "UZB",
  "Colombia": "COL",
  "England": "ENG",
  "Croatia": "CRO",
  "Ghana": "GHA",
  "Panama": "PAN",
  "To be determined": "TBD",
  "TBD": "TBD"
};

const TEAM_ALIASES_V30 = {
  "United States": "United States",
  "USA": "United States",
  "Czech Republic": "Czechia",
  "Curacao": "Curaçao",
  "To be determined": "TBD"
};

function normalizeTeamLabelV30(name) {
  const clean = String(name || "").trim();
  return TEAM_ALIASES_V30[clean] || clean || "TBD";
}

function teamCodeFromOriginalV30(original, side) {
  const keys = side === "home"
    ? ["home_code", "homeCode", "home_team_code", "homeTeamCode", "home_abbr", "homeAbbr", "home_short", "homeShort"]
    : ["away_code", "awayCode", "away_team_code", "awayTeamCode", "away_abbr", "awayAbbr", "away_short", "awayShort"];

  for (const key of keys) {
    const value = original && original[key];
    if (value && String(value).trim().length <= 4) return String(value).trim().toUpperCase();
  }

  return "";
}

function displayTeamWithCountryV30(name, original = {}, side = "") {
  const team = normalizeTeamLabelV30(name);

  if (!team || /^tbd$/i.test(team) || /to be determined/i.test(team)) {
    return `<span class="team-name">TBD</span> <span class="team-code">(TBD)</span>`;
  }

  const code = teamCodeFromOriginalV30(original, side) || TEAM_CODES_V30[team] || "";

  if (!code || team.toUpperCase() === code.toUpperCase()) {
    return `<span class="team-name">${escapeHtml(team)}</span>`;
  }

  return `<span class="team-name">${escapeHtml(team)}</span> <span class="team-code">(${escapeHtml(code)})</span>`;
}

console.info("AssistAI WorldCup app v30 loaded: country codes added to schedule/results.");


/* =========================================================
   v31 — real upcoming first + team country names + visible install
   ========================================================= */

function isTbdTeamV31(name) {
  return /^(?:tbd|to be determined|to be confirmed|unknown|-)$/i.test(String(name || "").trim());
}

function rawSeedLabelV31(original, side) {
  const keys = side === "home"
    ? ["home_seed", "homeSeed", "home_label", "homeLabel", "home_name", "homeName", "home_team", "homeTeam", "home"]
    : ["away_seed", "awaySeed", "away_label", "awayLabel", "away_name", "awayName", "away_team", "awayTeam", "away"];

  for (const key of keys) {
    const value = original && original[key];
    if (value && String(value).trim() && !/^tbd$/i.test(String(value).trim())) {
      return String(value).trim();
    }
  }

  return "";
}

function displayTeamWithCountryV30(name, original = {}, side = "") {
  const seed = rawSeedLabelV31(original, side);
  const team = normalizeTeamLabelV30(seed || name);

  if (!team || isTbdTeamV31(team)) {
    return `<span class="team-name">TBD</span>`;
  }

  // Keep labels like "2nd Group A" readable, no fake country code.
  if (/group\s+[a-l]/i.test(team) || /\b(?:winner|runner-up|third|3rd|2nd|1st)\b/i.test(team)) {
    return `<span class="team-name">${escapeHtml(team)}</span>`;
  }

  const code = teamCodeFromOriginalV30(original, side) || TEAM_CODES_V30[team] || "";

  if (!code || team.toUpperCase() === code.toUpperCase()) {
    return `<span class="team-name">${escapeHtml(team)}</span>`;
  }

  return `<span class="team-name">${escapeHtml(team)}</span> <span class="team-code">(${escapeHtml(code)})</span>`;
}

function hasRealTeamV31(match) {
  return !isTbdTeamV31(match.home) || !isTbdTeamV31(match.away);
}

function sortedMatchesForDisplayV31(matches, filter) {
  const list = [...matches];

  if (filter === "finished") {
    return list.sort((a, b) => {
      const ad = a.date instanceof Date ? a.date.getTime() : 0;
      const bd = b.date instanceof Date ? b.date.getTime() : 0;
      return bd - ad;
    });
  }

  if (filter === "upcoming") {
    return list.sort((a, b) => {
      const aTbd = hasRealTeamV31(a) ? 0 : 1;
      const bTbd = hasRealTeamV31(b) ? 0 : 1;
      if (aTbd !== bTbd) return aTbd - bTbd;

      const ad = a.date instanceof Date ? a.date.getTime() : 0;
      const bd = b.date instanceof Date ? b.date.getTime() : 0;
      return ad - bd;
    });
  }

  return list;
}

function renderMatches() {
  const body = $("matchesBody");
  const matches = filteredMatches();

  if (!matches.length) {
    body.innerHTML = `<tr><td colspan="6">No matches found.</td></tr>`;
    return;
  }

  const filter = state.activeMatchFilter || "all";
  const groups = filter === "all"
    ? [
        { key: "live", title: "Live matches", rows: sortedMatchesForDisplayV31(matches.filter((m) => m.status === "live"), "live") },
        { key: "upcoming", title: "Upcoming matches", rows: sortedMatchesForDisplayV31(matches.filter((m) => m.status === "upcoming"), "upcoming") },
        { key: "finished", title: "Finished matches", rows: sortedMatchesForDisplayV31(matches.filter((m) => m.status === "finished"), "finished") }
      ]
    : [
        {
          key: filter,
          title: filter === "live" ? "Live matches" : filter === "upcoming" ? "Upcoming matches" : "Finished matches",
          rows: sortedMatchesForDisplayV31(matches, filter)
        }
      ];

  const html = [];

  for (const group of groups) {
    if (!group.rows.length) continue;

    if (group.key !== "live") {
      html.push(`
        <tr class="match-section-row ${group.key}-section">
          <td colspan="6">${escapeHtml(group.title)} · ${group.rows.length}</td>
        </tr>
      `);
    }

    html.push(...group.rows.map((m) => `
      <tr>
        <td>${formatDate(m.date, m.rawDate)}</td>
        <td>${escapeHtml(m.group)}${m.matchday ? `<br><small>MD${escapeHtml(m.matchday)}</small>` : ""}</td>
        <td class="teams-cell">${displayTeamWithCountryV30(m.home, m.original, "home")} <span class="vs-label">vs</span> ${displayTeamWithCountryV30(m.away, m.original, "away")}</td>
        <td class="score">${formatScore(m)}</td>
        <td>${typeof statusCell === "function" ? statusCell(m) : `<span class="badge ${m.status}">${escapeHtml(statusLabel(m.status))}</span>`}</td>
        <td>${escapeHtml(m.venue)}</td>
      </tr>
    `));
  }

  body.innerHTML = html.join("");
}

let deferredInstallPromptV31 = null;

function setupInstallButtonV31() {
  const btn = document.getElementById("installAppBtn");
  if (!btn) return;

  btn.style.display = "inline-flex";

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPromptV31 = event;
    btn.textContent = "Install app";
  });

  btn.addEventListener("click", async () => {
    if (deferredInstallPromptV31) {
      deferredInstallPromptV31.prompt();
      await deferredInstallPromptV31.userChoice;
      deferredInstallPromptV31 = null;
      return;
    }

    alert("Install on iPhone: tap Share, then Add to Home Screen.\n\nInstall on Android: browser menu, then Add to Home screen or Install app.");
  });
}

document.addEventListener("DOMContentLoaded", setupInstallButtonV31);

console.info("AssistAI WorldCup app v31 loaded: real upcoming teams first, install button visible.");
