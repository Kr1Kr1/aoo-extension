// ============================================================
// Constants
// ============================================================
const API_BASE = "http://localhost:3001";
const AUTH_CREDENTIALS = { username: "karin", password: "karin" };
// Bug board (aoo-bug-board) : les sujets des forums listés ici sont aussi
// poussés vers son API d'ingestion. Le secret doit correspondre au
// RECONCILE_SECRET du .env du bug board.
const BUGBOARD_API = "http://localhost:4200";
const BUGBOARD_SECRET = "change-me";
const BUGBOARD_FORUMS = ["Le Nid aux Bugs"];
const AOM_HOST = "age-of-olympia.net";
// Moteur local (docker, cf. aoo-engine sur http://localhost:9000) : on
// l'arpente pour compléter la carte du tracker, et c'est tout ce qui en
// remonte. Seules ces personas y sont suivies ; leurs déplacements là-bas
// valent exploration, ceux des autres non. Les identifiants de l'instance
// locale ne sont pas forcément ceux du vrai jeu, donc la carte est taguée
// avec le targetId canonique, celui que le tracker accepte de ce moteur.
const LOCAL_ENGINE_PLAYERS = [
  { name: "Medarda", targetId: 232 },
  { name: "rouette", targetId: -260 },
  { name: "Omik", targetId: -282 },
  { name: "Neige", targetId: -9 },
];
const LOCAL_ENGINE_SOURCE = "local-engine";
const AOM_INDEX_URL = "https://age-of-olympia.net/index.php";
const AOM_RANKINGS_URL = "https://age-of-olympia.net/classements.php";

// ============================================================
// Logger
// ============================================================
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let currentLogLevel = "info";

const logger = {
  error: (...args) => console.error("[background]", ...args),
  warn: (...args) => {
    if (LOG_LEVELS[currentLogLevel] >= LOG_LEVELS.warn) console.warn("[background]", ...args);
  },
  info: (...args) => {
    if (LOG_LEVELS[currentLogLevel] >= LOG_LEVELS.info) console.log("[background]", ...args);
  },
  debug: (...args) => {
    if (LOG_LEVELS[currentLogLevel] >= LOG_LEVELS.debug) console.log("[background]", ...args);
  },
};

chrome.storage.sync.get(["logLevel"]).then((r) => {
  currentLogLevel = r.logLevel || "info";
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync" && changes.logLevel) {
    currentLogLevel = changes.logLevel.newValue;
  }
});

// ============================================================
// Persisted state (chrome.storage.session survives SW restarts
// within a browser session)
// ============================================================
let loginState = { loggedIn: false, playerName: null, playerId: null };
let authToken = null;

const hydrate = chrome.storage.session.get(["loginState", "authToken"]).then((r) => {
  if (r.loginState) loginState = r.loginState;
  if (r.authToken) authToken = r.authToken;
});

async function setLoginState(next) {
  loginState = next;
  await chrome.storage.session.set({ loginState: next });
}

async function setAuthToken(token) {
  authToken = token;
  if (token) await chrome.storage.session.set({ authToken: token });
  else await chrome.storage.session.remove("authToken");
}

// ============================================================
// Auth + apiFetch wrapper
// ============================================================
async function authenticate() {
  const res = await fetch(`${API_BASE}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(AUTH_CREDENTIALS),
  });
  if (!res.ok) throw new Error(`Authentication failed (${res.status})`);
  const data = await res.json();
  await setAuthToken(data.token);
  return data.token;
}

async function ensureAuthenticated() {
  await hydrate;
  if (authToken) return authToken;
  return authenticate();
}

async function apiFetch(path, { method = "GET", body, headers = {}, retried = false } = {}) {
  const token = await ensureAuthenticated();
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const finalHeaders = {
    Authorization: `Bearer ${token}`,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...headers,
  };

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (!retried) {
      logger.warn(`Network error on ${method} ${path}, retrying once:`, err.message);
      await new Promise((r) => setTimeout(r, 500));
      return apiFetch(path, { method, body, headers, retried: true });
    }
    throw err;
  }

  if (res.status === 401 && !retried) {
    logger.info("Got 401, re-authenticating");
    await setAuthToken(null);
    return apiFetch(path, { method, body, headers, retried: true });
  }

  return res;
}

// ============================================================
// Tab helpers
// ============================================================
async function getAomTabs() {
  // Use URL pattern at the query level so we don't accidentally match
  // chrome:// or internal tabs that happen to contain the host string.
  const aomTabs = await chrome.tabs.query({ url: `*://${AOM_HOST}/*` });
  if (aomTabs.length === 0) return [];
  // Prefer the active tab in the last-focused window, then any active AOM tab,
  // then the rest. This biases toward the tab the user is currently looking at.
  let lastFocusedId = null;
  try {
    const win = await chrome.windows.getLastFocused();
    lastFocusedId = win?.id ?? null;
  } catch {}
  return aomTabs.slice().sort((a, b) => {
    const score = (t) =>
      (t.windowId === lastFocusedId && t.active ? 0 : t.active ? 1 : 2);
    return score(a) - score(b);
  });
}

async function pingTab(tabId) {
  try {
    const res = await sendToContent(tabId, { type: "PING" });
    return res?.ok === true;
  } catch {
    return false;
  }
}

async function getAomTab() {
  const candidates = await getAomTabs();
  if (candidates.length === 0) throw new Error("No Age of Olympia tab open");
  for (const tab of candidates) {
    if (await pingTab(tab.id)) return tab;
  }
  // None responded — return the best candidate anyway so the caller's error
  // message reflects the real failure (the content script never loaded).
  return candidates[0];
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let updatedListener;
    let removedListener;
    let timer;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(updatedListener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      clearTimeout(timer);
    };
    updatedListener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        cleanup();
        resolve();
      }
    };
    removedListener = (id) => {
      if (id === tabId) {
        cleanup();
        reject(new Error("Tab was closed before load completed"));
      }
    };
    chrome.tabs.onUpdated.addListener(updatedListener);
    chrome.tabs.onRemoved.addListener(removedListener);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for tab to load"));
    }, timeoutMs);
  });
}

