// ============================================================
// Constants
// ============================================================
// Les pages se lisent là où le script tourne : le vrai jeu, ou le moteur local
// (docker, cf. aoo-engine) quand on l'arpente pour compléter la carte. Du
// moteur local ne remonte que la cartographie : ni stats, ni forums, ni
// missives, ses données de dev n'ont rien à faire dans le tracker.
const BASE_URL = `${window.location.origin}/`;
const CHARACTER_URL = `${BASE_URL}infos.php?targetId=`;
const LOCAL_ENGINE_HOST = "localhost:9000";
const IS_LOCAL_ENGINE = window.location.host === LOCAL_ENGINE_HOST;

// Map of private forum names → faction (used to tag scraped data)
const FACTION_PRIVATE_FORUMS = {
  "La Forge Sacrée": ["La Caverne Bruyante"],
};

// AOM renders the race as a plain-text label on line 2 of #infos-player
// (e.g. "Homme-Sauvage - Légendaire Rang 7"). We map these French labels
// to canonical tokens that match the in-game card CSS classes
// (.geant/.nain/.elfe/.hs/.olympien/.redoraan/.lutin/.dieu).
const RACE_LABELS = {
  geant: ["géant", "géants", "geant", "geants"],
  nain: ["nain", "naine", "nains", "naines"],
  elfe: ["elfe", "elfes"],
  hs: ["homme-sauvage", "hommes-sauvages", "homme sauvage", "hommes sauvages"],
  olympien: ["olympien", "olympienne", "olympiens", "olympiennes"],
  redoraan: ["redoraan", "redoraans"],
  lutin: ["lutin", "lutine", "lutins", "lutines"],
  dieu: ["dieu", "dieux", "déesse", "déesses", "deesse", "deesses"],
  // private races used for NPCs (engine: aoo-engine/datas/private/races/*.json)
  animal: ["animal", "animaux"],
  centaure: ["centaure", "centaures"],
  humain: ["humain", "humaine", "humains", "humaines"],
  protocole: ["protocole", "protocoles"],
  saurien: ["saurien", "sauriens"],
  triton: ["triton", "tritons"],
  troglodyte: ["troglodyte", "troglodytes"],
  trotile: ["trotile", "trotiles"],
};

function detectRaceFromDoc(doc) {
  const player = doc.querySelector("#infos-player");
  if (!player) return null;
  const text = (player.innerText || "").toLowerCase();
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  // The race always sits before " - " on a header line (e.g. "Elfe - Connu
  // Rang 7"). Restrict the scan to lines matching that pattern so words
  // like "géant" appearing in the MDJ ("Rentre chez toi géant.") don't
  // falsely tag the character.
  for (const line of lines) {
    if (!line.includes(" - ")) continue;
    const beforeDash = line.split(" - ")[0].trim();
    // Exact match first — covers clean "elfe" / "homme-sauvage" headers.
    for (const [token, labels] of Object.entries(RACE_LABELS)) {
      if (labels.includes(beforeDash)) return token;
    }
    // Substring match — covers descriptors like "aventurière elfe".
    for (const [token, labels] of Object.entries(RACE_LABELS)) {
      for (const label of labels) {
        if (beforeDash.includes(label)) return token;
      }
    }
  }
  return null;
}

// ============================================================
// Logger (mirror of background.js logger so the popup's
// log-level setting works on both sides)
// ============================================================
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let currentLogLevel = "info";

const logger = {
  error: (...args) => console.error("[content]", ...args),
  warn: (...args) => {
    if (LOG_LEVELS[currentLogLevel] >= LOG_LEVELS.warn) console.warn("[content]", ...args);
  },
  info: (...args) => {
    if (LOG_LEVELS[currentLogLevel] >= LOG_LEVELS.info) console.log("[content]", ...args);
  },
  debug: (...args) => {
    if (LOG_LEVELS[currentLogLevel] >= LOG_LEVELS.debug) console.log("[content]", ...args);
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
// HTML helpers
// ============================================================
const parser = new DOMParser();

async function fetchHtml(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
  return parser.parseFromString(await res.text(), "text/html");
}

function stripHtml(html) {
  if (!html) return null;
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[^>]+(>|$)/g, "").trim();
}

// ============================================================
// Login detection
// ============================================================
// Le lien vers la fiche du personnage incarné : dans le bandeau du haut de la
// nouvelle interface (saison 3, #hud-topbar), dans le panneau #infos avant.
function playerLinkElement() {
  return document.querySelector("#hud-topbar #hud-chip-name") || document.querySelector("#infos .player-info a");
}

/** Le personnage incarné sur la page, ou null si personne n'est connecté. */
function readPlayer() {
  const isLoggedIn = !!document.querySelector("#menu") && !!playerLinkElement();
  if (!isLoggedIn) return null;

  const playerInfoElement = playerLinkElement();
  const playerName = playerInfoElement?.innerText || "Unknown Player";
  const href = playerInfoElement?.getAttribute("href") || "";
  const playerIdMatch = href.match(/targetId=(-?\d+)/);
  const playerId = playerIdMatch ? parseInt(playerIdMatch[1], 10) : null;
  return { playerName, playerId };
}

function checkLogin() {
  const player = readPlayer();
  logger.debug(`isLoggedIn=${!!player}`);

  if (!player) {
    chrome.runtime.sendMessage({ type: "LOGIN_STATUS", loggedIn: false });
    return;
  }

  logger.info(`Logged in as ${player.playerName} (${player.playerId})`);
  chrome.runtime.sendMessage({
    type: "LOGIN_STATUS",
    loggedIn: true,
    data: player,
  });
}

// ============================================================
// Logs / events
// ============================================================
async function fetchTerritoryName() {
  try {
    const doc = await fetchHtml(`${BASE_URL}map.php?local`);
    const h1 = doc.querySelector("h1 font") || doc.querySelector("h1");
    return h1?.innerText.trim() || "Unknown Territory";
  } catch (err) {
    logger.error("Error fetching territory name:", err);
    return "Unknown Territory";
  }
}

const WORLD_DISPLAY_NAME = "Olympia";

// Authoritative read of the player's current location from
// scripts/map/local_map.php's "Votre Position" panel. The SVG bg image on
// index.php is unreliable for plan detection because several plans share a
// background image (e.g. taverne_d_olympia_s2 reuses campement_redoraan.png),
// causing the extension to mis-tag scraped data with the bg image's plan key.
async function fetchPlayerLocation() {
  try {
    const doc = await fetchHtml(`${BASE_URL}map.php?local`);
    const p = doc.querySelector(".player-info p");
    if (!p) return null;
    // Layout: "<displayName> / Niveau: <zName> (Z<z>) <br> Coords (X: <x>, Y: <y>, Z: <z>)"
    const text = p.innerHTML.replace(/<br\s*\/?>/gi, "\n");
    const headerMatch = text.match(/^([\s\S]*?)\s*\/\s*Niveau:\s*([\s\S]*?)\s*\(Z(-?\d+)\)/);
    const coordsMatch = text.match(/Coords\s*\(X:\s*(-?\d+),\s*Y:\s*(-?\d+),\s*Z:\s*(-?\d+)\)/);
    if (!headerMatch || !coordsMatch) {
      logger.warn("Could not parse position panel");
      return null;
    }
    // La clé du plan, qui le distingue d'un homonyme (deux tavernes, une
    // archive), est dans le nom des calques de la carte locale :
    // img/maps/local/local_<plan>_<z>_tiles_<horodatage>.png. Sur le monde,
    // cas à part, la page ne montre que les calques img/maps/world/world_* :
    // le plan est alors le monde lui-même. Quand la page ne montre aucun
    // calque (monde de saison sans image générée), le nom « Olympia » suffit.
    const html = doc.documentElement.outerHTML;
    const layerMatch = html.match(/img\/maps\/local\/local_([a-z0-9_]+?)_(-?\d+)_tiles_/i);
    const planDisplayName = stripHtml(headerMatch[1]);
    const isWorld =
      /img\/maps\/world\/world_tiles_/i.test(html) || planDisplayName === WORLD_DISPLAY_NAME;
    const planKey = layerMatch ? layerMatch[1].toLowerCase() : isWorld ? "olympia" : null;
    return {
      planKey,
      planDisplayName,
      zName: stripHtml(headerMatch[2]),
      x: parseInt(coordsMatch[1], 10),
      y: parseInt(coordsMatch[2], 10),
      z: parseInt(coordsMatch[3], 10),
    };
  } catch (err) {
    logger.warn("Could not fetch player location:", err.message);
    return null;
  }
}

async function fetchLogs() {
  try {
    const territoryName = await fetchTerritoryName();
    const doc = await fetchHtml(`${BASE_URL}logs.php`);
    const rows = Array.from(doc.querySelectorAll("table tr")).slice(1);
    return rows.map((row) => ({
      event: row.querySelector("td:nth-child(1) span")?.innerText || "Unknown Event",
      details: row.querySelector("td:nth-child(1) .logs-hidden")?.innerText.trim() || "",
      from: row.querySelector("td:nth-child(2)")?.innerText.trim() || "Unknown",
      withWhom: row.querySelector("td:nth-child(3)")?.innerText.trim() || "None",
      date: row.querySelector("td:nth-child(4)")?.innerText.trim() || "Unknown Date",
      territory: territoryName,
      source: "extension",
    }));
  } catch (err) {
    logger.error("Error fetching logs:", err);
    return [];
  }
}

// ============================================================
// Character profile
// ============================================================
async function fetchCharacter(id) {
  try {
    const res = await fetch(`${CHARACTER_URL}${id}`, { credentials: "include" });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes("error player id")) return null;

    const doc = parser.parseFromString(text, "text/html");
    const name = doc.querySelector("#infos-player h1")?.innerText || null;
    const rank = doc.querySelector("#infos-player div:nth-child(2)")?.innerText.split(" - ")[1] || null;
    const popularity = doc.querySelector("a[href*='reputation']")?.innerText || null;
    const faction = doc.querySelector("a[href*='faction']")?.innerText || null;
    const role = doc
      .querySelector("#infos-player div:nth-child(3)")
      ?.innerText.split("(<i>")[1]
      ?.split("</i>)")[0] || null;
    const portraitUrl = doc.querySelector(".infos-portrait img")?.getAttribute("src") || null;
    const story = stripHtml(doc.querySelector("td[colspan='2']")?.innerHTML);

    let mdj = null;
    const mdjElement = doc.querySelector(".infos-text");
    if (mdjElement && !mdjElement.querySelector("i")) {
      mdj = stripHtml(mdjElement.innerHTML);
    }

    const equipment = Array.from(doc.querySelectorAll(".infos-item")).map((item) => ({
      id: item.getAttribute("data-id"),
      name: item.getAttribute("data-name"),
      description: item.getAttribute("data-text"),
      price: item.getAttribute("data-price"),
      type: item.getAttribute("data-type"),
      imageUrl: item.getAttribute("data-img"),
      thumbnailUrl: item.querySelector("img")?.src || null,
    }));

    const race = detectRaceFromDoc(doc);
    if (!race) logger.debug(`No race detected for ${name} (${id})`);

    return { targetId: id, name, rank, popularity, faction, role, race, portraitUrl, story, mdj, equipment };
  } catch (err) {
    logger.error(`Error fetching character ${id}:`, err);
    return null;
  }
}

// Fetch every character: real players come from the rankings page,
// NPCs are probed from -1 downward with a tolerance for sparse IDs.
async function fetchAllCharacters() {
  logger.info("Fetching all characters...");
  const characters = [];

  const positiveIds = await fetchPlayerIdsFromRankings();
  logger.info(`Got ${positiveIds.length} player IDs from rankings`);
  for (const id of positiveIds) {
    const character = await fetchCharacter(id);
    if (character) characters.push(character);
  }

  // Probe negative IDs (NPCs) sparsely — the game has gaps. Tolerate up to
  // 200 consecutive misses before assuming we're past the last NPC, with a
  // hard floor at -5000 to prevent infinite loops on edge cases.
  let consecutiveMisses = 0;
  for (let id = -1; consecutiveMisses < 200 && id > -5000; id--) {
    const character = await fetchCharacter(id);
    if (character) {
      characters.push(character);
      consecutiveMisses = 0;
    } else {
      consecutiveMisses++;
    }
  }
  logger.info(`NPC probe stopped at id=${-(characters.length - positiveIds.length) - consecutiveMisses}, ${characters.length - positiveIds.length} NPCs found`);

  logger.info(`Total characters fetched: ${characters.length}`);
  return characters;
}

