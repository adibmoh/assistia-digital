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

const CACHE_KEY = "assistai_worldcup_at_a_glance_cache_v1";
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

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

  const hadCachedData = loadCachedData();
  loadData({ background: hadCachedData });
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

function loadCachedData() {
  const cached = readCache();
  if (!cached || !cached.raw) return false;

  try {
    applyPayloadToState(cached.raw);
    const savedAt = cached.savedAt ? new Date(cached.savedAt) : null;
    const age = savedAt ? Date.now() - savedAt.getTime() : Number.POSITIVE_INFINITY;

    if ($("lastUpdated")) {
      $("lastUpdated").textContent = savedAt
        ? `${formatDateTime(savedAt)} · cached`
        : "Cached data";
    }

    setStatus(age <= CACHE_MAX_AGE_MS ? "Showing cached data. Refreshing in background…" : "Showing older cached data. Refreshing in background…");
    setLoadingState("is-fresh", "Showing cached data while refreshing…", "Cache");
    render();
    return true;
  } catch (error) {
    console.warn("Could not read cached World Cup data:", error);
    return false;
  }
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      raw: state.raw
    }));
  } catch (error) {
    console.warn("Could not save World Cup cache:", error);
  }
}

function applyPayloadToState(raw) {
  state.raw = raw || {};
  state.teams = extractArray(state.raw.teams);
  state.stadiums = extractArray(state.raw.stadiums);
  buildLookups();

  state.matches = extractArray(state.raw.games).map(normalizeMatch);
  state.groups = extractArray(state.raw.groups);
  state.standingsByGroup = buildAllStandings();
  state.qualificationByTeam = buildQualificationMap();
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: state.userTimeZone === "local" ? undefined : state.userTimeZone
  }).format(date);
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

async function loadData(options = {}) {
  const refreshStartedAt = performance.now();
  const isBackground = Boolean(options.background);

  setStatus(isBackground ? "Refreshing latest data in background…" : "Loading…");
  if (!isBackground) setLoadingState("is-loading", "Loading live World Cup data…", "");
  $("refreshBtn").disabled = true;

  try {
    const [games, groups, teams, stadiums] = await Promise.allSettled([
      fetchJson(ENDPOINTS.games),
      fetchJson(ENDPOINTS.groups),
      fetchJson(ENDPOINTS.teams),
      fetchJson(ENDPOINTS.stadiums)
    ]);

    applyPayloadToState({
      games: valueOrError(games),
      groups: valueOrError(groups),
      teams: valueOrError(teams),
      stadiums: valueOrError(stadiums)
    });
    saveCache();

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
      <tr class="match-row">
        <td data-label="Time">${formatDate(m.date, m.rawDate)}</td>
        <td data-label="Group">${escapeHtml(m.group)}${m.matchday ? `<br><small>MD${escapeHtml(m.matchday)}</small>` : ""}</td>
        <td data-label="Match">${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</td>
        <td data-label="Score" class="score">${formatScore(m)}</td>
        <td data-label="Status"><span class="badge ${m.status}">${escapeHtml(statusLabel(m.status))}</span></td>
        <td data-label="Venue">${escapeHtml(m.venue)}</td>
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
      <table>
        <thead>
          <tr>
            <th>#</th><th>Team</th><th>Pts</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${teams.map((team) => `
            <tr class="${qualificationFor(groupName, team.name).rowClass}">
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
              <td class="${qualificationFor(groupName, team.name).textClass}">${qualificationFor(groupName, team.name).label}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
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