async function navigateAndWait(tabId, url) {
  const wait = waitForTabComplete(tabId);
  await chrome.tabs.update(tabId, { url });
  await wait;
}

function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ============================================================
// API helpers
// ============================================================
function isOkOrConflict(res) {
  return res.ok || res.status === 409;
}

async function postOne(path, body, label, { headers } = {}) {
  try {
    const res = await apiFetch(path, { method: "POST", body, headers });
    if (isOkOrConflict(res)) {
      if (res.status === 409) logger.debug(`${label}: 409 (already exists)`);
      else logger.info(`${label}: sent`);
      return true;
    }
    const text = await res.text();
    logger.error(`${label} POST failed (${res.status}): ${text}`);
    return false;
  } catch (err) {
    logger.error(`${label} POST error:`, err.message);
    return false;
  }
}

// Comme postOne, mais rend le corps de la réponse (ou null en cas d'échec,
// déjà journalisé) quand l'appelant a besoin de ce que le tracker répond.
async function postJson(path, body, label, { headers } = {}) {
  try {
    const res = await apiFetch(path, { method: "POST", body, headers });
    if (res.ok) {
      logger.info(`${label}: sent`);
      return res.json();
    }
    const text = await res.text();
    logger.error(`${label} POST failed (${res.status}): ${text}`);
    return null;
  } catch (err) {
    logger.error(`${label} POST error:`, err.message);
    return null;
  }
}

async function postBatch(items, getPath, label) {
  if (!Array.isArray(items)) {
    logger.error(`Invalid ${label} data:`, items);
    return false;
  }
  const results = await Promise.all(
    items.map((item) => postOne(getPath(item), item, label))
  );
  const success = results.filter(Boolean).length;
  logger.info(`${label}: ${success}/${items.length} sent`);
  return success === items.length;
}

// ============================================================
// Handlers — each returns a Promise<unknown> sent back to caller.
// Throwing or rejecting is fine; the dispatcher catches it.
// ============================================================
async function handleLoginStatus(message) {
  if (message.loggedIn === undefined) {
    logger.warn("LOGIN_STATUS message missing 'loggedIn' property");
    return;
  }
  if (message.loggedIn) {
    const prevPlayerId = loginState.playerId;
    await setLoginState({
      loggedIn: true,
      playerName: message.data?.playerName || "Unknown Player",
      playerId: message.data?.playerId ?? null,
    });
    logger.info(`Logged in as ${loginState.playerName}`);

    // Tell the tracker which character this user plays so /api/me can
    // surface "where am I" without manual /admin setup. Idempotent on
    // both ends; only fire when the playerId changed (or wasn't set).
    if (loginState.playerId != null && loginState.playerId !== prevPlayerId) {
      try {
        const res = await apiFetch("/api/me/link-character", {
          method: "POST",
          body: { targetId: loginState.playerId, name: loginState.playerName },
        });
        if (res.ok) {
          const data = await res.json();
          logger.info(
            `Linked tracker user to character ${loginState.playerId}` +
              (data.alreadyLinked ? " (already linked)" : "")
          );
        } else if (res.status !== 404) {
          // 404 = character not yet imported into the tracker; not an error.
          logger.warn(`Auto-link character failed: HTTP ${res.status}`);
        }
      } catch (err) {
        logger.warn(`Auto-link character error: ${err.message}`);
      }
    }
  } else {
    await setLoginState({ loggedIn: false, playerName: null, playerId: null });
    logger.info("User is not logged in");
  }
}