async function fetchPlayerIdsFromRankings() {
  try {
    const doc = await fetchHtml(`${BASE_URL}classements.php`);
    const rows = Array.from(doc.querySelectorAll("table.marbre tr")).slice(1);
    return rows
      .map((row) => {
        const link = row.querySelector("a[href*='targetId=']");
        const match = link?.getAttribute("href")?.match(/targetId=(-?\d+)/);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter((id) => id != null);
  } catch (err) {
    logger.error("Error fetching ranking IDs:", err);
    return [];
  }
}

// ============================================================
// Forum scraping (unified RP / Private)
// ============================================================
// Strips the "#lastMessageId" fragment and any page param from a topic href.
// The fragment matters twice: it makes "&page=N" land inside the fragment
// (so the server never sees it), and it changes every time a reply is posted,
// which would make the tracker upsert a brand new topic on each sync.
function normalizeTopicLink(href) {
  try {
    const url = new URL(href, BASE_URL);
    url.hash = "";
    url.searchParams.delete("page");
    return url.toString();
  } catch {
    return String(href).split("#")[0].replace(/[?&]page=\d+/g, "");
  }
}

// Builds the URL for page N of a list or topic, without disturbing the rest
// of the query string.
function pageUrl(baseUrl, n) {
  try {
    const url = new URL(baseUrl, BASE_URL);
    url.hash = "";
    url.searchParams.set("page", String(n));
    return url.toString();
  } catch {
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}page=${n}`;
  }
}

// Reads the highest "page=N" value from anchors whose visible text looks like a
// pagination control. The engine labels them "page 1", "page 2", "dernier";
// bare numbers and arrows are accepted too in case other views differ. This
// filters out message-body links that happen to contain "page=".
const PAGINATION_TEXT = /^(?:page\s*)?\d+$|^[«»‹›<>]+$|^(?:premier|dernier|suivant|précédent|precedent)$/i;

function detectMaxPage(doc) {
  let max = 1;
  doc.querySelectorAll("a[href*='page=']").forEach((a) => {
    const m = (a.getAttribute("href") || "").match(/[?&]page=(\d+)/);
    if (!m) return;
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n)) return;
    const text = (a.textContent || "").trim();
    if (PAGINATION_TEXT.test(text)) {
      if (n > max) max = n;
    }
  });
  return max;
}

// Walks a list page that uses ?page=N pagination, calling extractRows on
// each page's parsed Document and concatenating results.
async function fetchPaginatedRows(baseUrl, extractRows, label = "list") {
  const all = [];
  const seen = new Set();
  let currentPage = 1;
  let maxPage = 1;
  while (currentPage <= maxPage) {
    const url = currentPage === 1 ? baseUrl : pageUrl(baseUrl, currentPage);
    let doc;
    try {
      doc = await fetchHtml(url);
    } catch (err) {
      logger.error(`${label} page ${currentPage} fetch failed:`, err);
      break;
    }
    // Listings routinely re-serve the same page under several ?page=N values
    // (an out-of-range page falls back to the first one), and detectMaxPage
    // then reports a page count far above what really exists. Stop as soon as
    // a page brings nothing new instead of walking to the announced maximum.
    const rows = extractRows(doc);
    const fresh = rows.filter((row) => {
      const key = row?.topicLink || JSON.stringify(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    all.push(...fresh);
    if (currentPage > 1 && fresh.length === 0) {
      logger.debug(`${label}: page ${currentPage} brought nothing new, stopping`);
      break;
    }

    const detected = detectMaxPage(doc);
    if (detected > maxPage) maxPage = detected;
    logger.debug(`${label} page ${currentPage}/${maxPage}: ${fresh.length} new rows`);

    currentPage++;
    if (currentPage > 100) {
      logger.warn(`${label}: stopping at page 100 (safety cap)`);
      break;
    }
  }
  return all;
}

// Forum listings expose the exact post count in their second column
// ("Sujet | Réponses | Dernière"). Reading it costs nothing and tells us
// whether a topic is worth re-fetching at all.
function messageCountFromRow(row) {
  const cell = row.querySelectorAll("td")[1];
  const parsed = parseInt((cell?.innerText || "").trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function fetchForumTopics(forumLink) {
  try {
    const rows = await fetchPaginatedRows(
      forumLink,
      (doc) =>
        Array.from(doc.querySelectorAll("tr.tr-forum"))
          .map((row) => {
            const messageCount = messageCountFromRow(row);
            // RP/Private style: cell carries data-topic with the topic id
            const topicCell = row.querySelector("td[data-topic]");
            if (topicCell) {
              const topicNameRaw = topicCell.innerText.trim() || "Unknown Topic";
              const topicAuthorRaw = topicCell.querySelector("div i")?.innerText.trim() || "Unknown Author";
              const dataTopic = topicCell.getAttribute("data-topic");
              return {
                topicName: topicNameRaw.replace(/Par\s+.+$/i, "").trim(),
                topicAuthor: topicAuthorRaw.replace(/^Par\s+/i, ""),
                topicLink: dataTopic ? `${BASE_URL}forum.php?topic=${dataTopic}` : null,
                messageCount,
              };
            }
            // HRP/Missive style: first cell holds an <a href="forum.php?topic=…">
            const subjectAnchor = row.querySelector("td:first-child a[href*='topic=']");
            if (subjectAnchor) {
              const topicLink = normalizeTopicLink(subjectAnchor.getAttribute("href"));
              const topicNameRaw = subjectAnchor.innerText.trim() || "Untitled";
              const topicAuthor =
                row.querySelector("td:first-child div i")?.innerText.trim().replace(/^Par\s+/i, "") ||
                "Unknown Author";
              return {
                topicName: topicNameRaw.replace(/Par\s+\S.*$/i, "").trim(),
                topicAuthor,
                topicLink,
                messageCount,
              };
            }
            return null;
          })
          .filter(Boolean),
      `forum:${forumLink}`
    );
    // Dedup by topicLink: HRP forums sometimes serve the same page under
    // different ?page=N values, which would otherwise re-process the same
    // topics over and over.
    const seen = new Set();
    return rows.filter((t) => {
      if (!t.topicLink || seen.has(t.topicLink)) return false;
      seen.add(t.topicLink);
      return true;
    });
  } catch (err) {
    logger.error("Error fetching forum topics:", err);
    return [];
  }
}

function extractMessagesFromDoc(doc) {
  // Canonical RP/Private layout: paired rows where the post body is a
  // tr.tr-topic1 and the author info sits in the previous sibling row.
  let rows = Array.from(doc.querySelectorAll("tr.tr-topic1"));
  if (rows.length > 0) {
    return rows.map((row) => {
      const authorRow = row.previousElementSibling;
      const authorLink = authorRow?.querySelector("a[href*='infos.php?targetId=']");
      const targetIdMatch = authorLink?.getAttribute("href")?.match(/targetId=(-?\d+)/);
      return {
        author: {
          name: authorRow?.querySelector("div > a")?.innerText.trim() || "Unknown Author",
          targetId: targetIdMatch ? parseInt(targetIdMatch[1], 10) : null,
        },
        content: row.querySelector("td[data-post] div")?.innerHTML.trim() || "No content",
        date: authorRow?.querySelector("span[style*='color: grey']")?.innerText.trim() || "Unknown Date",
      };
    });
  }
  // Fallback: locate every post body via td[data-post] and walk back to the
  // nearest preceding row that contains an infos.php?targetId link.
  const postCells = Array.from(doc.querySelectorAll("td[data-post]"));
  return postCells.map((cell) => {
    const row = cell.closest("tr");
    let authorRow = row?.previousElementSibling;
    while (authorRow && !authorRow.querySelector("a[href*='infos.php?targetId=']")) {
      authorRow = authorRow.previousElementSibling;
    }
    const authorLink = authorRow?.querySelector("a[href*='infos.php?targetId=']");
    const targetIdMatch = authorLink?.getAttribute("href")?.match(/targetId=(-?\d+)/);
    return {
      author: {
        name: authorLink?.innerText.trim() || "Unknown Author",
        targetId: targetIdMatch ? parseInt(targetIdMatch[1], 10) : null,
      },
      content: cell.querySelector("div")?.innerHTML.trim() || cell.innerHTML.trim() || "No content",
      date: authorRow?.querySelector("span[style*='grey']")?.innerText.trim() || "Unknown Date",
    };
  });
}

// Posts per page in the forum engine, used to turn a stored message count
// into the page to resume from.
const TOPIC_PAGE_SIZE = 5;

// Where to resume a topic, given what the tracker already stored (`known`) and
// what the listing announces (`total`). null means "nothing new, skip it".
// Without a usable hint we fall back to a full scan.
function resumeFromPage(known, total) {
  if (typeof total !== "number" || total <= 0) return 1;
  if (typeof known !== "number" || known <= 0) return 1;
  if (known >= total) return null;
  // Start one page early: the page holding the last stored message is usually
  // partial, and a post deleted upstream would otherwise shift every index.
  return Math.max(1, Math.floor(known / TOPIC_PAGE_SIZE));
}

async function fetchTopicMessages(topicLink, startPage = 1) {
  const allMessages = [];
  const seenSignatures = new Set();
  const firstPage = Math.max(1, startPage);
  let currentPage = firstPage;
  let maxPage = firstPage;
  while (currentPage <= maxPage) {
    try {
      const doc = await fetchHtml(pageUrl(topicLink, currentPage));
      const messages = extractMessagesFromDoc(doc);

      // De-dup against previously seen pages to defend against pagination
      // loops that re-serve the same page (e.g. when an out-of-range page
      // number falls back to page 1).
      const fresh = messages.filter((m) => {
        const sig = `${m.date}|${m.author?.targetId ?? "null"}|${(m.content || "").slice(0, 80)}`;
        if (seenSignatures.has(sig)) return false;
        seenSignatures.add(sig);
        return true;
      });
      if (currentPage > firstPage && fresh.length === 0) break;
      allMessages.push(...fresh);

      const detected = detectMaxPage(doc);
      if (detected > maxPage) maxPage = detected;
      logger.debug(`topic ${topicLink} page ${currentPage}/${maxPage}: ${fresh.length} new messages`);

      currentPage++;
      if (currentPage - firstPage > 100) {
        logger.warn(`topic ${topicLink}: stopping 100 pages after ${firstPage} (safety cap)`);
        break;
      }
    } catch (err) {
      logger.error("Error fetching topic page:", err);
      break;
    }
  }
  if (allMessages.length === 0) {
    logger.warn(`No messages extracted from ${topicLink}`);
  }
  return allMessages;
}

// Missives are the player's private correspondence at /forum.php?forum=Missives.
// Different DOM than the public/private forums: a flat <table.marbre> of
// <tr.tr-forum> rows with one <a> per cell (Sujet | Réponses | Dernière).
async function fetchMissives(knownCounts = {}) {
  try {
    const listUrl = `${BASE_URL}forum.php?forum=Missives`;
    const stubs = await fetchPaginatedRows(
      listUrl,
      (doc) =>
        Array.from(doc.querySelectorAll("table.marbre tr.tr-forum"))
          .map((row) => {
            const subjectAnchor = row.querySelector("td:first-child a");
            const href = subjectAnchor?.getAttribute("href");
            if (!href) return null;
            const topicLink = normalizeTopicLink(href);
            const topicName = subjectAnchor.innerText?.trim() || "Untitled";
            return { topicName, topicLink, messageCount: messageCountFromRow(row) };
          })
          .filter(Boolean),
      "missives-list"
    );

    // Dedup as well: the list re-serves the same page under several ?page=N.
    const seen = new Set();
    const unique = stubs.filter((s) => {
      if (seen.has(s.topicLink)) return false;
      seen.add(s.topicLink);
      return true;
    });

    logger.info(`Missives: ${unique.length} threads total across all pages`);

    const topics = [];
    let skipped = 0;
    for (const stub of unique) {
      const fromPage = resumeFromPage(knownCounts[stub.topicLink], stub.messageCount);
      if (fromPage === null) {
        skipped++;
        continue;
      }
      const messages = await fetchTopicMessages(stub.topicLink, fromPage);
      const topicAuthor = messages[0]?.author?.name || "Unknown Author";
      topics.push({ ...stub, topicAuthor, messages });
    }
    logger.info(`Missives: ${topics.length} threads fetched, ${skipped} unchanged`);

    return [
      {
        forum: {
          name: "Missives",
          link: listUrl,
          type: "Missives",
          faction: null,
        },
        topics,
      },
    ];
  } catch (err) {
    logger.error("Error fetching Missives:", err);
    return [];
  }
}

// sectionTitle: the <th> label on forum.php ("Privés" or "RP")
// type: tag stored on each scraped forum ("Private" or "RP")
async function fetchForumSection(sectionTitle, type, knownCounts = {}) {
  try {
    const doc = await fetchHtml(`${BASE_URL}forum.php`);
    // Le titre porte désormais une pastille de non-lus (« RP <span>1</span> ») :
    // on compare le libellé sans elle.
    const sectionLabel = (h) => {
      const clone = h.cloneNode(true);
      clone.querySelectorAll(".forum-unread-mini, .cartouche").forEach((badge) => badge.remove());
      return clone.textContent.trim();
    };
    const sectionHeader = Array.from(doc.querySelectorAll("th")).find(
      (h) => sectionLabel(h) === sectionTitle
    );
    if (!sectionHeader) {
      logger.warn(`No '${sectionTitle}' section found`);
      return [];
    }

    const rows = [];
    let nextRow = sectionHeader.parentElement.nextElementSibling;
    while (nextRow && nextRow.classList.contains("tr-cat")) {
      rows.push(nextRow);
      nextRow = nextRow.nextElementSibling;
    }
    if (rows.length === 0) {
      logger.warn(`No forums under '${sectionTitle}'`);
      return [];
    }

    const forums = rows
      .map((row) => {
        const forumName = row.querySelector("td.forum")?.getAttribute("data-forum");
        if (!forumName) return null;
        return {
          forumName,
          forumLink: `${BASE_URL}forum.php?forum=${encodeURIComponent(forumName)}`,
        };
      })
      .filter(Boolean);

    let skipped = 0;
    const result = await Promise.all(
      forums.map(async (forum) => {
        const topics = await fetchForumTopics(forum.forumLink);
        const topicsWithMessages = await Promise.all(
          topics.map(async (topic) => {
            if (!topic.topicLink) return null;
            const fromPage = resumeFromPage(knownCounts[topic.topicLink], topic.messageCount);
            if (fromPage === null) {
              skipped++;
              return null;
            }
            const messages = await fetchTopicMessages(topic.topicLink, fromPage);
            return { ...topic, messages };
          })
        );
        const faction =
          type === "Private"
            ? Object.keys(FACTION_PRIVATE_FORUMS).find((f) =>
                FACTION_PRIVATE_FORUMS[f].includes(forum.forumName)
              ) || "Unknown Faction"
            : type === "HRP"
            ? null
            : "Unknown";
        return {
          forum: { name: forum.forumName, link: forum.forumLink, type, faction },
          topics: topicsWithMessages.filter(Boolean),
        };
      })
    );
    logger.info(`${type} forums scraped: ${result.length} (${skipped} topics unchanged)`);
    return result;
  } catch (err) {
    logger.error(`Error fetching ${type} forum data:`, err);
    return [];
  }
}

// ============================================================
// Map — extracts the full SVG layout (tiles, walls, elements,
// foregrounds, routes, players) along with the asset URLs that
// will need to be downloaded server-side.
// ============================================================
// Volontairement figé sur le vrai jeu, même en arpentant le moteur local : les
// images y sont les mêmes, et le tracker ne miroite que celles du CDN du jeu
// (liste blanche stricte dans app/api/assets).
const ASSET_BASE = "https://age-of-olympia.net/";

function extractName(href) {
  // "img/tiles/falaise.png" → "falaise"
  if (!href) return null;
  const last = href.split("/").pop();
  if (!last) return null;
  return last.replace(/\.[^.]+$/, "");
}

function absAssetUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return ASSET_BASE + href.replace(/^\.?\//, "");
}

// Reads href from an SVG element. Tries — in order — the modern non-namespaced
// `href`, the legacy `xlink:href`, and the namespaced lookup. AOM's SVG
// uses the legacy form, which `getAttribute("href")` returns null for.
function getSvgHref(el) {
  return (
    el.getAttribute("href") ||
    el.getAttribute("xlink:href") ||
    el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
    null
  );
}

// Premier identifiant d'entité côté moteur (ENTITY_ID_RANGES, famille
// « building ») : au-delà de 19 999 999, ce n'est plus un personnage.
const ENTITY_ID_MIN = 20000000;

async function fetchMapData() {
  const doc = await fetchHtml(`${BASE_URL}index.php`);
  if (!doc.querySelector("#svg-container svg")) {
    throw new Error("Map SVG not found");
  }

  // Build pixel→logical coord lookup from the .case grid overlay.
  const coordsMap = new Map();
  Array.from(doc.querySelectorAll(".case[data-coords]")).forEach((cell) => {
    const coords = cell.getAttribute("data-coords");
    if (!coords) return;
    const [x, y] = coords.split(",").map(Number);
    const pixelX = parseInt(cell.getAttribute("x") || "0");
    const pixelY = parseInt(cell.getAttribute("y") || "0");
    coordsMap.set(`${pixelX},${pixelY}`, { x, y });
  });

  // Collect every unique asset URL referenced — sent to the backend so it
  // can mirror them under public/assets/aom/.
  const assetUrls = new Set();

  // Une image composée (bâtiment, maison du décor) s'étire sur plusieurs
  // cases : width/height en multiples de 50, ancrée sur sa case en haut à
  // gauche, qui peut tomber hors de la grille visible (maison en y = -50).
  // On la replace alors par rapport à une case connue : x croît vers la
  // droite, y du jeu décroît vers le bas.
  const anyCell = coordsMap.entries().next().value;
  const offGridLogical = (pixelX, pixelY) => {
    if (!anyCell || pixelX % 50 !== 0 || pixelY % 50 !== 0) return null;
    const [key, ref] = anyCell;
    const [refX, refY] = key.split(",").map(Number);
    return { x: ref.x + (pixelX - refX) / 50, y: ref.y - (pixelY - refY) / 50 };
  };
  const cellSpan = (el, attr) => {
    const px = parseInt(el.getAttribute(attr) || "50", 10);
    return px > 50 && px % 50 === 0 ? px / 50 : 1;
  };

  const extractLayer = (selector, extra = () => ({})) => {
    const all = Array.from(doc.querySelectorAll(selector));
    let nullHrefCount = 0;
    const out = all
      .map((el) => {
        const pixelX = parseInt(el.getAttribute("x") || "0");
        const pixelY = parseInt(el.getAttribute("y") || "0");
        const w = cellSpan(el, "width");
        const h = cellSpan(el, "height");
        const logical =
          coordsMap.get(`${pixelX},${pixelY}`) ||
          (w > 1 || h > 1 ? offGridLogical(pixelX, pixelY) : null);
        if (!logical) return null;
        const href = getSvgHref(el);
        if (!href) nullHrefCount++;
        if (href) assetUrls.add(absAssetUrl(href));
        return {
          x: logical.x,
          y: logical.y,
          name: extractName(href),
          href,
          ...(w > 1 || h > 1 ? { w, h } : {}),
          ...extra(el),
        };
      })
      .filter(Boolean);
    if (nullHrefCount > 0) {
      const sample = all.find((el) => !getSvgHref(el));
      logger.warn(
        `${selector}: ${nullHrefCount}/${all.length} elements without href. ` +
          `Sample outerHTML: ${sample?.outerHTML?.slice(0, 200) || "n/a"}`
      );
    }
    return out;
  };

  // Saison 3 : l'eau, la lave, le poison… ne sont plus des <image> par case.
  // Chaque calque #anim-layers-elements-N pose une texture animée (un <div>
  // dans un foreignObject, fond img/elements/eau.webp, opacité sur le div)
  // sur une zone, découpée par un masque fait d'une petite <svg> par case.
  // Chaque case porte son masque de bord, elem-edge-<bits> (1 N, 2 E, 4 S,
  // 8 O : bord fondu ; 16 NE, 32 SE, 64 SO, 128 NO : coin arrondi), et
  // parfois une demi-case en diagonale, elem-half-<ESW|WNE|…>.
  const maskRef = (el) => (el?.getAttribute("mask") || "").match(/#([^)]+)/)?.[1] || null;
  const extractAnimatedElements = () => {
    const out = [];
    for (const group of doc.querySelectorAll("[id^='anim-layers-elements-']")) {
      for (const region of group.children) {
        if (region.tagName.toLowerCase() !== "svg") continue;
        const fo = region.querySelector("foreignObject");
        const mask = fo && doc.getElementById(maskRef(fo));
        const texture = fo?.querySelector(".anim-layer-texture");
        const href = (texture?.getAttribute("style") || "").match(/url\(['"]?([^'")?]+)/)?.[1] || null;
        if (!mask || !href) continue;
        assetUrls.add(absAssetUrl(href));
        const opacity = parseFloat(fo.querySelector("div")?.style.opacity || "1");
        const rx = parseInt(region.getAttribute("x") || "0", 10);
        const ry = parseInt(region.getAttribute("y") || "0", 10);
        for (const cell of mask.children) {
          if (cell.tagName.toLowerCase() !== "svg") continue;
          const px = rx + parseInt(cell.getAttribute("x") || "0", 10);
          const py = ry + parseInt(cell.getAttribute("y") || "0", 10);
          const logical = coordsMap.get(`${px},${py}`) || offGridLogical(px, py);
          if (!logical) continue;
          const masks = Array.from(cell.querySelectorAll("[mask]")).map(maskRef);
          const edge = parseInt(masks.find((m) => m?.startsWith("elem-edge-"))?.slice(10) || "0", 10);
          const half = masks.find((m) => m?.startsWith("elem-half-"))?.slice(10) || null;
          out.push({
            x: logical.x,
            y: logical.y,
            name: extractName(href),
            href,
            opacity,
            ...(edge ? { edge } : {}),
            ...(half ? { half } : {}),
          });
        }
      }
    }
    // Une case peut tomber dans deux zones du même élément (pleine dans
    // l'une, demi-case dans l'autre) : le jeu les superpose. On garde leur
    // union : pleine dès qu'une des deux l'est, bord fondu seulement là où
    // les deux le fondent.
    const merged = new Map();
    for (const cell of out) {
      const key = `${cell.x},${cell.y},${cell.name}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, cell);
        continue;
      }
      const edge = (prev.edge || 0) & (cell.edge || 0);
      const half = prev.half && prev.half === cell.half ? prev.half : null;
      const next = { ...prev };
      delete next.edge;
      delete next.half;
      merged.set(key, { ...next, ...(edge ? { edge } : {}), ...(half ? { half } : {}) });
    }
    return Array.from(merged.values());
  };

  const tiles = extractLayer("[data-table='tiles']");
  // Saison 3 : murs, arbres, coffres, statues sont des entités, peintes dans
  // le calque des personnages (data-table='players'). Leur identifiant les
  // trahit (plages ENTITY_ID_RANGES du moteur : 1 à 9 999 999 pour les
  // joueurs, négatif pour les PNJ, 20 000 000 et plus pour les entités) : on
  // les range dans le calque que dit leur image (img/walls/…, img/foregrounds/…).
  const entityLayer = (el) => {
    const id = (el.id || "").match(/^players(-?\d+)$/);
    if (!id || parseInt(id[1], 10) < ENTITY_ID_MIN) return null;
    const folder = (getSvgHref(el) || "").match(/^img\/([a-z]+)\//)?.[1];
    return ["walls", "elements", "foregrounds", "plants", "routes"].includes(folder) ? folder : "walls";
  };
  const entities = { walls: [], elements: [], foregrounds: [], plants: [], routes: [] };
  for (const el of doc.querySelectorAll("[data-table='players']:not(.avatar-shadow)")) {
    const layer = entityLayer(el);
    if (layer) entities[layer].push(el);
  }
  const entityRows = (layer) =>
    entities[layer].length > 0
      ? extractLayer(entities[layer].map((el) => `#${CSS.escape(el.id)}`).join(", "))
      : [];
  const walls = [...extractLayer("[data-table='walls']"), ...entityRows("walls")];
  // Filter out footprint traces — they're ephemeral, name varies by direction
  // (trace_pas_e, trace_pas_se, …) so the (coordsId, name) unique index
  // doesn't replace them; they'd accumulate forever otherwise.
  const elements = [
    ...extractLayer("[data-table='elements']", (el) => ({
      opacity: parseFloat(el.style.opacity || "1"),
    })),
    ...entityRows("elements"),
    ...extractAnimatedElements(),
  ].filter((e) => e.name && !e.name.startsWith("trace_pas"));
  // Filter out the engine's perception-fog overlay (img/foregrounds/ombre.png).
  // It's painted on the cells at the edge of the player's current view, so
  // accumulating it across scrapes leaves "shadows" on cells the player has
  // since walked through and seen clearly.
  // Le grand décor (data-table='scenery', maisons composées) se pose sur une
  // case comme un premier plan ; ceux qui débordent de la grille sont ignorés.
  const allForegrounds = [
    ...extractLayer("[data-table='foregrounds']"),
    ...extractLayer("[data-table='scenery']"),
    ...entityRows("foregrounds"),
  ];
  const foggedCells = new Set(
    allForegrounds.filter((f) => f.name === "ombre").map((f) => `${f.x},${f.y}`)
  );
  const foregrounds = allForegrounds.filter((f) => f.name !== "ombre");
  const routes = [...extractLayer("[data-table='routes']"), ...entityRows("routes")];
  const plants = [...extractLayer("[data-table='plants']"), ...entityRows("plants")];

  // Cells genuinely observed by this scrape: every cell with a ground tile,
  // minus the fogged ones (their content may be partially rendered, so they
  // must never drive deletions). The tracker reconciles these cells: any
  // stored layer entry absent from this payload no longer exists in game
  // (destroyed barricade, harvested plant, …) and gets removed.
  const observedCells = Array.from(new Set(tiles.map((t) => `${t.x},${t.y}`)))
    .filter((key) => !foggedCells.has(key))
    .map((key) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y };
    });

  // Race-hint color code: the engine paints a colored rect under each player
  // (style "fill: transparent; stroke-width: 5; stroke: <race bgColor>", or
  // "fill: <bgColor>" in raceHintMax mode). Grid cells also use rect.case but
  // always carry data-coords (as do go-rect/destroy-rect) — race rects never do.
  const playerColorByPixel = new Map();
  Array.from(doc.querySelectorAll("rect.case:not([data-coords])")).forEach((r) => {
    const style = r.getAttribute("style") || "";
    const stroke = style.match(/stroke:\s*([^;]+)/)?.[1]?.trim();
    const fill = style.match(/fill:\s*([^;]+)/)?.[1]?.trim();
    const pick = (v) => (v && v !== "transparent" && v !== "none" ? v : null);
    const color = pick(stroke) || pick(fill);
    if (!color) return;
    const x = parseInt(r.getAttribute("x") || "0");
    const y = parseInt(r.getAttribute("y") || "0");
    playerColorByPixel.set(`${x},${y}`, color);
  });

  // Players carry their AOM targetId in the element id ("players57" → 57).
  // Les entités (voir entityLayer) ont déjà rejoint leur calque.
  const players = Array.from(doc.querySelectorAll("[data-table='players']"))
    .filter((el) => !entityLayer(el))
    .map((el) => {
      const pixelX = parseInt(el.getAttribute("x") || "0");
      const pixelY = parseInt(el.getAttribute("y") || "0");
      const logical = coordsMap.get(`${pixelX},${pixelY}`);
      if (!logical) return null;
      const targetIdMatch = (el.id || "").match(/^players(-?\d+)$/);
      const targetId = targetIdMatch ? parseInt(targetIdMatch[1], 10) : null;
      const href = getSvgHref(el);
      if (href) assetUrls.add(absAssetUrl(href));
      return {
        x: logical.x,
        y: logical.y,
        targetId,
        href,
        color: playerColorByPixel.get(`${pixelX},${pixelY}`) || null,
      };
    })
    .filter(Boolean);

  // The per-z backdrop lives in a `background: url(img/tiles/<bg>)` style —
  // e.g. sky.webp for an open-air upper level like the Remparts. It sits on
  // the #svg-container element (which also carries `max-width`), not always on
  // the inner <svg>, so read the container first and fall back to the svg.
  // Kept as a render hint only: the bg filename does not reliably identify the
  // plan (some plans reuse another's bg, e.g. taverne_d_olympia_s2 ->
  // campement_redoraan.png), so the plan is resolved from map.php?local below.
  const svgContainer = doc.querySelector("#svg-container");
  const svg = svgContainer?.querySelector("svg");
  const bgStyle =
    `${svgContainer?.getAttribute("style") || ""} ${svg?.getAttribute("style") || ""}`;
  // Nouvelle interface : plus de background CSS, le sol est le motif
  // <pattern id="ground-pattern"> de l'échiquier.
  const groundImage = svg?.querySelector("#ground-pattern image");
  const groundHref = groundImage?.getAttribute("href") || groundImage?.getAttribute("xlink:href") || "";
  const bgMatch =
    bgStyle.match(/url\(['"]?(img\/tiles\/([a-z0-9_]+)\.[a-z]+)['"]?\)/i) ||
    groundHref.match(/^(img\/tiles\/([a-z0-9_]+)\.[a-z]+)/i);
  const background = bgMatch ? bgMatch[1] : null;
  const fallbackPlan = bgMatch?.[2] || "gaia";
  if (background) assetUrls.add(absAssetUrl(background));

  // Authoritative plan/z/coords come from map.php?local's position panel.
  // When unavailable, fall back to the SVG-derived plan and z=0.
  const location = await fetchPlayerLocation();

  return {
    plan: fallbackPlan,
    planKey: location?.planKey ?? null,
    z: location?.z ?? 0,
    planDisplayName: location?.planDisplayName ?? null,
    zName: location?.zName ?? null,
    playerCoords: location ? { x: location.x, y: location.y, z: location.z } : null,
    tiles, walls, elements, foregrounds, routes, plants, players,
    observedCells,
    background,
    assetUrls: Array.from(assetUrls).filter(Boolean),
  };
}

// ============================================================
// MDJ (mots du jour)
// ============================================================

// Read the MDJ shown on a character's profile page (.infos-text). Returns
// null when the slot is empty (italic placeholder) or unreadable.
async function fetchCharacterMdj(targetId) {
  try {
    const doc = await fetchHtml(`${CHARACTER_URL}${targetId}`);
    const mdjElement = doc.querySelector(".infos-text");
    if (!mdjElement || mdjElement.querySelector("i")) return null;
    const mdj = stripHtml(mdjElement.innerHTML);
    return mdj && mdj.length > 0 ? mdj : null;
  } catch (err) {
    logger.error(`Error fetching MDJ for ${targetId}:`, err);
    return null;
  }
}

// Snapshot the MDJ of every character currently in perception on the map.
// Skips the logged-in player (they get their own MDJ via the regular
// character fetch).
async function fetchMapPerceptionMdjs(selfTargetId) {
  const doc = await fetchHtml(`${BASE_URL}index.php`);
  const players = Array.from(doc.querySelectorAll("[data-table='players']"))
    .map((el) => {
      const m = (el.id || "").match(/^players(-?\d+)$/);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter((id) => id != null && id !== selfTargetId);

  const unique = Array.from(new Set(players));
  logger.info(`MDJ perception: ${unique.length} characters on the map`);

  const out = [];
  for (const targetId of unique) {
    const mdj = await fetchCharacterMdj(targetId);
    if (mdj) out.push({ targetId, mdj });
  }
  return out;
}

// Scrape logs.php?mdj — each row records a character's MDJ change with a
// timestamp. Format mirrors the regular logs.php (4 cells: event/details,
// from, withWhom, date). We pull the character targetId from the `(mat.N)`
// suffix and the new MDJ from either the hidden detail span or the visible
// event text.
async function fetchMdjLogs() {
  try {
    const doc = await fetchHtml(`${BASE_URL}logs.php?mdj`);
    const rows = Array.from(doc.querySelectorAll("table tr")).slice(1);
    const out = [];
    for (const row of rows) {
      const fromCell = row.querySelector("td:nth-child(2)");
      const fromText = fromCell?.innerText.trim() || "";
      const targetIdMatch = fromText.match(/\(mat\.(-?\d+)\)/);
      if (!targetIdMatch) continue;
      const targetId = parseInt(targetIdMatch[1], 10);

      const detailsEl = row.querySelector("td:nth-child(1) .logs-hidden");
      const eventEl = row.querySelector("td:nth-child(1) span");
      const mdjRaw =
        detailsEl?.innerText.trim() ||
        eventEl?.innerText.trim() ||
        row.querySelector("td:nth-child(1)")?.innerText.trim() ||
        "";
      const mdj = mdjRaw.replace(/^.*?:\s*/, "").trim();
      if (!mdj) continue;

      const date = row.querySelector("td:nth-child(4)")?.innerText.trim() || "";
      out.push({ targetId, mdj, date });
    }
    logger.info(`MDJ logs: ${out.length} entries parsed`);
    return out;
  } catch (err) {
    logger.error("Error fetching MDJ logs:", err);
    return [];
  }
}

// ============================================================
// Reputation
// ============================================================
async function fetchReputationData(id) {
  try {
    const doc = await fetchHtml(`${CHARACTER_URL}${id}&reputation`);

    const findSectionTable = (sectionTitle) => {
      const header = Array.from(doc.querySelectorAll("h2")).find((h) =>
        h.textContent?.trim().includes(sectionTitle)
      );
      if (!header) return null;
      let el = header.nextElementSibling;
      while (el && el.tagName !== "TABLE") el = el.nextElementSibling;
      return el || null;
    };

    const parseRows = (table, mapRow) => {
      if (!table) return [];
      const rows = Array.from(table.querySelectorAll("tr")).slice(1);
      return rows
        .map((tr) => {
          const tds = tr.querySelectorAll("td");
          if (tds.length < 5) return null;
          try {
            return mapRow(tds);
          } catch (err) {
            logger.error("Error parsing reputation row:", err);
            return null;
          }
        })
        .filter(Boolean);
    };

    // The two named actors in column 2 — same DOM shape for kills/assists/deaths.
    const parseDuel = (cells, leftLabel, rightLabel) => {
      const links = cells[2]?.querySelectorAll("a[href*='infos.php?targetId=']") || [];
      const leftA = links[0] || null;
      const rightA = links[1] || null;
      const leftId = leftA?.getAttribute("href")?.match(/targetId=(-?\d+)/)?.[1] || null;
      const rightId = rightA?.getAttribute("href")?.match(/targetId=(-?\d+)/)?.[1] || null;
      const ranks = Array.from((cells[2]?.textContent || "").matchAll(/\(rang\s+(\d+)\)/g)).map(
        (m) => m[1]
      );
      return {
        avatarUrl: cells[0]?.querySelector("img")?.src || null,
        date: cells[1]?.textContent?.trim() || null,
        [`${leftLabel}Name`]: leftA?.textContent?.trim() || null,
        [`${leftLabel}Id`]: leftId ? parseInt(leftId, 10) : null,
        [`${leftLabel}Rank`]: ranks[0] || null,
        [`${rightLabel}Name`]: rightA?.textContent?.trim() || null,
        [`${rightLabel}Id`]: rightId ? parseInt(rightId, 10) : null,
        [`${rightLabel}Rank`]: ranks[1] || null,
        location: cells[3]?.textContent?.trim() || null,
        experience: cells[4]?.textContent?.trim() || null,
      };
    };

    const kills = parseRows(findSectionTable("Importateur de viandes pour les Limbes"), (c) =>
      parseDuel(c, "killer", "victim")
    );
    const assists = parseRows(findSectionTable("Assistant du Roi des Enfers"), (c) =>
      parseDuel(c, "assister", "victim")
    );
    const deaths = parseRows(findSectionTable("Rameur sur le Styx"), (c) =>
      parseDuel(c, "killer", "victim")
    );

    logger.info(`Reputation for ${id}: kills=${kills.length} assists=${assists.length} deaths=${deaths.length}`);
    return { kills, assists, deaths };
  } catch (err) {
    logger.error(`Error fetching reputation for ${id}:`, err);
    return null;
  }
}

// ============================================================
// Attributes (in-page scraping on index.php)
// ============================================================
function parseAttributes(html) {
  const doc = parser.parseFromString(html, "text/html");
  const table = doc.querySelector("#caracs-menu");
  if (!table) {
    logger.error("Attributes table not found");
    return null;
  }

  const attributes = {};
  const headers = Array.from(table.querySelectorAll("th")).map((th) => th.innerText.trim());
  const dataRow = table.querySelector("tr:nth-child(2)");
  if (dataRow) {
    const values = Array.from(dataRow.querySelectorAll("td")).map((td) => td.innerText.trim());
    headers.forEach((header, index) => {
      let value = values[index];
      // "current/max" attributes (A, Mvt, …) → keep the max so the stored stat
      // doesn't drift with fatigue/combat state.
      if (typeof value === "string" && value.includes("/")) {
        value = value.split("/")[1];
      }
      attributes[header] = isNaN(value) ? value : parseInt(value, 10);
    });
  }

  table.querySelectorAll("tr:nth-child(n+3)").forEach((row) => {
    const text = row.innerText.trim();
    // « Xp: 7253/7500 » jadis, « Xp: 10185/Pi: 655 » désormais (plus de maximum).
    const xpMatch = text.match(/Xp:\s*(\d+)(?:\/(\d+))?/);
    if (xpMatch) attributes.Xp = { current: parseInt(xpMatch[1], 10), max: xpMatch[2] ? parseInt(xpMatch[2], 10) : null };
    const piMatch = text.match(/Pi:\s*(\d+)/);
    if (piMatch) attributes.Pi = parseInt(piMatch[1], 10);
    const fatigueMatch = text.match(/Fatigue.*:\s*([-+]?\d+)/);
    if (fatigueMatch) attributes.Fatigue = parseInt(fatigueMatch[1], 10);
    const malusMatch = text.match(/Malus.*:\s*(-?\d+)/);
    if (malusMatch) attributes.Malus = parseInt(malusMatch[1], 10);
  });

  return attributes;
}

// Le tableau des caracs se lit en arrière-plan sur load_caracs.php. Cliquer
// sur #show-caracs ouvrait, dans le HUD, le panneau Caractéristiques sous les
// yeux du joueur à chaque auto-sync (et l'ancien volet #load-caracs, que le
// HUD vide, ne se remplissait plus : délai dépassé, nouvel essai au
// chargement suivant).
async function fetchIndexAttributes() {
  const res = await fetch(`${BASE_URL}load_caracs.php`, { credentials: "include" });
  if (!res.ok) return { error: `load_caracs.php: HTTP ${res.status}` };
  const attributes = parseAttributes(await res.text());
  return attributes ? { attributes } : { error: "Failed to parse attributes" };
}

// ============================================================
// Rankings (in-page scraping on classements.php)
// ============================================================
function parseRankings() {
  if (!window.location.href.includes("classements.php")) {
    return { error: "Not on rankings page" };
  }
  const table = document.querySelector("table.marbre");
  if (!table) return { error: "Rankings table not found" };

  const rankings = [];
  Array.from(table.querySelectorAll("tr")).slice(1).forEach((row) => {
    const columns = row.querySelectorAll("td");
    if (columns.length < 5) return;
    const targetIdMatch = columns[2]?.querySelector("a")?.getAttribute("href")?.match(/targetId=(\d+)/);
    const xpText = columns[4]?.innerText.trim();
    if (!targetIdMatch || !xpText) return;
    const xp = parseInt(xpText.replace(/,/g, ""), 10);
    if (isNaN(xp)) return;
    rankings.push({ targetId: targetIdMatch[1], xp });
  });
  return { rankings };
}

// ============================================================
// Message handlers
// ============================================================
const handlers = {
  PING: async () => ({ ok: true }),
  FETCH_ATTRIBUTES: async () => {
    if (!window.location.href.includes("index.php")) {
      return { error: "Not on index.php" };
    }
    return fetchIndexAttributes();
  },
  FETCH_RANKINGS: async () => parseRankings(),
  FETCH_LOGS: async () => ({ logs: await fetchLogs() }),
  FETCH_ALL_CHARACTERS: async () => ({ characters: await fetchAllCharacters() }),
  // msg.knownCounts maps a topic link to the number of messages the tracker
  // already holds; the background script fetches it before asking for a scrape.
  // Absent (or {}) means "scan everything", which is what a full resync wants.
  FETCH_FORUM_PRIVATE: async (msg) => fetchForumSection("Privés", "Private", msg?.knownCounts),
  FETCH_FORUM_RP: async (msg) => fetchForumSection("RP", "RP", msg?.knownCounts),
  FETCH_FORUM_HRP: async (msg) => fetchForumSection("HRP", "HRP", msg?.knownCounts),
  FETCH_MISSIVES: async (msg) => fetchMissives(msg?.knownCounts),
  FETCH_MAP: async () => fetchMapData(),
  FETCH_MAP_MDJ: async (msg) => ({ entries: await fetchMapPerceptionMdjs(msg.selfTargetId) }),
  FETCH_LOGS_MDJ: async () => ({ entries: await fetchMdjLogs() }),
  FETCH_REPUTATION: async (msg) => fetchReputationData(msg.targetId),
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  logger.debug("Received message:", message?.type);
  const handler = handlers[message?.type];
  if (!handler) return false;

  Promise.resolve(handler(message))
    .then((result) => sendResponse(result))
    .catch((err) => {
      logger.error(`Handler ${message.type} failed:`, err);
      sendResponse({ error: err.message || String(err) });
    });
  return true;
});

// ============================================================
// Missive UI injection (badges on the list, close button on details)
// ============================================================
const STATUS_LABELS = {
  closed: "🔘 Clôturée",
  waiting: "🟡 En attente",
  needs_reply: "🔴 À répondre",
};
const STATUS_COLORS = {
  closed: "#888",
  waiting: "#d4a017",
  needs_reply: "#c0392b",
};

function buildBadge(status) {
  const span = document.createElement("span");
  span.textContent = STATUS_LABELS[status] || "";
  span.style.cssText = `display: inline-block; margin-left: 8px; padding: 2px 6px; border-radius: 4px; background: ${STATUS_COLORS[status] || "#444"}; color: #fff; font-size: 12px; font-weight: 500;`;
  return span;
}

function askBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}

/**
 * Les fils du tracker, rangés sous leur lien normalisé.
 *
 * La base garde encore des copies d'un même fil, héritées des versions qui
 * enregistraient le fragment : elles retombent ici sur la même clé. Le premier
 * arrivé gagne, et /api/missives sert les fils du plus récemment actif au plus
 * ancien : c'est donc la copie vivante qui l'emporte, pas la copie figée.
 */
function topicsByNormalizedLink(topics) {
  const byLink = new Map();
  for (const topic of topics || []) {
    const key = normalizeTopicLink(topic.link);
    if (!byLink.has(key)) byLink.set(key, topic);
  }
  return byLink;
}

async function injectMissivesListBadges() {
  let data;
  try {
    data = await askBackground({ type: "GET_MISSIVES" });
  } catch (err) {
    logger.warn("Could not fetch missives statuses:", err.message);
    return;
  }
  // Des deux côtés la même clé, sinon rien ne se retrouve : la liste sert des
  // href en « ?topic=N#dernierMessage », dont le fragment change à chaque
  // réponse, alors que le tracker range les fils sous leur lien sans fragment
  // (cf. normalizeTopicLink dans /api/forums). Comparer les deux tels quels ne
  // matchait plus que les fils sans nouveau message depuis le rangement.
  const byLink = topicsByNormalizedLink(data.topics);
  const rows = document.querySelectorAll("table.marbre tr.tr-forum");
  let injected = 0;
  let unknown = 0;
  rows.forEach((row) => {
    const a = row.querySelector("td:first-child a");
    if (!a) return;
    const link = normalizeTopicLink(a.getAttribute("href"));
    const topic = byLink.get(link);
    if (!topic) {
      unknown++;
      return;
    }
    if (a.querySelector("[data-aoo-badge]")) return; // already injected
    const badge = buildBadge(topic.status);
    badge.dataset.aooBadge = "1";
    a.appendChild(badge);
    injected++;
  });
  // Compter les lignes sans correspondance, et pas seulement les réussites :
  // c'est ce silence-là qui avait laissé la liste se vider de ses pastilles.
  logger.info(
    `Missive badges: ${injected} injected, ${unknown} row(s) unknown to the tracker, ${byLink.size} thread(s) known`
  );
}

async function injectMissiveTopicButton() {
  const topicParam = new URL(window.location.href).searchParams.get("topic");
  if (!topicParam) return;
  const link = `${BASE_URL}forum.php?topic=${topicParam}`;

  let data;
  try {
    data = await askBackground({ type: "GET_MISSIVES" });
  } catch (err) {
    return; // backend unreachable / not authenticated → silent
  }
  const topic = topicsByNormalizedLink(data.topics).get(normalizeTopicLink(link));
  if (!topic) return; // this topic isn't a Missive (or hasn't been scraped yet)

  const h1 = document.querySelector("h1");
  if (!h1 || h1.querySelector("[data-aoo-status]")) return;

  const wrapper = document.createElement("span");
  wrapper.dataset.aooStatus = "1";
  wrapper.style.cssText = "float: right; display: inline-flex; gap: 8px; align-items: center; font-size: 14px;";

  wrapper.appendChild(buildBadge(topic.status));

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = topic.closed ? "Réouvrir" : "Clôturer";
  button.style.cssText = "padding: 4px 10px; cursor: pointer; border-radius: 4px; background: #fff; border: 1px solid #ccc; font-size: 13px;";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "…";
    try {
      await askBackground({
        type: "UPDATE_MISSIVE_STATUS",
        topicId: topic.id,
        closed: !topic.closed,
      });
      window.location.reload();
    } catch (err) {
      logger.error("Failed to update missive status:", err);
      button.textContent = originalLabel;
      button.disabled = false;
    }
  });
  wrapper.appendChild(button);

  h1.appendChild(wrapper);
}

