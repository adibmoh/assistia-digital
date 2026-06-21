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
  if ($("autoRefresh")) $("autoRefresh").addEventListener("change", setupAutoRefresh);

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
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
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
    state.dynamicTopScorersStatus = "loading";
    state.dynamicTopScorers = [];
    state.dynamicTopScorersSourceName = "";

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
    setStatus(`Data loaded in ${refreshTime}. Dynamic stats refreshing…`);
    setLoadingState("is-fresh", `Live data updated in ${refreshTime}.`, "");
    render();

    loadDynamicTopScorers()
      .then(() => {
        renderTopScorers();
        if (state.dynamicTopScorersStatus === "loaded") {
          setStatus(`Data loaded in ${refreshTime}. Top scorers: ${state.dynamicTopScorersSourceName}.`);
        }
      })
      .catch((error) => {
        console.warn("Dynamic top scorer source failed:", error);
        state.dynamicTopScorersStatus = "error";
        state.dynamicTopScorersError = error.message || String(error);
        renderTopScorers();
      });

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
  const fallbackSources = {
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

  const urls = [
    `${API_BASE}${path}?t=${Date.now()}`,
    ...(fallbackSources[path] || [])
  ];

  const errors = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const json = await response.json();
      if (!extractArray(json).length) throw new Error("no usable array data");

      if (!url.startsWith(API_BASE)) {
        console.warn(`Using fallback WorldCup data for ${path}:`, url);
      }

      return json;
    } catch (error) {
      errors.push(`${url} → ${error.message || error}`);
    }
  }

  throw new Error(`All data sources failed for ${path}: ${errors.join(" | ")}`);
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

  const sources = [
    {
      name: "PunchNG Balogun second award",
      url: "https://punchng.com/2026-world-cup-nigerian-american-balogun-wins-second-man-of-the-match-award/"
    },
    {
      name: "FIFA Vinícius article",
      url: "https://www.fifa.com/en/articles/vinicius-jr-brazil-great-start"
    },
    {
      name: "PunchNG Player of the Match list",
      url: "https://punchng.com/full-list-all-2026-world-cup-player-of-the-match-winners-so-far/"
    },
    {
      name: "Vanguard Player of the Match list",
      url: "https://www.vanguardngr.com/2026/06/world-cup-full-list-of-all-man-of-the-match-winners-after-round-1/"
    },
    {
      name: "TalkSport Player of the Match list",
      url: "https://talksport.com/football/world-cup/4333029/world-cup-player-of-the-match-winner-list-voting/"
    }
  ];

  const combined = new Map();
  const sourceNames = [];
  const errors = [];

  for (const source of sources) {
    try {
      const readerUrl = `https://r.jina.ai/${source.url}`;
      const response = await fetchWithTimeout(readerUrl, 10000);

      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const text = await response.text();
      const awards = parsePlayerOfMatchAwardsFromText(text);

      if (awards.length) {
        sourceNames.push(source.name);

        for (const [rawName, count] of awards) {
          const name = canonicalPotmNameV20(rawName);
          if (!isValidPotmNameV20(name)) continue;

          // Use max, not sum: one source can say "second award" while another
          // source lists the first match. Adding them would incorrectly show 3.
          combined.set(name, Math.max(combined.get(name) || 0, Number(count || 1)));
        }
      }
    } catch (error) {
      errors.push(`${source.name}: ${error.message || error}`);
      console.warn(`Player of the Match source failed: ${source.name}`, error);
    }
  }

  if (combined.size) {
    state.playerOfMatchExternal = [...combined.entries()]
      .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
    state.playerOfMatchSourceStatus = "loaded";
    state.playerOfMatchSourceName = sourceNames.join(", ");
    state.playerOfMatchSourceUrl = sources[0].url;
    return;
  }

  state.playerOfMatchExternal = [];
  state.playerOfMatchSourceStatus = errors.length ? "error" : "empty";
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

function canonicalPotmNameV20(name) {
  const cleaned = cleanPotmCandidateV20(name);
  const key = cleaned
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const aliases = {
    "vini jr": "Vinícius Júnior",
    "vinicius jr": "Vinícius Júnior",
    "vinicius junior": "Vinícius Júnior",
    "vinicius junior brazil": "Vinícius Júnior",
    "vinicius jr brazil": "Vinícius Júnior",
    "folarin balogun": "Folarin Balogun",
    "balogun": "Folarin Balogun"
  };

  return aliases[key] || cleaned;
}