async function handleGetLoginStatus() {
  await hydrate;
  return loginState;
}

async function handleFetchMap({ tabId, ownerId, fromLocalEngine = false } = {}) {
  await hydrate;
  const owner = ownerId ?? loginState.playerId;
  if (!owner) {
    throw new Error("Not logged in: cannot fetch map");
  }
  const tab = tabId != null ? { id: tabId } : await getAomTab();
  const map = await sendToContent(tab.id, { type: "FETCH_MAP" });
  if (!map || map.error) {
    throw new Error(map?.error || "No map data");
  }

  // Make sure the player object includes the logged-in character even if
  // the SVG didn't tag them (defensive — fetchMapData usually catches it).
  // Du moteur local, aucune position ne part : le décor y est celui du jeu,
  // les personnages qui l'arpentent sont des données de dev.
  const players = fromLocalEngine
    ? []
    : Array.isArray(map.players)
      ? [...map.players]
      : [];

  // The position panel (map.php?local) is more reliable than the SVG for
  // the logged-in player's coords — the engine caches the SVG per player
  // (.svg files under datas/private/players/) and may serve stale data.
  // Override the self entry with the authoritative coords so the tracker
  // never lags behind the actual position.
  if (!fromLocalEngine && map.playerCoords && owner != null) {
    const { x, y } = map.playerCoords;
    const idx = players.findIndex((p) => p.targetId === owner);
    if (idx >= 0) {
      players[idx] = { ...players[idx], x, y };
    } else {
      players.push({ x, y, targetId: owner, href: null });
    }
  }

  const { assetUrls = [], ...payload } = map;
  logger.info("Map received:", {
    tiles: map.tiles?.length || 0,
    walls: map.walls?.length || 0,
    elements: map.elements?.length || 0,
    foregrounds: map.foregrounds?.length || 0,
    routes: map.routes?.length || 0,
    plants: map.plants?.length || 0,
    players: players.length,
    observed: map.observedCells?.length || 0,
    assets: assetUrls.length,
  });

  // Ingest map data. Tag it with the persona currently incarnated on the
  // page (medarda, a PNJ like rouette, …) so the tracker can segregate
  // vision: a PNJ's cartography must not pollute the main PJ's map.
  // ownerId is the AOM targetId — negative for PNJs by convention.
  // L'en-tête de source dit au tracker d'où vient le relevé : ce qui vient du
  // moteur local n'y est accepté que sur la carte, et pour cette persona-là.
  const sourceHeaders = fromLocalEngine
    ? { "X-AOO-Source": LOCAL_ENGINE_SOURCE }
    : undefined;
  // La réponse porte la clé de plan que le tracker a résolue : l'arpentage
  // automatique s'en sert pour demander où aller ensuite.
  const ingest = await postJson(
    "/api/maps",
    { ...payload, players, ownerId: owner },
    fromLocalEngine ? "Map (moteur local)" : "Map",
    { headers: sourceHeaders }
  );

  // Trigger asset mirror server-side. Best-effort: failure here is non-fatal.
  if (assetUrls.length > 0) {
    try {
      const res = await apiFetch("/api/assets", {
        method: "POST",
        body: { urls: assetUrls },
        headers: sourceHeaders,
      });
      if (res.ok) {
        const data = await res.json();
        const ok = data.results.filter((r) => r.path).length;
        logger.info(`Assets mirrored: ${ok}/${assetUrls.length}`);
      } else {
        logger.warn(`Asset mirror returned ${res.status}`);
      }
    } catch (err) {
      logger.warn(`Asset mirror failed: ${err.message}`);
    }
  }

  return {
    ok: !!ingest,
    plan: ingest?.plan ?? null,
    z: ingest?.z ?? map.z ?? 0,
    playerCoords: map.playerCoords ?? null,
  };
}

// Carte relevée sur le moteur local. Le personnage est lu sur la page qui
// appelle (loginState garde la persona du vrai jeu, pas celle d'ici) : tout
// autre qu'une joueuse autorisée repart sans rien envoyer.
function localSurveyor(playerName) {
  const seen = (playerName || "").trim().toLowerCase();
  return LOCAL_ENGINE_PLAYERS.find((p) => p.name.toLowerCase() === seen) || null;
}

async function handleLocalMapSync({ playerName, tabId }) {
  const surveyor = localSurveyor(playerName);
  if (!surveyor) {
    const names = LOCAL_ENGINE_PLAYERS.map((p) => p.name).join(", ");
    logger.info(
      `Moteur local : ${playerName || "personne"} n'est pas ${names}, rien n'est remonté`
    );
    return { ok: false, skipped: "not the surveying character" };
  }
  if (tabId == null) {
    throw new Error("Moteur local : onglet appelant inconnu");
  }
  return handleFetchMap({
    tabId,
    ownerId: surveyor.targetId,
    fromLocalEngine: true,
  });
}