async function initMissiveUi() {
  const url = window.location.href;
  if (url.includes("forum.php?forum=Missives")) {
    await injectMissivesListBadges();
  } else if (/\/forum\.php\?topic=\d+/.test(url)) {
    await injectMissiveTopicButton();
  }
}

// ============================================================
// Export du plateau (index.php) : l'image de la vue, noms des personnages compris
// ============================================================
// Le SVG de la vue est recopié avec toutes ses images intégrées (le
// navigateur ne charge pas les chemins relatifs d'un SVG rendu hors page),
// le nom de chaque personnage est écrit sous son avatar (lu sur sa fiche,
// infos.php, le plateau ne le porte pas), puis le tout est rendu en PNG.
const BOARD_EXPORT_BAR_ID = "aoo-board-export";
const BOARD_CARD_COLUMN = 270;
const boardSheetCache = new Map();

async function fetchAsDataUrl(href) {
  const res = await fetch(href, { credentials: "include" });
  if (!res.ok) throw new Error(`${href}: HTTP ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Nom et effets d'un personnage, lus sur sa fiche (infos.php). Le nom ne bouge pas, les effets si : seul le nom est gardé. */
async function boardCharacterSheet(targetId) {
  let name = boardSheetCache.get(targetId) ?? null;
  let effects = [];
  try {
    const doc = await fetchHtml(`${BASE_URL}infos.php?targetId=${targetId}`);
    name = doc.querySelector("#infos-player h1")?.innerText?.trim() || name;
    // Chaque effet est un lien vers le wiki, ancré sur son nom ; le texte
    // qui suit l'icône donne la valeur et, quand on y a droit, la durée.
    effects = Array.from(doc.querySelectorAll(".infos-effects a")).map((a) => ({
      name: (a.getAttribute("href") || "").split("#")[1] || "",
      detail: a.textContent.trim(),
    }));
  } catch (err) {
    logger.warn(`Fiche du personnage ${targetId} : ${err?.message || err}`);
  }
  boardSheetCache.set(targetId, name);
  return { name, effects };
}

/** La carte qu'ouvre un clic sur la case (observe.php) : type, portrait, vie restante en pourcentage. */
async function boardObserve(coords) {
  const res = await fetch(`${BASE_URL}observe.php`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `coords=${encodeURIComponent(coords)}`,
  });
  const doc = parser.parseFromString(await res.text(), "text/html");
  const card = doc.querySelector("#ui-card");
  if (!card) return null;
  // La vie est un voile rouge dont la hauteur (sur 225 px) couvre ce qui manque.
  const redFilter = doc.querySelector("#red-filter");
  const missing = redFilter ? parseInt((redFilter.getAttribute("style") || "").match(/height:\s*(\d+)px/)?.[1] || "0", 10) : 0;
  return {
    type: card.querySelector(".card-type")?.textContent?.trim() || "",
    race: (card.querySelector(".card-wrapper")?.className || "").replace("card-wrapper", "").trim(),
    portrait: card.querySelector(".card-portrait")?.getAttribute("src") || null,
    pvPct: Math.max(0, Math.min(100, Math.round(100 - (missing / 225) * 100))),
  };
}

// Le jeu ne livre pas les PV d'un mur, seulement un palier d'état
// (Str::get_status côté moteur) : on en garde la fourchette de vie restante.
// Un mur intact n'est pas marqué : sans étiquette, il est à 100 %.
const WALL_STATUS_TIERS = [
  ["en bon état", "75-99 %", "#3cb44b"],
  ["en mauvais état", "50-74 %", "#f58231"],
  ["en très mauvais état", "25-49 %", "#e6194b"],
  ["sur le point de s'effondrer", "< 25 %", "#e6194b"],
];

/** Vie restante d'un mur destructible (observe.php), ou null s'il est indestructible. */
async function boardWallStatus(coords) {
  const res = await fetch(`${BASE_URL}observe.php`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `coords=${encodeURIComponent(coords)}`,
  });
  const text = await res.text();
  // Les ressources (récoltable, épuisée) détournent le champ des dégâts.
  if (/resource-status/.test(text)) return null;
  const status = text.match(/Destructible \(([^)]+)\)/)?.[1];
  const tier = status && WALL_STATUS_TIERS.find(([label]) => label === status);
  return tier ? { label: tier[1], color: tier[2] } : null;
}

/** Appelle fn sur chaque élément, au plus `limit` à la fois (le plateau peut compter beaucoup de murs). */
async function mapLimited(items, limit, fn) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) await fn(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

function effectLabel(name) {
  const text = name.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Une carte de dragon dans la marge : portrait, nom, vie, effets. */
function boardDragonCard(dragon, x, y, width, height) {
  const g = document.createElementNS(SVG_NS, "g");
  const el = (tag, attrs, text) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text != null) node.textContent = text;
    g.appendChild(node);
    return node;
  };
  const pad = 8;
  el("rect", { x, y, width, height, rx: 8, fill: "#1f1a17", stroke: "#8a6d3b", "stroke-width": 2 });
  const portraitSize = Math.min(height - 2 * pad, 120);
  if (dragon.portraitData) {
    el("image", {
      href: dragon.portraitData,
      x: x + pad,
      y: y + pad,
      width: portraitSize,
      height: portraitSize,
      preserveAspectRatio: "xMidYMid slice",
    });
  }
  const textX = x + pad + portraitSize + pad;
  const textWidth = width - (textX - x) - pad;
  let cursor = y + pad + 20;
  el("text", { x: textX, y: cursor, style: "font: bold 20px sans-serif; fill: #fff;" }, dragon.name);
  cursor += 17;
  el("text", { x: textX, y: cursor, style: "font: 13px sans-serif; fill: #c9b79c;" }, dragon.type);
  cursor += 10;
  // Barre de vie : verte, puis orange, puis rouge à mesure qu'elle baisse.
  const barHeight = 16;
  const life = dragon.pvPct;
  const color = life > 60 ? "#3cb44b" : life > 30 ? "#f58231" : "#e6194b";
  el("rect", { x: textX, y: cursor, width: textWidth, height: barHeight, rx: 3, fill: "#3a3330" });
  el("rect", { x: textX, y: cursor, width: Math.round((textWidth * life) / 100), height: barHeight, rx: 3, fill: color });
  el("text", {
    x: textX + textWidth / 2,
    y: cursor + barHeight - 2,
    "text-anchor": "middle",
    style: "font: bold 12px sans-serif; fill: #fff; paint-order: stroke; stroke: #000; stroke-width: 2px;",
  }, `PV ${life} %`);
  cursor += barHeight + 8;
  // Effets, un par ligne, sous le portrait s'il le faut ; ce qui ne tient
  // pas est compté.
  const lineHeight = 16;
  const bottom = y + height - pad;
  const effects = dragon.effects;
  for (let i = 0; i < effects.length; i++) {
    const belowPortrait = cursor > y + pad + portraitSize + lineHeight;
    const lineX = belowPortrait ? x + pad : textX;
    if (cursor + 2 > bottom) {
      el("text", { x: lineX, y: bottom, style: "font: italic 13px sans-serif; fill: #c9b79c;" }, `+${effects.length - i} effet(s)`);
      break;
    }
    cursor += lineHeight;
    const e = effects[i];
    el("text", { x: lineX, y: cursor - 4, style: "font: 13px sans-serif; fill: #f2e9d8;" }, `${effectLabel(e.name)} ${e.detail}`.trim());
  }
  return g;
}

/** Le plateau en PNG (Blob), avec les noms ; sans les murs si withoutWalls. */
async function renderBoardPng({ withoutWalls = false } = {}) {
  const container = document.querySelector("#svg-container");
  const source = container?.querySelector("svg");
  if (!source) throw new Error("plateau introuvable");
  const meName = readPlayer()?.playerName || "Moi";

  const avatars = Array.from(source.querySelectorAll("[data-table='players']:not(.avatar-shadow)"));
  const byId = new Map();
  for (const avatar of avatars) {
    const id = (avatar.id.match(/^players(-?\d+)$/) || [])[1];
    if (id && !byId.has(id)) byId.set(id, avatar.getAttribute("data-coords"));
  }
  const names = new Map();
  const sheets = new Map();
  await Promise.all(
    Array.from(byId.keys()).map(async (id) => {
      const sheet = await boardCharacterSheet(id);
      names.set(id, sheet.name);
      sheets.set(id, sheet);
    })
  );
  // Les dragons (PNJ, carte de type « Dragon ») ont droit à leur carte dans
  // la marge : vie restante et effets, ce que le plateau ne montre pas.
  const dragons = [];
  await Promise.all(
    Array.from(byId.entries())
      .filter(([id]) => Number(id) < 0)
      .map(async ([id, coords]) => {
        try {
          const card = await boardObserve(coords);
          if (!card || card.race !== "dragon") return;
          let portraitData = null;
          if (card.portrait) {
            try {
              portraitData = await fetchAsDataUrl(card.portrait);
            } catch {
              portraitData = null;
            }
          }
          dragons.push({
            id,
            coords,
            name: names.get(id) || `#${id}`,
            type: card.type,
            pvPct: card.pvPct,
            portraitData,
            effects: sheets.get(id)?.effects || [],
          });
        } catch (err) {
          logger.warn(`Carte du PNJ ${id} : ${err?.message || err}`);
        }
      })
  );
  dragons.sort((a, b) => a.name.localeCompare(b.name, "fr"));

  // Vie restante des murs destructibles (les coffres, à 1 PV, n'en ont pas besoin).
  const wallCoords = withoutWalls ? [] : Array.from(
    new Set(
      Array.from(source.querySelectorAll("[data-table='walls'][data-coords]"))
        .filter((wall) => !/coffre/.test(getSvgHref(wall) || ""))
        .map((wall) => wall.getAttribute("data-coords"))
    )
  );
  const wallStatus = new Map();
  await mapLimited(wallCoords, 6, async (coords) => {
    try {
      const status = await boardWallStatus(coords);
      if (status) wallStatus.set(coords, status);
    } catch (err) {
      logger.warn(`Mur ${coords} : ${err?.message || err}`);
    }
  });

  const clone = source.cloneNode(true);
  if (withoutWalls) for (const wall of clone.querySelectorAll("[data-table='walls']")) wall.remove();
  const images = Array.from(clone.querySelectorAll("image"));
  const hrefs = Array.from(new Set(images.map(getSvgHref).filter(Boolean)));
  const inline = new Map();
  await Promise.all(
    hrefs.map(async (href) => {
      try {
        inline.set(href, await fetchAsDataUrl(href));
      } catch (err) {
        logger.warn(`Image du plateau non intégrée : ${err?.message || err}`);
      }
    })
  );
  for (const image of images) {
    const data = inline.get(getSvgHref(image));
    if (!data) continue;
    image.setAttribute("href", data);
    image.removeAttribute("xlink:href");
  }

  const labels = document.createElementNS(SVG_NS, "g");
  for (const avatar of clone.querySelectorAll("[data-table='players']:not(.avatar-shadow)")) {
    const id = (avatar.id.match(/^players(-?\d+)$/) || [])[1];
    const name = id ? names.get(id) : avatar.id === "current-player-avatar" ? meName : null;
    if (!name) continue;
    const size = parseInt(avatar.getAttribute("width") || "50", 10);
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(parseInt(avatar.getAttribute("x") || "0", 10) + size / 2));
    text.setAttribute("y", String(parseInt(avatar.getAttribute("y") || "0", 10) + size + 16));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute(
      "style",
      `font: bold 15px sans-serif; fill: ${id ? "#fff" : "#ffe66d"}; ` +
        "paint-order: stroke; stroke: #000; stroke-width: 3px; stroke-linejoin: round;"
    );
    text.textContent = name;
    labels.appendChild(text);
  }
  // Vie des murs : une pastille en bas de la case.
  for (const wall of clone.querySelectorAll("[data-table='walls'][data-coords]")) {
    const status = wallStatus.get(wall.getAttribute("data-coords"));
    if (!status) continue;
    const size = parseInt(wall.getAttribute("width") || "50", 10);
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(parseInt(wall.getAttribute("x") || "0", 10) + size / 2));
    text.setAttribute("y", String(parseInt(wall.getAttribute("y") || "0", 10) + size - 4));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute(
      "style",
      `font: bold 11px sans-serif; fill: ${status.color}; ` +
        "paint-order: stroke; stroke: #000; stroke-width: 3px; stroke-linejoin: round;"
    );
    text.textContent = status.label;
    labels.appendChild(text);
  }
  clone.appendChild(labels);

  const [, , width, height] = (source.getAttribute("viewBox") || "0 0 1350 1350").split(/\s+/).map(Number);
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.removeAttribute("style");

  // Le fond (ciel, roche…) est une image CSS du conteneur ou du SVG.
  const bgStyle = `${container.getAttribute("style") || ""} ${source.getAttribute("style") || ""}`;
  const bgMatch = bgStyle.match(/url\(['"]?([^'")]+)['"]?\)/);
  if (bgMatch) {
    try {
      const background = document.createElementNS(SVG_NS, "image");
      background.setAttribute("href", await fetchAsDataUrl(bgMatch[1]));
      background.setAttribute("width", String(width));
      background.setAttribute("height", String(height));
      background.setAttribute("preserveAspectRatio", "none");
      clone.insertBefore(background, clone.firstChild);
    } catch (err) {
      logger.warn(`Fond du plateau non intégré : ${err?.message || err}`);
    }
  }

  // Avec des dragons, le plateau se met au centre d'une image plus large :
  // leurs cartes se répartissent entre la marge gauche et la marge droite.
  let output = clone;
  let outputWidth = width;
  if (dragons.length > 0) {
    const column = BOARD_CARD_COLUMN;
    outputWidth = width + 2 * column;
    output = document.createElementNS(SVG_NS, "svg");
    output.setAttribute("xmlns", SVG_NS);
    output.setAttribute("width", String(outputWidth));
    output.setAttribute("height", String(height));
    const margins = document.createElementNS(SVG_NS, "rect");
    margins.setAttribute("width", String(outputWidth));
    margins.setAttribute("height", String(height));
    margins.setAttribute("fill", "#3a2f26");
    output.appendChild(margins);
    clone.setAttribute("x", String(column));
    output.appendChild(clone);
    const perColumn = Math.ceil(dragons.length / 2);
    const gap = 10;
    const cardHeight = Math.max(100, Math.min(260, Math.floor((height - gap * (perColumn + 1)) / perColumn)));
    dragons.forEach((dragon, index) => {
      const left = index < perColumn;
      const row = left ? index : index - perColumn;
      const x = left ? gap : column + width + gap;
      const y = gap + row * (cardHeight + gap);
      output.appendChild(boardDragonCard(dragon, x, y, column - 2 * gap, cardHeight));
    });
  }

  const svgUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(output)], { type: "image/svg+xml;charset=utf-8" })
  );
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("le SVG du plateau ne se charge pas"));
      image.src = svgUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, outputWidth, height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function injectBoardExportBar() {
  const container = document.querySelector("#svg-container");
  if (!container?.querySelector("svg") || document.getElementById(BOARD_EXPORT_BAR_ID)) return;
  const bar = document.createElement("div");
  bar.id = BOARD_EXPORT_BAR_ID;
  bar.style.cssText = "display: flex; gap: 6px; justify-content: flex-end; margin: 4px 0;";
  const buttonStyle = "padding: 2px 8px; font-size: 12px; cursor: pointer;";

  const makeButton = (label, title, action, options) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.style.cssText = buttonStyle;
    button.addEventListener("click", async () => {
      const previous = button.textContent;
      button.disabled = true;
      button.textContent = "…";
      try {
        await action(await renderBoardPng(options));
      } catch (err) {
        logger.error(`Export du plateau : ${err?.message || err}`);
        button.textContent = "Échec";
        setTimeout(() => (button.textContent = previous), 2000);
        return;
      } finally {
        button.disabled = false;
      }
      button.textContent = previous;
    });
    return button;
  };

  const stamp = () => new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "h");
  const openInTab = (png) => {
    const url = URL.createObjectURL(png);
    // Ouvert depuis un clic : le navigateur l'autorise. L'URL reste valide
    // tant que cette page vit, l'onglet ouvert la garde chargée.
    if (!window.open(url, "_blank")) throw new Error("fenêtre bloquée par le navigateur");
  };
  bar.append(
    makeButton("Exporter le plateau", "Ouvre l'image du plateau, noms et état des murs compris, dans un nouvel onglet", openInTab),
    makeButton("Sans les murs", "Ouvre l'image du plateau sans les murs, dans un nouvel onglet", openInTab, { withoutWalls: true }),
    makeButton("⤓", "Télécharger l'image du plateau (PNG)", (png) => {
      const url = URL.createObjectURL(png);
      const link = document.createElement("a");
      link.href = url;
      link.download = `plateau-${stamp()}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
  );
  container.parentNode.insertBefore(bar, container);
}

// ============================================================
// Repères sur la carte du monde (map.php?world)
// ============================================================
// Le jeu ne pose sur la carte du monde que les lieux « visibles par défaut ».
// On y ajoute les autres (pyramide, volcan, mines, tourbière…) avec la même
// petite croix, à l'entrée réelle du lieu (celle des téléporteurs) telle que
// le tracker la connaît ; ceux que le jeu affiche déjà ne sont pas redessinés.
// Même projection que le moteur : image 700×466 posée en (60,33), marge 20,
// bornes visibles du plan.
const WORLD_LAYER_ID = "aoo-world-markers";
const WORLD_TOGGLE_ID = "aoo-world-markers-toggle";
const WORLD_STORAGE_KEY = "aoo-world-markers";
const WORLD_MODES = ["oui", "non"];
const WORLD_IMAGE = { x: 60, y: 33, width: 700, height: 466, margin: 20 };
const SVG_NS = "http://www.w3.org/2000/svg";

function isWorldMapPage() {
  const url = new URL(window.location.href);
  return /\/map\.php$/.test(url.pathname) && !url.searchParams.has("local") && !!document.querySelector("#svg-map");
}

function worldMarkersMode() {
  try {
    const stored = localStorage.getItem(WORLD_STORAGE_KEY);
    return WORLD_MODES.includes(stored) ? stored : WORLD_MODES[0];
  } catch {
    return WORLD_MODES[0];
  }
}

function svgEl(tag, attrs = {}, text = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text != null) el.textContent = text;
  return el;
}

function worldToPixel(x, y, bounds) {
  const scaleX = (WORLD_IMAGE.width - 2 * WORLD_IMAGE.margin) / (bounds.maxX - bounds.minX);
  const scaleY = (WORLD_IMAGE.height - 2 * WORLD_IMAGE.margin) / (bounds.maxY - bounds.minY);
  return {
    px: WORLD_IMAGE.x + Math.floor(WORLD_IMAGE.margin + (x - bounds.minX) * scaleX),
    py: WORLD_IMAGE.y + Math.floor(WORLD_IMAGE.height - (WORLD_IMAGE.margin + (y - bounds.minY) * scaleY)),
  };
}

async function renderWorldMarkers() {
  document.getElementById(WORLD_LAYER_ID)?.remove();
  const mode = worldMarkersMode();
  if (mode === "non") return;
  const svg = document.querySelector("#svg-map");
  if (!svg) return;

  let data;
  try {
    data = await askBackground({ type: "WORLD_MARKERS" });
  } catch (err) {
    logger.warn(`Repères du monde : ${err?.message || err}`);
    return;
  }
  const all = data?.markers || [];
  const markers = all.filter((m) => !m.visibleByDefault);
  if (markers.length === 0 || !data?.bounds) return;

  const layer = svgEl("g", { id: WORLD_LAYER_ID, style: "pointer-events: none;" });
  const size = 4;
  const fontSize = 10;
  const textStyle =
    `font-family: sans-serif; font-size: ${fontSize}px; font-weight: bold; fill: #fff; ` +
    "paint-order: stroke; stroke: #000; stroke-width: 2.5px; stroke-linejoin: round;";
  // Étiquettes posées, pour que deux lieux voisins ne s'écrivent pas l'un sur
  // l'autre : de haut en bas, chacune prend la première place libre parmi
  // au-dessus de la croix, en dessous, puis un cran plus loin.
  const placed = [];
  const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  // Le jeu écrit le nom de ses propres lieux sous leur croix (police bitmap
  // de 7 px par lettre, 13 px de haut) : on réserve la place pour ne pas
  // écrire dessus.
  for (const m of all) {
    if (!m.visibleByDefault) continue;
    const { px, py } = worldToPixel(m.x, m.y, data.bounds);
    const gameWidth = m.label.length * 7;
    placed.push({ x1: px - gameWidth / 2, x2: px + gameWidth / 2, y1: py - size, y2: py + size + 15 });
  }
  const sorted = markers
    .map((m) => ({ marker: m, ...worldToPixel(m.x, m.y, data.bounds) }))
    .sort((a, b) => a.py - b.py || a.px - b.px);
  for (const { marker, px, py } of sorted) {
    const color = "#ff4040";
    layer.appendChild(svgEl("rect", { x: px - 1, y: py - size, width: 3, height: 2 * size + 1, fill: color, stroke: "#000", "stroke-width": 0.5 }));
    layer.appendChild(svgEl("rect", { x: px - size, y: py - 1, width: 2 * size + 1, height: 3, fill: color, stroke: "#000", "stroke-width": 0.5 }));

    const width = marker.label.length * fontSize * 0.58 + 4;
    const candidates = [
      py - size - 3,
      py + size + fontSize + 1,
      py - size - 3 - fontSize - 2,
      py + size + 2 * fontSize + 3,
    ];
    let baseline = candidates[0];
    for (const candidate of candidates) {
      const box = { x1: px - width / 2, x2: px + width / 2, y1: candidate - fontSize, y2: candidate + 2 };
      if (!placed.some((other) => overlaps(box, other))) {
        baseline = candidate;
        break;
      }
    }
    placed.push({ x1: px - width / 2, x2: px + width / 2, y1: baseline - fontSize, y2: baseline + 2 });
    const title = svgEl("text", { x: px, y: baseline, "text-anchor": "middle", style: textStyle }, marker.label);
    title.appendChild(svgEl("title", {}, `${marker.label} (${marker.x},${marker.y})`));
    layer.appendChild(title);
  }
  svg.appendChild(layer);
  logger.info(`Repères du monde : ${markers.length} lieu(x) (${mode})`);
}

function injectWorldMarkersToggle() {
  if (document.getElementById(WORLD_TOGGLE_ID)) return;
  const host = document.querySelector(".layer-controls") || document.querySelector("#ui-map")?.parentElement;
  if (!host) return;
  const button = document.createElement("button");
  button.id = WORLD_TOGGLE_ID;
  button.type = "button";
  button.style.cssText = "margin-left: 12px; padding: 2px 8px; font-size: 12px; cursor: pointer;";
  const render = () => {
    button.textContent = `Repères tracker : ${worldMarkersMode()}`;
  };
  button.addEventListener("click", () => {
    const next = WORLD_MODES[(WORLD_MODES.indexOf(worldMarkersMode()) + 1) % WORLD_MODES.length];
    try {
      localStorage.setItem(WORLD_STORAGE_KEY, next);
    } catch {
      // sans stockage, le bouton n'a pas de mémoire, c'est tout
    }
    render();
    renderWorldMarkers();
  });
  render();
  host.appendChild(button);
}

function initWorldMarkers() {
  if (!isWorldMapPage() || window.__aooWorldMarkersInstalled) return;
  window.__aooWorldMarkersInstalled = true;
  injectWorldMarkersToggle();
  renderWorldMarkers().catch((err) => logger.warn(`Repères du monde : ${err?.message || err}`));
}

// ============================================================
// Arpentage automatique (moteur local)
// ============================================================
// Faire marcher l'arpenteuse toute seule pour compléter la carte du tracker.
// Le tracker tient la carte, donc c'est lui qui dit où aller (EXPLORE_NEXT) ;
// ici on ne fait que les pas : lire les mouvements restants, relever la vue,
// avancer d'une case via go.php, et quand il n'y a plus de mouvements,
// demander un nouveau tour (EXPLORE_NEW_TURN). Rien ne recharge la page :
// tout passe par des requêtes, et la boucle vit tant que l'onglet reste ouvert.
const EXPLORER_PANEL_ID = "aoo-explorer-panel";
const EXPLORER_PAUSE_MS = 400;
// Itérations de suite sans un seul pas accepté avant de déclarer forfait :
// quelque chose coince, mieux vaut s'arrêter que tourner à vide.
const EXPLORER_MAX_STALL = 30;

const explorer = {
  running: false,
  playerName: null,
  // Ce qu'on sait de chaque plan (clé « plan|z ») : cases infranchissables
  // apprises en route, case d'arrivée, plan d'où l'on y est entré, passages
  // rencontrés (case de départ → plan d'arrivée), et s'il est fini.
  plans: new Map(),
  // Mode sortie : on retourne près de la case d'arrivée et on essaie ses
  // voisines une à une jusqu'à ce qu'un pas change de lieu.
  exit: null,
  // Passage visé (goal) : sa case est exclue des cases contournées le temps
  // d'y aller.
  goal: null,
  lastPlace: null,
  lastStep: null,
  stats: { steps: 0, turns: 0, blocked: 0, synced: 0 },
  ui: null,
};

function explorerPlaceKey(plan, z) {
  return `${plan}|${z}`;
}

function explorerPlan(key) {
  if (!explorer.plans.has(key)) {
    explorer.plans.set(key, {
      key,
      blocked: new Set(),
      arrival: null,
      parentKey: null,
      // Passages par destination (clé « plan|z ») : leurs cases, et si la
      // zone derrière a déjà été visitée depuis ce plan.
      exits: new Map(),
      portalsLoaded: false,
      done: false,
      // Entré par mégarde alors que le plan d'origine n'était pas fini : on
      // ressort avant toute chose, on y reviendra en son temps.
      pending: false,
    });
  }
  return explorer.plans.get(key);
}

function explorerExit(plan, toKey) {
  if (!plan.exits.has(toKey)) plan.exits.set(toKey, { toKey, cells: [], visited: false });
  return plan.exits.get(toKey);
}

/** Note une case de passage sur un plan, et l'évite tant qu'on ne la vise pas. */
function explorerAddPortal(plan, x, y, toKey) {
  const exit = explorerExit(plan, toKey);
  if (!exit.cells.some((c) => c.x === x && c.y === y)) exit.cells.push({ x, y });
  plan.blocked.add(`${x},${y}`);
  return exit;
}

/** Les passages du plan, lus une fois dans la base du moteur local. */
async function explorerLoadPortals(plan, place) {
  if (plan.portalsLoaded) return;
  plan.portalsLoaded = true;
  const data = await askBackground({
    type: "EXPLORE_PORTALS",
    playerName: explorer.playerName,
    plan: place.plan,
    z: place.z,
  });
  for (const portal of data.portals || []) {
    explorerAddPortal(plan, portal.x, portal.y, explorerPlaceKey(portal.to.plan, portal.to.z));
  }
  const destinations = Array.from(plan.exits.keys());
  explorerLog(
    `${place.plan} z${place.z} : ${(data.portals || []).length} case(s) de passage` +
      (destinations.length ? ` vers ${destinations.join(", ")}` : "")
  );
}

/** Les cases à essayer autour d'une arrivée, de la plus proche à la plus loin, l'arrivée elle-même en second. */
function explorerExitCandidates(arrival) {
  const ring = (r) => {
    const cells = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) cells.push({ x: arrival.x + dx, y: arrival.y + dy });
      }
    }
    return cells;
  };
  const first = ring(1);
  return [first[0], { x: arrival.x, y: arrival.y }, ...first.slice(1), ...ring(2)];
}