function cleanPotmCandidateV20(value) {
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
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidPotmNameV20(name) {
  const s = String(name || "").trim();
  if (!s || s.length < 3 || s.length > 64) return false;
  if (/^\d+$/.test(s)) return false;
  if (/\b(?:match|world cup|group|award|fifa|goals?|assists?|latest|news|image|official|superior)\b/i.test(s)) return false;
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(s);
}

function parseMatchLabelV20(line) {
  const m = String(line || "").match(/([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ .’'&-]{1,35})\s+\d+\s*[-–]\s*\d+\s+([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ .’'&-]{1,35})/);
  const score = String(line || "").match(/\d+\s*[-–]\s*\d+/);
  return m && score ? `${m[1].trim()} ${score[0]} ${m[2].trim()}` : "";
}

function parsePlayerOfMatchAwardsFromText(text) {
  const counts = new Map();
  const minCounts = new Map();
  let lastStrongName = "";

  const addAward = (rawName) => {
    const name = canonicalPotmNameV20(rawName);
    if (!isValidPotmNameV20(name)) return;

    counts.set(name, (counts.get(name) || 0) + 1);
    lastStrongName = name;
  };

  const setMinCount = (rawName, minCount) => {
    const name = canonicalPotmNameV20(rawName || lastStrongName);
    if (!isValidPotmNameV20(name)) return;

    minCounts.set(name, Math.max(minCounts.get(name) || 0, minCount));
    lastStrongName = name;
  };

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s]+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const line of lines) {
    let match;

    // Example: USA 4-1 Paraguay — Folarin Balogun (USA)
    match = line.match(/^(.+?)\s+(?:\d+\s*[-–]\s*\d+|vs|v)\s+(.+?)\s+[—–-]\s+([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})(?:\s*\([^)]+\))?\s*$/i);
    if (match && match[3]) {
      addAward(match[3]);
      continue;
    }

    // Example from user/test table:
    // Folarin Balogun    USA 4–1 Paraguay; USA 2–0 Australia
    match = line.match(/^([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})\s+([A-Z]{2,3}|[A-Z][A-Za-z ]+)\s+(.+\d+\s*[-–]\s*\d+.+)$/);
    if (match && /;/.test(match[3])) {
      const pieces = match[3].split(";").map((item) => item.trim()).filter(Boolean);
      for (const _piece of pieces) addAward(match[1]);
      continue;
    }

    // Example: Player of the Match — Folarin Balogun (USA)
    match = line.match(/\b(?:Man of the Match|Player of the Match|Superior Player of the Match|POTM)\b\s*[:—–-]\s*([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})(?:\s*\([^)]+\))?/i);
    if (match && match[1]) {
      addAward(match[1]);
      continue;
    }

    // Known current repeated winners. These patterns handle article wording like
    // "Balogun wins second..." and "Vinicius ... award twice".
    match = line.match(/\b(Folarin Balogun|Vin[ií]cius(?: Jr\.?| Junior| Júnior)?|Vini Jr\.?)\b/i);
    const knownName = match ? canonicalPotmNameV20(match[1]) : "";

    if (
      knownName &&
      /\b(?:second|twice|two|back-to-back|consecutive)\b/i.test(line) &&
      /\b(?:Man of the Match|Player of the Match|Superior Player of the Match|POTM|award)\b/i.test(line)
    ) {
      setMinCount(knownName, 2);
      continue;
    }

    // Generic "Name earned second Player of the Match award" pattern.
    match = line.match(/^([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60}?)\s+(?:continued|has|is|was|wins?|won|earned|earning|received|claim(?:ed|ing)|picked up|named)\b.{0,120}\b(?:second|twice|two|back-to-back|consecutive)\b.{0,120}\b(?:Man of the Match|Player of the Match|Superior Player of the Match|POTM|award)/i);
    if (match && match[1]) {
      setMinCount(match[1], 2);
      continue;
    }

    // "His latest award..." after a known player line/article title.
    if (/\b(?:His|Her|Their)\s+latest\s+award\b/i.test(line) && lastStrongName) {
      setMinCount(lastStrongName, 2);
      continue;
    }

    // Narrative first-award style:
    // Vinícius Júnior (Brazil) was named Player of the Match...
    match = line.match(/\b([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})\s*\(([^)]+)\).*?\b(?:earned|received|named|won).*?\b(?:award|honou?r|Player of the Match|Man of the Match)/i);
    if (match && match[1]) {
      addAward(match[1]);
      continue;
    }

    // Track strong known player names from titles/headings for following "his latest" lines.
    if (knownName) {
      lastStrongName = knownName;
    }
  }

  for (const [name, minCount] of minCounts.entries()) {
    counts.set(name, Math.max(counts.get(name) || 0, minCount));
  }

  return [...counts.entries()]
    .filter(([name, count]) => isValidPotmNameV20(name) && Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
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
    .sort((a, b) => compareMatchesForDisplay(a, b, filter));
}

function compareMatchesForDisplay(a, b, filter = "all") {
  const at = a.date?.getTime() || Number.MAX_SAFE_INTEGER;
  const bt = b.date?.getTime() || Number.MAX_SAFE_INTEGER;

  // Finished results should show newest first. Upcoming/live remain chronological.
  if (filter === "finished") return bt - at;
  return at - bt;
}