// Arpentage automatique du moteur local : le tracker, qui tient la carte, dit
// où aller ; ici on ne fait que porter la question avec la bonne persona.
async function handleExploreNext({ playerName, plan, z, x, y, radius, blocked, goal }) {
  const surveyor = localSurveyor(playerName);
  if (!surveyor) throw new Error(`Moteur local : ${playerName || "personne"} n'arpente pas`);
  const res = await apiFetch("/api/explore/next", {
    method: "POST",
    body: { ownerId: surveyor.targetId, plan, z, x, y, radius, blocked, goal },
    headers: { "X-AOO-Source": LOCAL_ENGINE_SOURCE },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Explore next: HTTP ${res.status}`);
  return data;
}

// Les passages (téléporteurs) d'un niveau de plan, lus par le tracker dans la
// base du moteur local : invisibles sur la carte, ils ne s'évitent ni ne se
// visent sans ça.
async function handleExplorePortals({ playerName, plan, z }) {
  const surveyor = localSurveyor(playerName);
  if (!surveyor) throw new Error(`Moteur local : ${playerName || "personne"} n'arpente pas`);
  const res = await apiFetch("/api/explore/portals", {
    method: "POST",
    body: { ownerId: surveyor.targetId, plan, z },
    headers: { "X-AOO-Source": LOCAL_ENGINE_SOURCE },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Explore portals: HTTP ${res.status}`);
  return data;
}

// Les lieux à poser sur la carte du monde, tels que le tracker les connaît.
async function handleWorldMarkers() {
  const res = await apiFetch("/api/plans/world-markers");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `World markers: HTTP ${res.status}`);
  return data;
}

// Rendre ses mouvements à l'arpenteuse : le tracker ramène son prochain tour
// à maintenant dans la base du moteur local, le chargement suivant
// d'index.php fait le reste.
async function handleExploreNewTurn({ playerName }) {
  const surveyor = localSurveyor(playerName);
  if (!surveyor) throw new Error(`Moteur local : ${playerName || "personne"} n'arpente pas`);
  const res = await apiFetch("/api/explore/new-turn", {
    method: "POST",
    body: { ownerId: surveyor.targetId, playerName: surveyor.name },
    headers: { "X-AOO-Source": LOCAL_ENGINE_SOURCE },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Explore new turn: HTTP ${res.status}`);
  return data;
}

async function handleFetchAttributes({ tabId, navigate = true } = {}) {
  await hydrate;
  if (!loginState.playerId) {
    throw new Error("Not logged in: cannot fetch attributes");
  }
  // When the caller already sits on index.php (auto-sync), reuse that tab and
  // skip navigation so we never yank the user away from the page they're on.
  const tab = tabId != null ? { id: tabId } : await getAomTab();
  if (navigate) await navigateAndWait(tab.id, AOM_INDEX_URL);
  const response = await sendToContent(tab.id, { type: "FETCH_ATTRIBUTES" });
  if (!response?.attributes) {
    throw new Error(response?.error || "No attributes received");
  }
  const a = response.attributes;
  const transformed = {
    a: a.A,
    mvt: a.Mvt,
    p: a.P,
    pv: a.PV,
    cc: a.CC,
    ct: a.CT,
    f: a.F,
    e: a.E,
    agi: a.Agi,
    pm: a.PM,
    fm: a.FM,
    m: a.M,
    r: a.R,
    rm: a.RM,
    xp: a.Xp?.current ?? 0,
  };
  await postOne(
    `/api/characters/${loginState.playerId}/attributes`,
    transformed,
    "Attributes"
  );
  return { ok: true, attributes: transformed };
}

async function handleFetchLogs() {
  await hydrate;
  if (!loginState.playerId) {
    throw new Error("Not logged in: cannot fetch logs");
  }
  const tab = await getAomTab();
  const response = await sendToContent(tab.id, { type: "FETCH_LOGS" });
  if (!response?.logs) {
    throw new Error(response?.error || "No logs received");
  }
  const items = response.logs
    .filter((log) => log && log.event && log.date)
    .map((log) => ({
      event: log.event,
      details: log.details || "",
      fromCol: log.from || "",
      withWhom: log.withWhom || "None",
      date: log.date,
      territory: log.territory || "",
      source: log.source || "extension",
      playerId: loginState.playerId,
    }));
  await postBatch(items, () => "/api/events", "Event");
  return { ok: true, count: items.length };
}

async function handleFetchRankings({ tabId, navigate = true } = {}) {
  await hydrate;
  // Auto-sync passes the sender tab already sitting on classements.php so we
  // scrape the rankings in place instead of navigating.
  const tab = tabId != null ? { id: tabId } : await getAomTab();
  if (navigate) await navigateAndWait(tab.id, AOM_RANKINGS_URL);
  const response = await sendToContent(tab.id, { type: "FETCH_RANKINGS" });
  if (!response?.rankings) {
    throw new Error(response?.error || "No rankings received");
  }
  // Only send `xp` to the attributes endpoint — the rest of the ranking
  // object (targetId) lives in the URL.
  const items = response.rankings.map((r) => ({ targetId: r.targetId, xp: r.xp }));
  const results = await Promise.all(
    items.map((item) =>
      postOne(`/api/characters/${item.targetId}/attributes`, { xp: item.xp }, `Ranking:${item.targetId}`)
    )
  );
  const success = results.filter(Boolean).length;
  logger.info(`Rankings: ${success}/${items.length} sent`);
  return { ok: true, count: items.length, rankings: response.rankings };
}

async function handleFetchAllCharacters() {
  await hydrate;
  const tab = await getAomTab();
  const response = await sendToContent(tab.id, { type: "FETCH_ALL_CHARACTERS" });
  if (!response?.characters) {
    throw new Error(response?.error || "No characters received");
  }
  logger.info(`Received ${response.characters.length} characters`);
  for (const character of response.characters) {
    await processCharacter(character);
  }
  return { ok: true, count: response.characters.length };
}

async function processCharacter(character) {
  const { mdj, story, equipment, ...characterData } = character;
  const { targetId } = characterData;

  // Upsert character (PATCH if exists, POST if not)
  const existsRes = await apiFetch(`/api/characters/${targetId}`);
  const exists = existsRes.ok;
  const upsertPath = exists ? `/api/characters/${targetId}` : "/api/characters";
  const upsertMethod = exists ? "PATCH" : "POST";
  const upsertRes = await apiFetch(upsertPath, { method: upsertMethod, body: characterData });
  if (upsertRes.ok) {
    logger.info(`Character ${targetId} ${exists ? "updated" : "created"}`);
  } else {
    logger.error(`Character ${targetId} upsert failed:`, await upsertRes.text());
  }

  // MDJ (use 409 to detect duplicates instead of body string match)
  if (mdj != null) {
    const mdjRes = await apiFetch(`/api/characters/${targetId}/mdj`, {
      method: "POST",
      body: { mdj },
    });
    if (mdjRes.ok) logger.info(`MDJ sent for ${targetId}`);
    else if (mdjRes.status === 409) logger.debug(`MDJ duplicate for ${targetId}`);
    else logger.error(`MDJ failed for ${targetId}:`, await mdjRes.text());
  }

  // Story / history
  if (story != null) {
    const historyRes = await apiFetch(`/api/characters/${targetId}/history`, {
      method: "POST",
      body: { story },
    });
    if (historyRes.ok) logger.info(`History sent for ${targetId}`);
    else if (historyRes.status === 409) logger.debug(`History duplicate for ${targetId}`);
    else logger.error(`History failed for ${targetId}:`, await historyRes.text());
  }

  // Equipment
  if (Array.isArray(equipment) && equipment.length > 0) {
    const processedEquipment = equipment.map((item) => ({
      ...item,
      price: item.price ? parseInt(item.price, 10) : null,
    }));
    const equipmentRes = await apiFetch(`/api/characters/${targetId}/equipment`, {
      method: "POST",
      body: { equipment: processedEquipment },
    });
    if (equipmentRes.ok) {
      const data = await equipmentRes.json();
      if (data.results?.length) logger.info(`Equipment: ${data.results.length} items added for ${targetId}`);
      data.errors?.forEach((e) => logger.error(`Equipment error for ${targetId}:`, e));
    } else {
      logger.error(`Equipment failed for ${targetId}:`, await equipmentRes.text());
    }
  }
}

// Asks the tracker how many messages it already stores per topic. The content
// script compares that to the "Réponses" column of each listing and only
// re-fetches the topics that grew, resuming at their last page instead of
// walking every page of every topic on each sync cycle.
// Best effort: on failure we fall back to a full scan.
async function fetchKnownTopicCounts() {
  try {
    const res = await apiFetch("/api/topics/counts");
    if (!res.ok) {
      logger.warn(`Topic counts: HTTP ${res.status}, falling back to a full scan`);
      return {};
    }
    const { counts } = await res.json();
    logger.debug(`Topic counts: ${Object.keys(counts || {}).length} known topics`);
    return counts || {};
  } catch (err) {
    logger.warn(`Topic counts unavailable (${err.message}), falling back to a full scan`);
    return {};
  }
}

// full: ignore what the tracker already has and re-scrape every page. Needed
// after a database reset, and to catch the bug board up when it lags behind.
async function handleFetchForum(messageType, { full = false } = {}) {
  const tab = await getAomTab();
  const knownCounts = full ? {} : await fetchKnownTopicCounts();
  const forums = await sendToContent(tab.id, { type: messageType, knownCounts });
  if (!Array.isArray(forums) || forums.length === 0) {
    throw new Error(forums?.error || "No forum data received");
  }
  for (const { forum, topics } of forums) {
    if (!forum) {
      logger.warn("Skipping invalid forum entry");
      continue;
    }
    const payload = {
      forum: { name: forum.name, link: forum.link, type: forum.type, faction: forum.faction },
      topics: (topics || []).map((topic) => ({
        name: topic.topicName,
        link: topic.topicLink,
        author: { name: topic.topicAuthor },
        messages: (topic.messages || []).map((m) => ({
          author: { name: m.author?.name, targetId: m.author?.targetId },
          content: m.content,
          date: m.date,
        })),
      })),
    };
    // Bug board d'abord : son push ne doit dépendre en rien du tracker
    if (BUGBOARD_FORUMS.includes(forum.name)) {
      await postToBugBoard(payload);
    }
    await postOne("/api/forums", payload, `Forum:${forum.name}`);
  }
  return { ok: true, count: forums.length };
}

// Push vers le bug board, en plus du tracker. Best effort : une erreur
// (bug board éteint, secret faux) ne doit pas casser la synchro tracker.
async function postToBugBoard(payload) {
  try {
    const res = await fetch(`${BUGBOARD_API}/api/ingest/forum`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-reconcile-secret": BUGBOARD_SECRET,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.error(`Bug board: HTTP ${res.status}`, await res.text());
      return;
    }
    const data = await res.json();
    logger.info(
      `Bug board: ${data.created} créé(s), ${data.updated} mis à jour, ${data.unchanged} inchangé(s)`
    );
    if (data.errors?.length) data.errors.forEach((e) => logger.warn("Bug board:", e));
  } catch (err) {
    logger.warn(`Bug board injoignable: ${err.message}`);
  }
}

// Re-scrapes every page of every topic, ignoring what the tracker already has.
// Slow (a couple of thousand requests): meant for the first sync after a
// database migration, not for the auto-sync cycles.
async function handleFetchForumsFull() {
  const steps = [
    ["Forum RP", () => handleFetchForum("FETCH_FORUM_RP", { full: true })],
    ["Forum Private", () => handleFetchForum("FETCH_FORUM_PRIVATE", { full: true })],
    ["Forum HRP", () => handleFetchForum("FETCH_FORUM_HRP", { full: true })],
    ["Missives", () => handleFetchForum("FETCH_MISSIVES", { full: true })],
  ];
  return runSteps(steps, "Fetch Forums Full");
}

async function runSteps(steps, label) {
  const results = [];
  for (const [name, fn] of steps) {
    try {
      await fn();
      results.push({ name, ok: true });
      logger.info(`${label}: ${name} OK`);
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      logger.error(`${label}: ${name} FAILED: ${err.message}`);
    }
  }
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  return { ok: ok === results.length, count: ok, total: results.length, failed };
}

async function handleFetchAll() {
  // Order chosen so dependencies are satisfied:
  //   - characters before forums (forum messages reference character.targetId)
  //   - rankings after characters (rankings update xp on existing rows)
  //   - navigation-heavy steps (attributes, rankings) at the start so the
  //     content-script navigations don't interrupt later XHR scraping.
  const steps = [
    ["Attributes", handleFetchAttributes],
    ["All Characters", handleFetchAllCharacters],
    ["Rankings", handleFetchRankings],
    ["Logs", handleFetchLogs],
    ["MDJ Logs", handleFetchLogsMdj],
    ["Map", handleFetchMap],
    ["Map MDJ", handleFetchMapMdj],
    ["Forum RP", () => handleFetchForum("FETCH_FORUM_RP")],
    ["Forum Private", () => handleFetchForum("FETCH_FORUM_PRIVATE")],
    ["Forum HRP", () => handleFetchForum("FETCH_FORUM_HRP")],
    ["Missives", () => handleFetchForum("FETCH_MISSIVES")],
  ];
  return runSteps(steps, "Fetch All");
}

// ============================================================
// Auto-sync — push everything to the tracker on its own, with no
// button clicks. Triggered by the content script on every AOM page load.
//
// Design goals:
//   - Never navigate the user's tab. Page-bound scrapes (attributes,
//     rankings) only run when the page they need is *already* open; the
//     game reloads index.php on every move, so attributes sync constantly.
//   - Throttle per step (timestamps persisted in chrome.storage.local, so
//     they survive a browser restart) so a burst of page loads doesn't
//     hammer the tracker. Heavy sweeps (characters, forums) run far less
//     often than the cheap per-move map; the character sweep probes every
//     matricule, so it only runs once a day.
// ============================================================
const MIN = 60 * 1000;
const AUTO_SYNC_STEPS = [
  { name: "map", interval: 0, fn: () => handleFetchMap() },
  {
    name: "attributes",
    interval: 1 * MIN,
    page: (u) => u.includes("index.php"),
    fn: ({ tabId }) => handleFetchAttributes({ tabId, navigate: false }),
  },
  {
    name: "rankings",
    interval: 5 * MIN,
    page: (u) => u.includes("classements.php"),
    fn: ({ tabId }) => handleFetchRankings({ tabId, navigate: false }),
  },
  { name: "logs", interval: 5 * MIN, fn: () => handleFetchLogs() },
  { name: "mdjLogs", interval: 10 * MIN, fn: () => handleFetchLogsMdj() },
  { name: "mapMdj", interval: 10 * MIN, fn: () => handleFetchMapMdj() },
  { name: "missives", interval: 10 * MIN, fn: () => handleFetchForum("FETCH_MISSIVES") },
  { name: "forumRP", interval: 15 * MIN, fn: () => handleFetchForum("FETCH_FORUM_RP") },
  { name: "forumPrivate", interval: 15 * MIN, fn: () => handleFetchForum("FETCH_FORUM_PRIVATE") },
  { name: "forumHRP", interval: 15 * MIN, fn: () => handleFetchForum("FETCH_FORUM_HRP") },
  { name: "characters", interval: 24 * 60 * MIN, fn: () => handleFetchAllCharacters() },
];

async function handleAutoSync({ url, tabId } = {}) {
  await hydrate;
  if (!loginState.loggedIn) return { ok: false, skipped: "not logged in" };

  const now = Date.now();
  const stored = await chrome.storage.local.get("autoSyncStamps");
  const stamps = stored.autoSyncStamps || {};
  const ran = [];
  const failed = [];

  for (const step of AUTO_SYNC_STEPS) {
    // Skip page-bound steps unless the triggering page is the right one.
    if (step.page && !(url && step.page(url))) continue;
    // Skip steps that ran too recently.
    if (now - (stamps[step.name] || 0) < step.interval) continue;
    try {
      await step.fn({ tabId });
      stamps[step.name] = Date.now();
      ran.push(step.name);
      logger.info(`Auto-sync: ${step.name} OK`);
    } catch (err) {
      failed.push(step.name);
      logger.warn(`Auto-sync: ${step.name} failed: ${err.message}`);
    }
  }

  await chrome.storage.local.set({ autoSyncStamps: stamps });
  return { ok: true, ran, failed };
}

async function handleFetchMapMdj() {
  await hydrate;
  if (!loginState.playerId) {
    throw new Error("Not logged in: cannot fetch map MDJ");
  }
  const tab = await getAomTab();
  const response = await sendToContent(tab.id, {
    type: "FETCH_MAP_MDJ",
    selfTargetId: loginState.playerId,
  });
  const entries = response?.entries || [];
  let sent = 0;
  for (const { targetId, mdj } of entries) {
    const res = await apiFetch(`/api/characters/${targetId}/mdj`, {
      method: "POST",
      body: { mdj },
    });
    if (res.ok) sent++;
    else if (res.status === 409) logger.debug(`MDJ duplicate for ${targetId} (perception)`);
    else logger.error(`MDJ perception failed for ${targetId}:`, await res.text());
  }
  logger.info(`Map MDJ: ${sent}/${entries.length} new entries`);
  return { ok: true, count: sent, total: entries.length };
}

async function handleFetchLogsMdj() {
  await hydrate;
  const tab = await getAomTab();
  const response = await sendToContent(tab.id, { type: "FETCH_LOGS_MDJ" });
  const entries = response?.entries || [];
  let sent = 0;
  for (const { targetId, mdj, date } of entries) {
    const res = await apiFetch(`/api/characters/${targetId}/mdj`, {
      method: "POST",
      body: { mdj, createdAt: parseLogDate(date) },
    });
    if (res.ok) sent++;
    else if (res.status === 409) logger.debug(`MDJ log duplicate for ${targetId}`);
    else logger.error(`MDJ log failed for ${targetId}:`, await res.text());
  }
  logger.info(`MDJ logs: ${sent}/${entries.length} new entries`);
  return { ok: true, count: sent, total: entries.length };
}

// Mirror of lib/dateUtils.js parseDate, kept self-contained so the service
// worker doesn't have to bundle the tracker's lib code.
function parseLogDate(dateString) {
  if (!dateString) return new Date().toISOString();
  const now = new Date();
  if (dateString.includes("Aujourd'hui")) {
    const time = dateString.split("à")[1]?.trim();
    if (!time) return now.toISOString();
    const [h, m] = time.split(":").map(Number);
    now.setHours(h, m, 0, 0);
    return now.toISOString();
  }
  if (dateString.includes("Hier")) {
    const time = dateString.split("à")[1]?.trim();
    if (!time) return now.toISOString();
    const [h, m] = time.split(":").map(Number);
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    y.setHours(h, m, 0, 0);
    return y.toISOString();
  }
  const match = dateString.match(/(\d{2})\/(\d{2})\/(\d{4})\s+à\s+(\d{2}):(\d{2})/);
  if (match) {
    const [, day, month, year, h, m] = match;
    return new Date(year, month - 1, day, h, m).toISOString();
  }
  return now.toISOString();
}

async function handleFetchReputation() {
  await hydrate;
  if (!loginState.playerId) {
    throw new Error("Not logged in: cannot fetch reputation");
  }
  const tab = await getAomTab();
  return sendToContent(tab.id, { type: "FETCH_REPUTATION", targetId: loginState.playerId });
}

// ============================================================
// VPN check
// ============================================================
// Mullvad's own endpoint tells whether this request left through one of its
// servers. Any failure counts as "no VPN": the login gate fails closed.
const VPN_CHECK_URL = "https://am.i.mullvad.net/json";
const VPN_CHECK_TIMEOUT_MS = 5000;

async function handleCheckVpn() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VPN_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(VPN_CHECK_URL, { cache: "no-store", signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `Mullvad injoignable (HTTP ${res.status})` };
    const data = await res.json();
    if (data.mullvad_exit_ip !== true) return { ok: false, reason: "la connexion ne passe pas par Mullvad" };
    return { ok: true, country: data.country ?? null, server: data.mullvad_exit_ip_hostname ?? null };
  } catch (err) {
    const reason = err.name === "AbortError" ? "Mullvad ne répond pas" : `vérification impossible (${err.message})`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// Chrome does not inject the new content script into tabs opened before an
// install or update: those tabs would keep a login page without the VPN gate.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: `*://${AOM_HOST}/*` });
  for (const tab of tabs) chrome.tabs.reload(tab.id);
});

// ============================================================
// Dispatcher
// ============================================================
const handlers = {
  CHECK_VPN: () => handleCheckVpn(),
  LOGIN_STATUS: (msg) => handleLoginStatus(msg),
  GET_LOGIN_STATUS: () => handleGetLoginStatus(),
  FETCH_MAP: () => handleFetchMap(),
  LOCAL_MAP_SYNC: (msg, sender) =>
    handleLocalMapSync({ playerName: msg.playerName, tabId: sender?.tab?.id }),
  EXPLORE_NEXT: (msg) => handleExploreNext(msg),
  EXPLORE_PORTALS: (msg) => handleExplorePortals(msg),
  WORLD_MARKERS: () => handleWorldMarkers(),
  EXPLORE_NEW_TURN: (msg) => handleExploreNewTurn(msg),
  FETCH_ATTRIBUTES: () => handleFetchAttributes(),
  FETCH_LOGS: () => handleFetchLogs(),
  FETCH_RANKINGS: () => handleFetchRankings(),
  FETCH_ALL_CHARACTERS: () => handleFetchAllCharacters(),
  FETCH_FORUM_PRIVATE: () => handleFetchForum("FETCH_FORUM_PRIVATE"),
  FETCH_FORUM_RP: () => handleFetchForum("FETCH_FORUM_RP"),
  FETCH_FORUM_HRP: () => handleFetchForum("FETCH_FORUM_HRP"),
  FETCH_MISSIVES: () => handleFetchForum("FETCH_MISSIVES"),
  FETCH_FORUMS_FULL: () => handleFetchForumsFull(),
  FETCH_REPUTATION: () => handleFetchReputation(),
  FETCH_MAP_MDJ: () => handleFetchMapMdj(),
  FETCH_LOGS_MDJ: () => handleFetchLogsMdj(),
  FETCH_ALL: () => handleFetchAll(),
  AUTO_SYNC: (msg, sender) => handleAutoSync({ url: msg.url, tabId: sender?.tab?.id }),
  UPDATE_MISSIVE_STATUS: (msg) => updateMissiveStatus(msg),
  GET_MISSIVES: () => getMissives(),
};

async function getMissives() {
  await hydrate;
  const res = await apiFetch("/api/missives");
  if (!res.ok) throw new Error(`Failed to fetch missives: HTTP ${res.status}`);
  return res.json();
}

async function updateMissiveStatus({ topicId, closed }) {
  await hydrate;
  const res = await apiFetch(`/api/topics/${topicId}`, {
    method: "PATCH",
    body: { closed },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update topic: ${res.status} ${text}`);
  }
  return res.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  logger.debug("Received message:", message?.type);

  const handler = handlers[message?.type];
  if (!handler) {
    logger.warn(`Unknown message type: ${message?.type}`);
    return false;
  }

  Promise.resolve(handler(message, _sender))
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => {
      logger.error(`Handler ${message.type} failed:`, err.message);
      sendResponse({ error: err.message });
    });

  // Keep the message channel open for async response
  return true;
});