function explorerLog(message, level = "info") {
  logger[level === "error" ? "error" : "info"](`Arpentage : ${message}`);
  const list = explorer.ui?.log;
  if (!list) return;
  const line = document.createElement("li");
  line.textContent = `${new Date().toLocaleTimeString("fr-FR")} ${message}`;
  if (level === "error") line.style.color = "#c62828";
  list.prepend(line);
  while (list.children.length > 12) list.removeChild(list.lastChild);
}

function explorerRender() {
  const ui = explorer.ui;
  if (!ui) return;
  const { steps, turns, blocked, synced } = explorer.stats;
  ui.start.disabled = explorer.running;
  ui.stop.disabled = !explorer.running;
  ui.status.textContent = explorer.running ? "En marche" : "À l'arrêt";
  ui.stats.textContent = `${steps} pas · ${turns} tour(s) renouvelé(s) · ${synced} relevé(s) · ${blocked} case(s) contournée(s)`;
}

/** Mouvements restants et perception, lus sur le panneau de caracs du jeu. */
async function explorerReadCaracs() {
  const doc = await fetchHtml(`${BASE_URL}load_caracs.php`);
  const table = doc.querySelector("#caracs-menu");
  if (!table) throw new Error("panneau de caractéristiques introuvable");
  const headers = Array.from(table.querySelectorAll("tr:first-child th")).map((th) => th.textContent.trim());
  const cells = Array.from(table.querySelectorAll("tr:nth-child(2) td")).map((td) => td.textContent.trim());
  // "3/6" = il en reste 3 sur 6 ; "6" tout court = rien d'entamé ce tour.
  const current = (label) => {
    const raw = cells[headers.indexOf(label)] || "";
    const value = parseInt(raw.split("/")[0], 10);
    if (Number.isNaN(value)) throw new Error(`caractéristique ${label} illisible (« ${raw} »)`);
    return value;
  };
  return { mvt: current("Mvt"), p: current("P") };
}