function sortMatchGroupRows(rows, key) {
  return [...rows].sort((a, b) => compareMatchesForDisplay(a, b, key));
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
        { key: "live", title: "Live matches", rows: sortMatchGroupRows(matches.filter((m) => m.status === "live"), "live") },
        { key: "upcoming", title: "Upcoming matches", rows: sortMatchGroupRows(matches.filter((m) => m.status === "upcoming"), "upcoming") },
        { key: "finished", title: "Finished matches", rows: sortMatchGroupRows(matches.filter((m) => m.status === "finished"), "finished") }
      ]
    : [
        {
          key: filter,
          title: filter === "live" ? "Live matches" : filter === "upcoming" ? "Upcoming matches" : "Finished matches",
          rows: sortMatchGroupRows(matches, filter)
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
        <td>${statusCell(m)}</td>
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
  const d = date && !Number.isNaN(date.getTime()) ? date : (raw ? new Date(String(raw)) : null);
  if (!d || Number.isNaN(d.getTime())) return raw ? escapeHtml(String(raw)) : "—";

  const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const months = [
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
    "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"
  ];

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

  const dayName = String(map.weekday || weekdays[d.getDay()]).slice(0, 3).toUpperCase();
  const day = String(map.day || d.getDate()).padStart(2, "0");
  const month = String(map.month || months[d.getMonth()]).toUpperCase();
  const hour = String(map.hour || d.getHours()).padStart(2, "0");
  const minute = String(map.minute || d.getMinutes()).padStart(2, "0");

  return `${dayName}. ${day} ${month} ${hour}:${minute}`;
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
  if (state.dynamicTopScorersStatus === "loading") {
    $("topScorers").innerHTML = statEmptyHtml("Loading dynamic top scorers…");
    return;
  }

  if (state.dynamicTopScorersStatus === "error") {
    $("topScorers").innerHTML = statEmptyHtml("Dynamic top scorer source is unavailable. Refresh again later.");
    return;
  }

  const rows = Array.isArray(state.dynamicTopScorers) ? state.dynamicTopScorers : [];
  const topGoals = rows.length ? Number(rows[0].goals || 0) : null;

  $("topScorers").innerHTML = rows.length
    ? rows.map((player) =>
        statItemHtml(
          player.rank || "",
          displayTopScorerName(player),
          topScorerValueLabel(player),
          "stat-green",
          Number(player.goals || 0) === topGoals
        )
      ).join("")
    : statEmptyHtml("Dynamic top scorer data is not available yet.");
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
    : statEmptyHtml(
        state.playerOfMatchSourceStatus === "error"
          ? "Player of the Match source is unavailable. Refresh again later."
          : "No player has more than one Player of the Match award yet."
      );
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

  // Use any player-of-match fields from the match API, if the API provides them.
  for (const match of state.matches) {
    const names = extractPlayerOfMatch(match.original);

    for (const rawName of names) {
      const name = canonicalPotmNameV20(rawName);
      if (!isValidPotmNameV20(name)) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  // Merge external dynamic sources using max, not sum, to avoid double-counting
  // the same award from multiple articles.
  for (const [rawName, count] of state.playerOfMatchExternal || []) {
    const name = canonicalPotmNameV20(rawName);
    if (!isValidPotmNameV20(name)) continue;
    counts.set(name, Math.max(counts.get(name) || 0, Number(count || 1)));
  }

  return [...counts.entries()].sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
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
   v18 — dynamic top scorers, no stale scorer fallback
   ========================================================= */

state.dynamicTopScorers = [];
state.dynamicTopScorersStatus = "idle";
state.dynamicTopScorersSourceName = "";
state.dynamicTopScorersError = "";
state.dynamicTopScorersUpdatedAt = "";

const TOP_SCORER_MIN_GOALS = 2;

const TOP_SCORER_SOURCES = [
  {
    name: "The Sun Golden Boot table",
    url: "https://r.jina.ai/https://www.thesun.co.uk/sport/39367358/world-cup-2026-golden-boot-who-is-leading/"
  },
  {
    name: "NBC Sports top goalscorers",
    url: "https://r.jina.ai/https://www.nbcsports.com/soccer/news/2026-world-cup-top-goalscorers-full-list-latest-on-race-for-the-golden-boot"
  },
  {
    name: "FOX Sports Golden Boot tracker",
    url: "https://r.jina.ai/https://www.foxsports.com/stories/soccer/2026-fifa-world-cup-golden-boot-tracker"
  },
  {
    name: "Jina web search",
    url: "https://s.jina.ai/2026%20FIFA%20World%20Cup%20top%20scorers%20Golden%20Boot%20goals%20assists%20Deniz%20Undav"
  }
];

const COUNTRY_NAMES = [
  "Argentina", "Australia", "Austria", "Belgium", "Bosnia and Herzegovina", "Brazil", "Canada", "Colombia",
  "Croatia", "Curaçao", "Czechia", "Czech Republic", "Denmark", "DR Congo", "Ecuador", "England", "France",
  "Germany", "Ghana", "Haiti", "Iran", "Iraq", "Ivory Coast", "Japan", "Mexico", "Morocco", "Netherlands",
  "New Zealand", "Norway", "Paraguay", "Portugal", "Qatar", "Saudi Arabia", "Scotland", "Senegal",
  "South Africa", "South Korea", "Spain", "Sweden", "Switzerland", "Tunisia", "Turkey", "USA", "United States",
  "Uruguay", "Uzbekistan"
];

const COUNTRY_ALIASES = {
  "United States": "USA",
  "Czech Republic": "Czechia"
};

const COUNTRY_RE = new RegExp(`\\b(${COUNTRY_NAMES.map(escapeRegex).join("|")})\\b`, "i");

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCountry(country) {
  const cleaned = cleanDynamicText(country);
  return COUNTRY_ALIASES[cleaned] || cleaned;
}

function cleanDynamicText(value) {
  return String(value || "")
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function playerKeyDynamic(value, country = "") {
  return `${cleanDynamicText(value)}|||${normalizeCountry(country)}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\./g, "")
    .replace(/[^a-zA-Z0-9|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function loadDynamicTopScorers() {
  state.dynamicTopScorersStatus = "loading";
  state.dynamicTopScorers = [];
  state.dynamicTopScorersError = "";
  renderTopScorers();

  const errors = [];

  for (const source of TOP_SCORER_SOURCES) {
    try {
      const text = await fetchTextNoStore(source.url);
      const rows = parseDynamicTopScorers(text);

      if (rows.length) {
        state.dynamicTopScorers = rankAndMergeTopScorers(rows);
        state.dynamicTopScorersStatus = "loaded";
        state.dynamicTopScorersSourceName = source.name;
        state.dynamicTopScorersUpdatedAt = new Date().toISOString();
        return state.dynamicTopScorers;
      }

      errors.push(`${source.name}: no scorer rows parsed`);
    } catch (error) {
      errors.push(`${source.name}: ${error.message || error}`);
      console.warn("Top scorer dynamic source failed:", source.name, error);
    }
  }

  throw new Error(errors.join(" | "));
}

async function fetchTextNoStore(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Accept": "text/plain, text/markdown, */*"
      }
    });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseDynamicTopScorers(text) {
  const rows = [];
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => cleanDynamicText(line))
    .filter(Boolean);

  rows.push(...parsePipeTables(lines));
  rows.push(...parseRankRows(lines));
  rows.push(...parseGoalBlocks(lines));
  rows.push(...parseSentenceRows(lines));

  return rows.filter((row) => Number(row.goals) >= TOP_SCORER_MIN_GOALS);
}

function parsePipeTables(lines) {
  const rows = [];

  for (const line of lines) {
    if (!line.includes("|")) continue;
    if (/rank|name|country|goals/i.test(line) && !/\d/.test(line)) continue;

    const cells = line
      .split("|")
      .map((cell) => cleanDynamicText(cell))
      .filter(Boolean);

    if (cells.length < 3) continue;

    const goalsCell = cells[cells.length - 1];
    const goalsInfo = parseGoalsAndAssists(goalsCell);
    if (!goalsInfo) continue;

    let country = "";
    let name = "";

    for (let i = cells.length - 2; i >= 0; i--) {
      if (COUNTRY_RE.test(cells[i])) {
        country = normalizeCountry(cells[i].match(COUNTRY_RE)[1]);
        name = cells[i - 1] || "";
        break;
      }
    }

    if (!country && cells.length >= 4) {
      name = cells[cells.length - 3];
      country = normalizeCountry(cells[cells.length - 2]);
    }

    name = cleanPlayerFromCell(name);

    if (name && country) {
      rows.push({ name, country, goals: goalsInfo.goals, assists: goalsInfo.assists });
    }
  }

  return rows;
}

function parseRankRows(lines) {
  const rows = [];
  const countryPattern = COUNTRY_NAMES.map(escapeRegex).join("|");
  const re = new RegExp(`^(?:\\d+|T[-–]?\\d+)\\s+(.+?)\\s+(${countryPattern})\\s+(\\d+)(?:\\s*\\((\\d+)\\s*assists?\\))?$`, "i");

  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;

    rows.push({
      name: cleanPlayerFromCell(m[1]),
      country: normalizeCountry(m[2]),
      goals: Number(m[3]),
      assists: Number(m[4] || 0)
    });
  }

  return rows;
}

function parseGoalBlocks(lines) {
  const rows = [];
  let currentGoals = null;

  for (const line of lines) {
    const goalHeader = line.match(/^(?:#{1,4}\s*)?(\d+)\s+goals?$/i);
    if (goalHeader) {
      currentGoals = Number(goalHeader[1]);
      continue;
    }

    if (!currentGoals) continue;

    const m = line.match(/^[-*]?\s*(.+?)\s*\(([^)]+)\)(?:\s*[-–—]\s*(\d+)\s*goals?)?$/i);
    if (m && COUNTRY_RE.test(m[2])) {
      rows.push({
        name: cleanPlayerFromCell(m[1]),
        country: normalizeCountry(m[2].match(COUNTRY_RE)[1]),
        goals: Number(m[3] || currentGoals),
        assists: 0
      });
    }
  }

  return rows;
}

function parseSentenceRows(lines) {
  const rows = [];
  const countryPattern = COUNTRY_NAMES.map(escapeRegex).join("|");

  for (const line of lines) {
    let m = line.match(new RegExp(`([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})\\s*\\((${countryPattern})\\).*?(\\d+)\\s+goals?(?:.*?(\\d+)\\s+assists?)?`, "i"));
    if (m) {
      rows.push({
        name: cleanPlayerFromCell(m[1]),
        country: normalizeCountry(m[2]),
        goals: Number(m[3]),
        assists: Number(m[4] || 0)
      });
      continue;
    }

    m = line.match(new RegExp(`([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})\\s+(${countryPattern})\\s+(\\d+)(?:\\s*\\((\\d+)\\s*assists?\\))?`, "i"));
    if (m) {
      rows.push({
        name: cleanPlayerFromCell(m[1]),
        country: normalizeCountry(m[2]),
        goals: Number(m[3]),
        assists: Number(m[4] || 0)
      });
    }
  }

  return rows;
}

function cleanPlayerFromCell(value) {
  return cleanDynamicText(value)
    .replace(/^(?:\d+|T[-–]?\d+)\s+/i, "")
    .replace(/\s*\[[^\]]+\]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseGoalsAndAssists(value) {
  const text = cleanDynamicText(value);
  const m = text.match(/(\d+)(?:\s*\((\d+)\s*assists?\))?/i);
  if (!m) return null;
  return {
    goals: Number(m[1]),
    assists: Number(m[2] || 0)
  };
}

function rankAndMergeTopScorers(rows) {
  const merged = new Map();

  for (const row of rows) {
    const name = cleanPlayerFromCell(row.name);
    const country = normalizeCountry(row.country);
    const goals = Number(row.goals);
    const assists = Number(row.assists || 0);

    if (!name || !country || !Number.isFinite(goals) || goals < TOP_SCORER_MIN_GOALS) continue;

    const key = playerKeyDynamic(name, country);
    const current = merged.get(key) || { name, country, goals: 0, assists: 0 };

    current.goals = Math.max(current.goals, goals);
    current.assists = Math.max(current.assists, assists);
    merged.set(key, current);
  }

  const sorted = [...merged.values()]
    .sort((a, b) =>
      Number(b.goals) - Number(a.goals) ||
      Number(b.assists) - Number(a.assists) ||
      a.name.localeCompare(b.name)
    );

  let previousGoals = null;
  let previousAssists = null;
  let previousRank = 0;

  return sorted.map((player, index) => {
    const sameAsPrevious =
      Number(player.goals) === Number(previousGoals) &&
      Number(player.assists || 0) === Number(previousAssists || 0);

    const rank = sameAsPrevious ? previousRank : index + 1;
    previousGoals = Number(player.goals);
    previousAssists = Number(player.assists || 0);
    previousRank = rank;

    const tied = sorted.filter((item) =>
      Number(item.goals) === Number(player.goals) &&
      Number(item.assists || 0) === Number(player.assists || 0)
    ).length > 1;

    return {
      ...player,
      rank: tied ? `T-${rank}` : String(rank)
    };
  });
}

function displayTopScorerName(player) {
  return player.country ? `${player.name} (${player.country})` : player.name;
}

function topScorerValueLabel(player) {
  const goals = Number(player.goals || 0);
  const assists = Number(player.assists || 0);
  const goalText = `${goals} ${plural(goals, "goal")}`;
  return assists ? `${goalText} (${assists} ${plural(assists, "assist")})` : goalText;
}

function liveMinuteLabel(match) {
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

  const minute = text.match(/(\d{1,3})\s*(?:'|min|minute)?/i);
  if (minute) return `${minute[1]}'`;

  if (/live|in.?play|playing|1st|2nd/i.test(text)) return text;
  return "Live now";
}

function statusCell(match) {
  const minute = liveMinuteLabel(match);
  const detail = minute ? `<br><small class="live-time">${escapeHtml(minute)}</small>` : "";
  return `<span class="badge ${match.status}">${escapeHtml(statusLabel(match.status))}</span>${detail}`;
}


/* =========================================================
   v19 — tested dynamic top scorers parser
   - No stale old scorer fallback
   - Parses GOAL-style rows: "## 1 Deniz Undav | Germany | Three goals"
   - Parses table-style rows: "1 Deniz Undav Germany 3 (2 assists)"
   - Supports number words, assists, ties, and source row order
   ========================================================= */

const TOP_SCORER_SOURCES_V19 = [
  {
    name: "GOAL Golden Boot standings",
    urls: [
      "https://r.jina.ai/https://www.goal.com/en/lists/world-cup-2026-golden-boot-standings-fifa-award/blt29fdba0896b8fd09",
      "https://r.jina.ai/http://r.jina.ai/http://https://www.goal.com/en/lists/world-cup-2026-golden-boot-standings-fifa-award/blt29fdba0896b8fd09",
      "https://www.goal.com/en/lists/world-cup-2026-golden-boot-standings-fifa-award/blt29fdba0896b8fd09"
    ]
  },
  {
    name: "The Sun Golden Boot table",
    urls: [
      "https://r.jina.ai/https://www.thesun.co.uk/sport/39367358/world-cup-2026-golden-boot-who-is-leading/",
      "https://r.jina.ai/http://r.jina.ai/http://https://www.thesun.co.uk/sport/39367358/world-cup-2026-golden-boot-who-is-leading/",
      "https://www.thesun.co.uk/sport/39367358/world-cup-2026-golden-boot-who-is-leading/"
    ]
  },
  {
    name: "NBC Sports top goalscorers",
    urls: [
      "https://r.jina.ai/https://www.nbcsports.com/soccer/news/2026-world-cup-top-goalscorers-full-list-latest-on-race-for-the-golden-boot",
      "https://r.jina.ai/http://r.jina.ai/http://https://www.nbcsports.com/soccer/news/2026-world-cup-top-goalscorers-full-list-latest-on-race-for-the-golden-boot"
    ]
  },
  {
    name: "Jina web search fallback",
    urls: [
      "https://s.jina.ai/2026%20FIFA%20World%20Cup%20top%20scorers%20Golden%20Boot%20Deniz%20Undav%20Lionel%20Messi%20Jonathan%20David%20goals%20assists"
    ]
  }
];

const COUNT_WORDS_V19 = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

const PRETTY_PLAYER_NAMES_V19 = {
  "deniz undav": "Deniz Undav",
  "denis undav": "Deniz Undav",
  "lionel messi": "Lionel Messi",
  "jonathan david": "Jonathan David",
  "vinicius junior": "Vinícius Júnior",
  "vinicius jr": "Vinícius Júnior",
  "vinícius júnior": "Vinícius Júnior",
  "kylian mbappe": "Kylian Mbappé",
  "kylian mbappé": "Kylian Mbappé",
  "kai havertz": "Kai Havertz",
  "yasin ayari": "Yasin Ayari",
  "folarin balogun": "Folarin Balogun",
  "elijah just": "Elijah Just",
  "harry kane": "Harry Kane",
  "erling haaland": "Erling Haaland",
  "johan manzambi": "Johan Manzambi",
  "ayase ueda": "Ayase Ueda",
  "crysencio summerville": "Crysencio Summerville",
  "cody gakpo": "Cody Gakpo",
  "matheus cunha": "Matheus Cunha",
  "cyle larin": "Cyle Larin",
  "brian brobbey": "Brian Brobbey",
  "ismael saibari": "Ismael Saibari",
  "daichi kamada": "Daichi Kamada"
};

const COUNTRY_NAMES_V19 = [
  "Argentina", "Australia", "Austria", "Belgium", "Bosnia and Herzegovina", "Brazil", "Canada", "Colombia",
  "Croatia", "Curaçao", "Curacao", "Czechia", "Czech Republic", "Denmark", "DR Congo", "Ecuador", "England", "France",
  "Germany", "Ghana", "Haiti", "Iran", "Iraq", "Ivory Coast", "Japan", "Mexico", "Morocco", "Netherlands",
  "New Zealand", "Norway", "Paraguay", "Portugal", "Qatar", "Saudi Arabia", "Scotland", "Senegal",
  "South Africa", "South Korea", "Spain", "Sweden", "Switzerland", "Tunisia", "Turkey", "USA", "USMNT", "United States",
  "Uruguay", "Uzbekistan"
];

const COUNTRY_ALIASES_V19 = {
  "United States": "USA",
  "USMNT": "USA",
  "Curacao": "Curaçao"
};

function escapeRegexV19(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COUNTRY_RE_V19 = new RegExp(`\\b(${COUNTRY_NAMES_V19.map(escapeRegexV19).join("|")})\\b`, "i");

function cleanDynamicText(value) {
  return String(value || "")
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCountry(country) {
  const cleaned = cleanDynamicText(country);
  return COUNTRY_ALIASES_V19[cleaned] || cleaned;
}

function normalizePlainKeyV19(value) {
  return cleanDynamicText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\./g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function prettyPlayerNameV19(name) {
  const cleaned = cleanPlayerFromCell(name);
  return PRETTY_PLAYER_NAMES_V19[normalizePlainKeyV19(cleaned)] || cleaned;
}

function playerKeyDynamic(value, country = "") {
  return `${prettyPlayerNameV19(value)}|||${normalizeCountry(country)}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\./g, "")
    .replace(/[^a-zA-Z0-9|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function numberFromScorerTextV19(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const digit = text.match(/\d+/);
  if (digit) return Number(digit[0]);

  for (const [word, number] of Object.entries(COUNT_WORDS_V19)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) return number;
  }

  return null;
}

function cleanPlayerFromCell(value) {
  return cleanDynamicText(value)
    .replace(/^(?:\d+|T[-–]?\d+)\s+/i, "")
    .replace(/\s*\[[^\]]+\]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseGoalsAndAssists(value) {
  const text = cleanDynamicText(value);
  const m = text.match(/(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*goals?)?(?:\s*\((\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*assists?\))?/i);
  if (!m) return null;

  return {
    goals: numberFromScorerTextV19(m[1]),
    assists: numberFromScorerTextV19(m[2] || "0") || 0
  };
}

function parseGoalComHeadingRowsV19(lines) {
  const rows = [];
  const re = /^(?:#+\s*)?(\d+|T[-–]?\d+)\s+(.+?)\s*\|\s*([^|]+?)\s*\|\s*(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+goals?(?:\s*\((\d+|zero|one|two|three|four|five)\s*assists?\))?\s*$/i;

  lines.forEach((line, order) => {
    const m = line.match(re);
    if (!m) return;

    rows.push({
      sourceRank: numberFromScorerTextV19(m[1]),
      sourceOrder: order,
      name: prettyPlayerNameV19(m[2]),
      country: normalizeCountry(m[3]),
      goals: numberFromScorerTextV19(m[4]),
      assists: numberFromScorerTextV19(m[5] || "0") || 0
    });
  });

  return rows;
}

function parsePipeTables(lines) {
  const rows = [];

  lines.forEach((line, order) => {
    if (!line.includes("|")) return;
    if (/^#+\s*(?:\d+|T[-–]?\d+)\s+/.test(line)) return;
    if (/rank|name|country|goals/i.test(line) && !/\d/.test(line) && !/one|two|three|four/i.test(line)) return;

    const cells = line.split("|").map(cleanDynamicText).filter(Boolean);
    if (cells.length < 3) return;

    const goalsInfo = parseGoalsAndAssists(cells[cells.length - 1]);
    if (!goalsInfo) return;

    let country = "";
    let name = "";
    let sourceRank = null;

    for (let i = cells.length - 2; i >= 0; i--) {
      if (COUNTRY_RE_V19.test(cells[i])) {
        country = normalizeCountry((cells[i].match(COUNTRY_RE_V19) || [])[1] || cells[i]);
        name = cells[i - 1] || "";
        sourceRank = numberFromScorerTextV19(cells[i - 2] || "");
        break;
      }
    }

    if (!country && cells.length >= 4) {
      sourceRank = numberFromScorerTextV19(cells[0]);
      name = cells[cells.length - 3];
      country = normalizeCountry(cells[cells.length - 2]);
    }

    name = prettyPlayerNameV19(name);
    if (!name || !country) return;

    rows.push({
      sourceRank,
      sourceOrder: order,
      name,
      country,
      goals: goalsInfo.goals,
      assists: goalsInfo.assists
    });
  });

  return rows;
}

function parseRankRows(lines) {
  const rows = [];
  const countryPattern = COUNTRY_NAMES_V19.map(escapeRegexV19).join("|");
  const goalsPattern = "\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten";
  const re = new RegExp(`^(?:#+\\s*)?(\\d+|T[-–]?\\d+)\\s+(.+?)\\s+(${countryPattern})\\s+(${goalsPattern})(?:\\s*\\((${goalsPattern})\\s*assists?\\))?$`, "i");

  lines.forEach((line, order) => {
    if (line.includes("|")) return;
    const m = line.match(re);
    if (!m) return;

    rows.push({
      sourceRank: numberFromScorerTextV19(m[1]),
      sourceOrder: order,
      name: prettyPlayerNameV19(m[2]),
      country: normalizeCountry(m[3]),
      goals: numberFromScorerTextV19(m[4]),
      assists: numberFromScorerTextV19(m[5] || "0") || 0
    });
  });

  return rows;
}

function parseGoalBlocks(lines) {
  const rows = [];
  let currentGoals = null;

  lines.forEach((line, order) => {
    const goalHeader = line.match(/^(?:#{1,4}\s*)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+goals?$/i);
    if (goalHeader) {
      currentGoals = numberFromScorerTextV19(goalHeader[1]);
      return;
    }

    if (!currentGoals) return;

    const m = line.match(/^[-*]?\s*(.+?)\s*\(([^)]+)\)(?:\s*[-–—]\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*goals?)?$/i);
    if (!m || !COUNTRY_RE_V19.test(m[2])) return;

    rows.push({
      sourceRank: null,
      sourceOrder: order,
      name: prettyPlayerNameV19(m[1]),
      country: normalizeCountry((m[2].match(COUNTRY_RE_V19) || [])[1] || m[2]),
      goals: numberFromScorerTextV19(m[3] || String(currentGoals)),
      assists: 0
    });
  });

  return rows;
}

function parseSentenceRows(lines) {
  const rows = [];
  const countryPattern = COUNTRY_NAMES_V19.map(escapeRegexV19).join("|");

  lines.forEach((line, order) => {
    let m = line.match(new RegExp(`([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})\\s*\\((${countryPattern})\\).*?(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+goals?(?:.*?(\\d+|one|two|three|four|five)\\s+assists?)?`, "i"));
    if (m) {
      rows.push({
        sourceRank: null,
        sourceOrder: order,
        name: prettyPlayerNameV19(m[1]),
        country: normalizeCountry(m[2]),
        goals: numberFromScorerTextV19(m[3]),
        assists: numberFromScorerTextV19(m[4] || "0") || 0
      });
      return;
    }

    m = line.match(new RegExp(`([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’ -]{2,60})\\s+(${countryPattern})\\s+(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\\s*\\((\\d+|one|two|three|four|five)\\s*assists?\\))?`, "i"));
    if (!m) return;

    rows.push({
      sourceRank: null,
      sourceOrder: order,
      name: prettyPlayerNameV19(m[1]),
      country: normalizeCountry(m[2]),
      goals: numberFromScorerTextV19(m[3]),
      assists: numberFromScorerTextV19(m[4] || "0") || 0
    });
  });

  return rows;
}

function inferAssistsFromTextV19(rows, originalText) {
  const text = String(originalText || "");
  const blocks = text.split(/\n(?=#{1,6}\s*(?:\d+|T[-–]?\d+)\s+)/);

  for (const row of rows) {
    const lastName = String(row.name).split(/\s+/).pop();

    for (const block of blocks) {
      if (!/^#{1,6}\s*(?:\d+|T[-–]?\d+)\s+/m.test(block)) continue;
      if (!new RegExp(escapeRegexV19(row.name), "i").test(block) && !new RegExp(`\\b${escapeRegexV19(lastName)}\\b`, "i").test(block)) continue;

      const m = block.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+assists?\b/i);
      if (m) row.assists = Math.max(Number(row.assists || 0), numberFromScorerTextV19(m[1]) || 0);
    }
  }

  return rows;
}

function parseDynamicTopScorers(text) {
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => cleanDynamicText(line))
    .filter(Boolean);

  const rows = [
    ...parseGoalComHeadingRowsV19(lines),
    ...parsePipeTables(lines),
    ...parseRankRows(lines),
    ...parseGoalBlocks(lines),
    ...parseSentenceRows(lines)
  ];

  return inferAssistsFromTextV19(rows, text)
    .filter((row) => Number(row.goals) >= TOP_SCORER_MIN_GOALS);
}

function rankAndMergeTopScorers(rows) {
  const merged = new Map();

  for (const row of rows || []) {
    const name = prettyPlayerNameV19(row.name);
    const country = normalizeCountry(row.country);
    const goals = Number(row.goals);
    const assists = Number(row.assists || 0);

    if (!name || !country || !Number.isFinite(goals) || goals < TOP_SCORER_MIN_GOALS) continue;

    const key = playerKeyDynamic(name, country);
    const current = merged.get(key) || {
      name,
      country,
      goals: 0,
      assists: 0,
      sourceRank: Number(row.sourceRank) || 999,
      sourceOrder: Number(row.sourceOrder) || 9999
    };

    current.goals = Math.max(current.goals, goals);
    current.assists = Math.max(current.assists, assists);
    current.sourceRank = Math.min(Number(current.sourceRank) || 999, Number(row.sourceRank) || 999);
    current.sourceOrder = Math.min(Number(current.sourceOrder) || 9999, Number(row.sourceOrder) || 9999);

    merged.set(key, current);
  }

  const sorted = [...merged.values()].sort((a, b) =>
    Number(b.goals) - Number(a.goals) ||
    Number(b.assists) - Number(a.assists) ||
    Number(a.sourceRank) - Number(b.sourceRank) ||
    Number(a.sourceOrder) - Number(b.sourceOrder) ||
    a.name.localeCompare(b.name)
  );

  let previousKey = "";
  let previousRank = 0;

  return sorted.map((player, index) => {
    const key = `${player.goals}|||${player.assists}`;
    const rank = key === previousKey ? previousRank : index + 1;

    previousKey = key;
    previousRank = rank;

    const tied = sorted.filter((item) =>
      Number(item.goals) === Number(player.goals) &&
      Number(item.assists || 0) === Number(player.assists || 0)
    ).length > 1;

    return {
      ...player,
      rank: tied ? `T-${rank}` : String(rank)
    };
  });
}

async function fetchTextNoStore(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "Accept": "text/plain, text/markdown, text/html, */*" }
    });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadDynamicTopScorers() {
  state.dynamicTopScorersStatus = "loading";
  state.dynamicTopScorers = [];
  state.dynamicTopScorersError = "";
  renderTopScorers();

  const errors = [];

  for (const source of TOP_SCORER_SOURCES_V19) {
    for (const url of source.urls) {
      try {
        const text = await fetchTextNoStore(url);
        const parsed = parseDynamicTopScorers(text);
        const ranked = rankAndMergeTopScorers(parsed);

        if (ranked.length) {
          state.dynamicTopScorers = ranked;
          state.dynamicTopScorersStatus = "loaded";
          state.dynamicTopScorersSourceName = source.name;
          state.dynamicTopScorersUpdatedAt = new Date().toISOString();
          renderTopScorers();
          return ranked;
        }

        errors.push(`${source.name}: parsed 0 rows from ${url}`);
      } catch (error) {
        errors.push(`${source.name}: ${error.message || error}`);
        console.warn("Top scorer dynamic source failed:", source.name, url, error);
      }
    }
  }

  state.dynamicTopScorersStatus = "error";
  state.dynamicTopScorers = [];
  state.dynamicTopScorersError = errors.join(" | ");
  renderTopScorers();
  throw new Error(state.dynamicTopScorersError || "No dynamic top scorer source returned usable data.");
}

function renderTopScorers() {
  if (state.dynamicTopScorersStatus === "loading") {
    $("topScorers").innerHTML = statEmptyHtml("Loading dynamic top scorers…");
    return;
  }

  if (state.dynamicTopScorersStatus === "error") {
    $("topScorers").innerHTML = statEmptyHtml("Dynamic top scorer source is unavailable. Refresh again later.");
    return;
  }

  const rows = Array.isArray(state.dynamicTopScorers) ? state.dynamicTopScorers : [];
  const topGoals = rows.length ? Number(rows[0].goals || 0) : null;

  $("topScorers").innerHTML = rows.length
    ? rows.map((player) =>
        statItemHtml(
          player.rank || "",
          displayTopScorerName(player),
          topScorerValueLabel(player),
          "stat-green",
          Number(player.goals || 0) === topGoals
        )
      ).join("")
    : statEmptyHtml("Dynamic top scorer data is not available yet.");
}


console.info("AssistAI WorldCup app v20 loaded: dynamic MVP parser fixed and tested.");


console.info("AssistAI WorldCup app v21 loaded: MVP, latest finished sort, no auto-refresh text.");