/** Un pas via go.php. Vide = accepté ; sinon le jeu explique, sous forme d'alert(). */
async function explorerMove(step) {
  const res = await fetch(`${BASE_URL}go.php`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `coords=${encodeURIComponent(`${step.x},${step.y}`)}`,
  });
  const text = (await res.text()).trim();
  if (!text) return { ok: true, message: null };
  const alertMatch = text.match(/alert\((["'])([\s\S]*?)\1\)/);
  const message = alertMatch ? alertMatch[2].replace(/\\'/g, "'") : stripHtml(text).slice(0, 160);
  return { ok: false, noMvt: /Pas assez de Mouvements/i.test(message), message };
}

async function explorerNewTurn() {
  await askBackground({ type: "EXPLORE_NEW_TURN", playerName: explorer.playerName });
  // C'est index.php qui rend le « Nouveau Tour » quand l'heure est passée.
  await fetch(`${BASE_URL}index.php`, { credentials: "include" });
  const caracs = await explorerReadCaracs();
  if (caracs.mvt < 1) throw new Error("le nouveau tour n'a pas rendu de mouvements");
  explorer.stats.turns++;
  return caracs;
}

async function explorerSurvey() {
  // Le moteur garde la vue en cache par joueur : la jeter avant de relever,
  // sinon juste après un changement de lieu le décor est encore l'ancien.
  await fetch(`${BASE_URL}refresh_view.php`, { credentials: "include" });
  const sync = await askBackground({ type: "LOCAL_MAP_SYNC", playerName: explorer.playerName });
  if (!sync?.ok) throw new Error(sync?.skipped || "le relevé n'est pas passé");
  if (!sync.plan || !sync.playerCoords) throw new Error("relevé sans plan ou sans position");
  explorer.stats.synced++;
  return { plan: sync.plan, z: sync.z ?? 0, x: sync.playerCoords.x, y: sync.playerCoords.y };
}

async function explorerLoop() {
  let stall = 0;
  while (explorer.running) {
    await new Promise((resolve) => setTimeout(resolve, EXPLORER_PAUSE_MS));
    if (stall >= EXPLORER_MAX_STALL) {
      throw new Error(`${EXPLORER_MAX_STALL} tours de boucle sans un pas : quelque chose coince ici`);
    }
    stall++;
    let caracs = await explorerReadCaracs();
    if (caracs.mvt < 1) {
      explorerLog("plus de mouvements : nouveau tour");
      caracs = await explorerNewTurn();
    }

    const place = await explorerSurvey();
    const here = explorerPlan(explorerPlaceKey(place.plan, place.z));
    const last = explorer.lastPlace;
    if (last && (last.plan !== place.plan || last.z !== place.z)) {
      const from = explorerPlan(explorerPlaceKey(last.plan, last.z));
      explorerLog(`changement de lieu : ${last.plan} z${last.z} → ${place.plan} z${place.z}`);
      // Le pas qui a changé de lieu est un passage : on le note, et on ne le
      // reprend pas par hasard (sinon aller-retour sans fin).
      if (explorer.lastStep) {
        const exit = explorerAddPortal(from, explorer.lastStep.x, explorer.lastStep.y, here.key);
        // Retour vers le plan d'origine, ou passage pris exprès : rien à revisiter.
        // (Le nom du plan résolu par le tracker peut différer de celui que
        // porte le téléporteur : le passage visé est marqué quoi qu'il en soit.)
        if (here.key === from.parentKey) exit.visited = true;
        if (explorer.goal) {
          explorer.goal.visited = true;
          exit.visited = true;
        }
      }
      if (!here.arrival) here.arrival = { x: place.x, y: place.y };
      if (!here.parentKey && here.key !== from.parentKey) here.parentKey = from.key;
      // On finit le plan où l'on était avant d'entrer dans ses zones : entré
      // par mégarde, on ressort tout de suite.
      here.pending = !from.done && here.key !== from.parentKey;
      if (here.pending) explorerLog(`${place.plan} : zone notée, on y reviendra une fois ${last.plan} fini`);
      explorer.exit = null;
      explorer.goal = null;
    }
    explorer.lastPlace = place;
    await explorerLoadPortals(here, place);

    const ask = (goal) => {
      const goals = goal ? (Array.isArray(goal) ? goal : [goal]) : [];
      const blocked = Array.from(here.blocked, (k) => {
        const [x, y] = k.split(",").map(Number);
        return { x, y };
      }).filter((b) => !goals.some((g) => g.x === b.x && g.y === b.y));
      return askBackground({
        type: "EXPLORE_NEXT",
        playerName: explorer.playerName,
        plan: place.plan,
        z: place.z,
        x: place.x,
        y: place.y,
        radius: caracs.p,
        blocked,
        goal,
      });
    };

    // Où aller : découvrir, ou bien rejoindre un passage (vers une zone à
    // visiter, ou vers le plan d'origine), ou bien chercher une sortie.
    let next = null;
    if (!here.pending && !explorer.exit && !explorer.goal) {
      next = await ask(undefined);
      if (next.done) {
        if (!here.done) explorerLog(`${place.plan} z${place.z} : plus rien à découvrir (${next.known} cases connues)`);
        here.done = true;
        next = null;
        const zone = Array.from(here.exits.values()).find(
          (e) => !e.visited && e.toKey !== here.parentKey && e.cells.length > 0
        );
        if (zone) {
          explorerLog(`zone suivante : ${zone.toKey} (${zone.cells.length} case(s) de passage)`);
          explorer.goal = zone;
        } else if (!here.parentKey && (here.arrival || here.exits.size > 0)) {
          explorerLog("tout ce qui était accessible est arpenté");
          explorer.running = false;
          break;
        } else if (!here.parentKey) {
          // Plan de départ fini sans qu'aucun passage n'ait été croisé : on
          // a sans doute été lancé dans une zone déjà connue. On cherche une
          // sortie autour d'ici, une fois.
          here.arrival = { x: place.x, y: place.y };
        }
      }
    }
    if (!next && !explorer.goal && (here.pending || here.done)) {
      // Repartir vers le plan d'origine : par le passage de retour s'il est
      // connu, sinon en cherchant autour de l'arrivée.
      const back = here.parentKey ? here.exits.get(here.parentKey) : null;
      if (back && back.cells.length > 0 && !back.dead) {
        explorerLog(`retour vers ${here.parentKey}`);
        explorer.goal = back;
      } else if (!explorer.exit) {
        const arrival = here.arrival || { x: place.x, y: place.y };
        explorerLog(`recherche d'une sortie autour de ${arrival.x},${arrival.y}`);
        explorer.exit = { candidates: explorerExitCandidates(arrival), goal: null };
      }
    }
    if (!next && explorer.goal) {
      const towards = await ask(explorer.goal.cells);
      if (towards.done) {
        // Sur le passage sans avoir changé de lieu, ou passage hors d'atteinte
        // même en forçant : on n'insiste pas.
        explorerLog(`passage vers ${explorer.goal.toKey} : ${towards.reason === "at-goal" ? "ne mène nulle part" : "hors d'atteinte"}`);
        explorer.goal.visited = true;
        explorer.goal.dead = true;
        explorer.goal = null;
        continue;
      }
      if (towards.relaxed && !explorer.goal.relaxedLogged) {
        explorer.goal.relaxedLogged = true;
        explorerLog(`passage vers ${explorer.goal.toKey} : pas de chemin sûr, on force à travers ce que la carte croit fermé`);
      }
      next = towards;
    }
    if (!next && explorer.exit) {
      // Chaque candidate se tente en y allant ; y être sans avoir changé de
      // lieu, c'est l'avoir écartée.
      const exit = explorer.exit;
      while (!next) {
        if (!exit.goal) {
          exit.goal = exit.candidates.shift() || null;
          if (!exit.goal) {
            explorerLog(`${place.plan} z${place.z} : aucune sortie trouvée autour de l'arrivée`, "error");
            explorer.running = false;
            break;
          }
        }
        const towards = await ask(exit.goal);
        if (towards.done) {
          if (towards.reason === "at-goal") explorerLog(`sortie : ${exit.goal.x},${exit.goal.y} n'est pas un passage`);
          else explorerLog(`sortie : ${exit.goal.x},${exit.goal.y} hors d'atteinte`);
          exit.goal = null;
          continue;
        }
        next = towards;
      }
      if (!explorer.running) break;
    }
    if (!next) continue;

    explorer.lastStep = next.step;
    const move = await explorerMove(next.step);
    if (move.ok) {
      stall = 0;
      explorer.stats.steps++;
      const why = explorer.goal ? "vers un passage" : explorer.exit ? "vers la sortie" : `${next.reveals} cases à voir`;
      explorerLog(
        `pas en ${next.step.x},${next.step.y} (cap ${next.target.x},${next.target.y}, ` +
          `${next.distance} pas, ${why}, ${caracs.mvt - 1} mvt)`
      );
    } else if (move.noMvt) {
      explorerLog("le jeu refuse le pas : plus de mouvements");
    } else {
      // Le jeu a refusé ; si la position a quand même changé (déclencheur
      // bavard), c'est un pas comme un autre, sinon la case est à contourner.
      const after = await fetchPlayerLocation();
      const moved = after && (after.x !== place.x || after.y !== place.y);
      if (moved) {
        stall = 0;
        explorer.stats.steps++;
        explorerLog(`pas en ${after.x},${after.y}, le jeu dit : « ${move.message} »`);
      } else {
        // Une case de plus écartée : c'est un progrès, pas de l'immobilité.
        stall = 0;
        const cell = `${next.step.x},${next.step.y}`;
        here.blocked.add(cell);
        explorer.stats.blocked++;
        explorerLog(`case ${cell} contournée : « ${move.message} »`);
        if (explorer.goal) {
          explorer.goal.cells = explorer.goal.cells.filter((c) => `${c.x},${c.y}` !== cell);
          if (explorer.goal.cells.length === 0) {
            explorer.goal.visited = true;
            explorer.goal = null;
          }
        }
        if (explorer.exit?.goal && `${explorer.exit.goal.x},${explorer.exit.goal.y}` === cell) {
          explorer.exit.goal = null;
        }
      }
    }
    explorerRender();
  }
}

async function explorerStart() {
  if (explorer.running) return;
  const player = readPlayer();
  if (!player) return;
  explorer.playerName = player.playerName;
  explorer.running = true;
  explorer.lastPlace = null;
  explorer.lastStep = null;
  explorer.exit = null;
  explorer.goal = null;
  explorerRender();
  explorerLog(`départ, ${player.playerName} arpente`);
  try {
    await explorerLoop();
  } catch (err) {
    explorerLog(`arrêt : ${err?.message || err}`, "error");
  } finally {
    explorer.running = false;
    explorerRender();
  }
}

function explorerStop() {
  if (!explorer.running) return;
  explorer.running = false;
  explorerLog("arrêt demandé, le pas en cours se termine");
  explorerRender();
}

function injectExplorerPanel() {
  if (document.getElementById(EXPLORER_PANEL_ID)) return;
  if (!document.querySelector("#svg-container")) return;

  const panel = document.createElement("section");
  panel.id = EXPLORER_PANEL_ID;
  panel.className = "marbre";
  panel.style.cssText =
    "margin: 12px auto 0; padding: 10px 14px; max-width: 800px; box-sizing: border-box; text-align: left; font-size: 13px;";

  const title = document.createElement("div");
  title.style.cssText = "display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;";
  const heading = document.createElement("strong");
  heading.textContent = "Arpentage automatique";
  const status = document.createElement("span");
  status.style.opacity = "0.8";
  const start = document.createElement("button");
  start.type = "button";
  start.textContent = "▶ Arpenter";
  start.addEventListener("click", () => explorerStart());
  const stop = document.createElement("button");
  stop.type = "button";
  stop.textContent = "■ Arrêter";
  stop.addEventListener("click", () => explorerStop());
  title.append(heading, status, start, stop);

  const help = document.createElement("p");
  help.style.cssText = "margin: 6px 0; opacity: 0.8;";
  help.textContent =
    "Le tracker choisit la case la plus proche d'où la vue révélera de l'inconnu, " +
    "le personnage y va pas à pas, et son tour est renouvelé dès qu'il n'a plus de mouvements. " +
    "Laisser l'onglet ouvert.";

  const stats = document.createElement("div");
  stats.style.cssText = "margin: 4px 0; font-variant-numeric: tabular-nums;";

  const log = document.createElement("ul");
  log.style.cssText = "margin: 6px 0 0; padding-left: 18px; max-height: 180px; overflow-y: auto; font-family: monospace; font-size: 12px;";

  panel.append(title, help, stats, log);

  const anchor = document.querySelector("#view") || document.querySelector("#svg-container");
  if (anchor?.parentNode) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else document.body.appendChild(panel);

  explorer.ui = { status, start, stop, stats, log };
  explorerRender();
}

// ============================================================
// Init
// ============================================================
function isIndexPage() {
  const url = window.location.href;
  return /\/index\.php(\?|$|#)/.test(url) || /\/$/.test(new URL(url).pathname);
}

// Auto fetch-map on movement. AOM does a full page reload on each move, so
// landing on index.php is itself the "the player just moved" signal — fire
// FETCH_MAP once. The MutationObserver is a belt-and-suspenders safety net
// in case the SVG ever updates in place.
function snapshotPlayers() {
  return Array.from(
    document.querySelectorAll("#svg-container [data-table='players']")
  )
    .map((el) => `${el.id}:${el.getAttribute("x")},${el.getAttribute("y")}`)
    .sort()
    .join("|");
}

// Sur le moteur local, la carte part par un message à part : le personnage y
// est lu sur la page même, faute de pouvoir se fier à la persona du vrai jeu
// mémorisée par le background.
function mapSyncMessage() {
  if (!IS_LOCAL_ENGINE) return { type: "FETCH_MAP" };
  return { type: "LOCAL_MAP_SYNC", playerName: readPlayer()?.playerName || null };
}

async function triggerAutoFetch(reason) {
  try {
    await askBackground(mapSyncMessage());
    logger.info(`Auto fetch-map: ${reason}`);
  } catch (err) {
    logger.warn(`Auto fetch-map (${reason}) failed: ${err?.message || err}`);
  }
}

function setupAutoFetchOnMove() {
  if (window.__aooAutoFetchInstalled) return;
  window.__aooAutoFetchInstalled = true;

  // Page-load map fetch is covered by the global auto-sync (see setupAutoSync);
  // here we only watch for in-page movement so the map updates instantly.
  const target = document.querySelector("#svg-container");
  if (!target) return;
  let lastSnapshot = snapshotPlayers();
  let pending = null;
  new MutationObserver(() => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      const next = snapshotPlayers();
      if (next === lastSnapshot) return;
      lastSnapshot = next;
      triggerAutoFetch("position change");
    }, 600);
  }).observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["x", "y"],
  });
}

async function initIndexUi() {
  if (!isIndexPage()) return;
  setupAutoFetchOnMove();
  if (readPlayer()) injectBoardExportBar();
}

// Push everything to the tracker automatically — no popup buttons needed.
// Runs once per page load (when logged in). The background throttles each
// data type, so frequent reloads (the game reloads on every move) stay cheap.
function setupAutoSync() {
  if (window.__aooAutoSyncDone) return;
  if (!readPlayer()) return;
  window.__aooAutoSyncDone = true;

  // Small delay so the LOGIN_STATUS message lands first (background needs the
  // playerId before map/attributes can be tagged).
  setTimeout(() => {
    askBackground({ type: "AUTO_SYNC", url: window.location.href })
      .then((res) => {
        logger.info("Auto-sync:", res?.ran?.length ? res.ran.join(", ") : "nothing due");
      })
      .catch((err) => logger.warn(`Auto-sync failed: ${err?.message || err}`));
  }, 1500);
}

// Moteur local : une remontée de carte par chargement de page (le jeu recharge
// à chaque déplacement), l'observateur de mouvement couvrant le reste.
function setupLocalMapSync() {
  if (window.__aooLocalMapSyncDone) return;
  if (!readPlayer()) return;
  window.__aooLocalMapSyncDone = true;
  triggerAutoFetch("moteur local, chargement de page");
}

// ============================================================
// VPN gate
// ============================================================
// Sur le vrai jeu, le bouton Login ne part que si Mullvad confirme que la
// connexion sort par lui. Le jeu envoie le formulaire en AJAX depuis le clic
// sur le bouton (la touche Entrée simule ce clic) : on intercepte ce clic en
// phase de capture, avant le gestionnaire du jeu, puis on le rejoue une fois
// le VPN confirmé.
const LOGIN_BUTTON_SELECTOR = '#login [action="submit"]';

function showVpnNotice(text, state) {
  const form = document.querySelector("#login");
  if (!form) return;
  let box = document.querySelector("#aoo-vpn-notice");
  if (!box) {
    box = document.createElement("div");
    box.id = "aoo-vpn-notice";
    box.style.cssText =
      "margin:8px auto;padding:6px 10px;border-radius:6px;font-weight:600;text-align:center;max-width:320px;";
    form.after(box);
  }
  const colors = { pending: ["#fff4cc", "#6b5300"], ok: ["#dff5e1", "#1d5e2a"], refused: ["#fde2e1", "#8a1c17"] };
  const [bg, fg] = colors[state] || colors.pending;
  box.style.background = bg;
  box.style.color = fg;
  box.textContent = text;
}

function installVpnGate() {
  if (IS_LOCAL_ENGINE || window.__aooVpnGate) return;
  window.__aooVpnGate = true;
  let allowNextClick = false;
  let checking = false;

  document.addEventListener(
    "click",
    async (event) => {
      const button = event.target?.closest?.(LOGIN_BUTTON_SELECTOR);
      if (!button) return;
      if (allowNextClick) {
        allowNextClick = false;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (checking) return;
      checking = true;
      showVpnNotice("Vérification du VPN…", "pending");
      let res;
      try {
        res = await askBackground({ type: "CHECK_VPN" });
      } catch (err) {
        res = { ok: false, reason: err?.message || String(err) };
      }
      checking = false;
      if (!res?.ok) {
        showVpnNotice(`Connexion refusée : ${res?.reason || "VPN non confirmé"}. Active Mullvad puis réessaie.`, "refused");
        logger.warn(`Login blocked, VPN check failed: ${res?.reason}`);
        return;
      }
      showVpnNotice(`VPN Mullvad actif${res.country ? ` (${res.country})` : ""}, connexion…`, "ok");
      allowNextClick = true;
      button.click();
    },
    true,
  );

  // Un envoi direct du formulaire ne part pas tel quel : il repasse par le
  // bouton, donc par la vérification.
  document.addEventListener(
    "submit",
    (event) => {
      if (event.target?.id !== "login") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      document.querySelector(LOGIN_BUTTON_SELECTOR)?.click();
    },
    true,
  );
}

// Sur le moteur local, rien d'autre que la carte ne s'installe : pas de
// LOGIN_STATUS (il écraserait la persona du vrai jeu côté background), pas
// d'UI missives, pas d'auto-sync général.
function init() {
  installVpnGate();
  initWorldMarkers();
  if (IS_LOCAL_ENGINE) {
    initIndexUi();
    setupLocalMapSync();
    if (isIndexPage() && readPlayer()) injectExplorerPanel();
    return;
  }
  checkLogin();
  initMissiveUi();
  initIndexUi();
  setupAutoSync();
}

logger.info("Script injected");
init();
document.addEventListener("DOMContentLoaded", init);
