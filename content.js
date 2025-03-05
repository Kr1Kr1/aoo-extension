const baseURL = "https://age-of-olympia.net/";
const baseURLCharacter = "https://age-of-olympia.net/infos.php?targetId=";
const factionPrivateForums = {
  "La Forge Sacrée": ["La Caverne Bruyante"],
};

const fetchGameData = async () => {
    try {
      const response = await fetch("https://age-of-olympia.net/index.php?menu", {
        credentials: "include",
      });
      const text = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");
  
      const stats = doc.querySelector("#statsElement")?.innerText || "Stats indisponibles";
      console.log("[content.js] Fetched stats:", stats);

      chrome.runtime.sendMessage({
        type: "SAVE_STATS",
        data: { stats, time: new Date().toISOString() },
      });
    } catch (error) {
      console.error("[content.js] Error fetching game data:", error);
    }
  };

const checkLogin = () => {
  console.log("[content.js] checkLogin");
  const isLoggedIn = !!document.querySelector("#menu") && !!document.querySelector("#infos");
  console.log(`[content.js] isLoggedIn is ${isLoggedIn}`);

  try {
    if (isLoggedIn) {
      const playerInfoElement = document.querySelector("#infos .player-info a");
      const playerName = playerInfoElement?.innerText || "Unknown Player";
      const href = playerInfoElement?.getAttribute("href") || "";

      const playerIdMatch = href.match(/targetId=(-?\d+)/);
      const playerId = playerIdMatch ? parseInt(playerIdMatch[1], 10) : null;

      console.log(`[content.js] playerName is ${playerName}, playerId is ${playerId}`);

      chrome.runtime.sendMessage({
        type: "LOGIN_STATUS",
        loggedIn: true,
        data: { playerName, playerId },
      });
    } else {
      chrome.runtime.sendMessage({ type: "LOGIN_STATUS", loggedIn: false });
    }
  } catch (error) {
    console.error("[content.js] Error sending message to background script:", error);
  }
};

const fetchLogsPage = async () => {
try {
    const territoryName = await fetchTerritoryName();
    const response = await fetch("https://age-of-olympia.net/logs.php", {
    credentials: "include",
    });

    if (!response.ok) {
    console.error("[content.js] Failed to fetch logs page:", response.statusText);
    return;
    }

    const text = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    // Extract logs from the table
    const rows = doc.querySelectorAll("table tr");
    const logs = Array.from(rows).slice(1).map((row) => {
    const event = row.querySelector("td:nth-child(1) span")?.innerText || "Unknown Event";
    const details = row.querySelector("td:nth-child(1) .logs-hidden")?.innerText.trim() || "";
    const from = row.querySelector("td:nth-child(2)")?.innerText.trim() || "Unknown";
    const withWhom = row.querySelector("td:nth-child(3)")?.innerText.trim() || "None";
    const date = row.querySelector("td:nth-child(4)")?.innerText.trim() || "Unknown Date";

    return { event, details, from, withWhom, date, territory: territoryName, source: "extension" };
    });

    console.log("[content.js] Extracted logs:", logs);
    return logs;
} catch (error) {
    console.error("[content.js] Error fetching logs:", error);
    return [];
}
};

const fetchTerritoryName = async () => {
  try {
      const response = await fetch("https://age-of-olympia.net/map.php?local", {
          credentials: "include",
      });

      if (!response.ok) {
          console.error("[content.js] Failed to fetch territory name:", response.statusText);
          return "Unknown Territory";
      }

      const text = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");

      const territoryName = doc.querySelector("h1 font")?.innerText.trim() || "Unknown Territory";
      console.log("[content.js] Extracted territory name:", territoryName);

      return territoryName;
  } catch (error) {
      console.error("[content.js] Error fetching territory name:", error);
      return "Unknown Territory";
  }
};

async function fetchCharacter(id) {
  console.log(`Fetching character with ID: ${id}`);
  try {
    const response = await fetch(`${baseURLCharacter}${id}`);
    if (!response.ok) {
      console.log(`Character with ID ${id} not found (response not OK).`);
      return null;
    }
    const text = await response.text();

    if (text.includes("error player id")) {
      console.log(`Character with ID ${id} returned 'error player id'. Stopping fetch.`);
      return null;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    const name = doc.querySelector("#infos-player h1")?.innerText || null;
    const rank = doc.querySelector("#infos-player div:nth-child(2)")?.innerText.split(" - ")[1] || null;
    const popularity = doc.querySelector("a[href*='reputation']")?.innerText || null;
    const faction = doc.querySelector("a[href*='faction']")?.innerText || null;
    const role = doc.querySelector("#infos-player div:nth-child(3)")?.innerText.split("(<i>")[1]?.split("</i>)")[0] || null;
    const portraitUrl = doc.querySelector(".infos-portrait img")?.getAttribute("src") || null;

    const storyElement = doc.querySelector("td[colspan='2']");
    const story = storyElement ? storyElement.innerHTML
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[^>]+(>|$)/g, "")
      .trim() : null;

    const mdjElement = doc.querySelector(".infos-text");
    let mdj = null;

    if (mdjElement) {
      if (mdjElement.querySelector("i")) {
        mdj = null;
      } else {
        mdj = mdjElement.innerHTML
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/?[^>]+(>|$)/g, "")
          .trim();
      }
    }

    const equipmentElements = doc.querySelectorAll(".infos-item");
    const equipment = Array.from(equipmentElements).map((item) => ({
      id: item.getAttribute("data-id"),
      name: item.getAttribute("data-name"),
      description: item.getAttribute("data-text"),
      price: item.getAttribute("data-price"),
      type: item.getAttribute("data-type"),
      imageUrl: item.getAttribute("data-img"),
      thumbnailUrl: item.getAttribute("src"),
    }));

    console.log(`Character with ID ${id} parsed successfully:`, { name, rank, popularity, mdj, equipment, });
    return {
      targetId: id,
      name,
      rank,
      popularity,
      faction,
      role,
      portraitUrl,
      story,
      mdj,
      equipment,
    };
  } catch (error) {
    console.error(`Error fetching character with ID ${id}:`, error);
    return null;
  }
}

async function fetchAllCharacters() {
  console.log("Starting to fetch all characters...");
  const characters = [];

  let id = 1;
  while (true) {
    console.log(`Processing character with ID ${id}...`);
    const character = await fetchCharacter(id);
    if (!character) {
      console.log(`No more characters found after ID ${id - 1}. Stopping positive loop.`);
      break;
    }
    characters.push(character);
    console.log(`Character with ID ${id} added to the list.`);
    id++;
  }

  id = -3;
  while (true) {
    console.log(`Processing character with ID ${id}...`);
    const character = await fetchCharacter(id);
    if (!character) {
      console.log(`No more characters found after ID ${id + 1}. Stopping negative loop.`);
      break;
    }
    characters.push(character);
    console.log(`Character with ID ${id} added to the list.`);
    id--;
  }

  console.log("Finished fetching characters:", characters);
  return characters;
}

const fetchPrivateForumForFaction = async () => {
  try {
    console.log("[content.js] Fetching private forum for faction...");
    
    const response = await fetch(`${baseURL}forum.php`, {
      credentials: "include",
    });

    if (!response.ok) {
      console.error("[content.js] Failed to fetch forum page:", response.statusText);
      return null;
    }

    const text = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    const privateSectionHeader = Array.from(doc.querySelectorAll("th"))
      .find((header) => header.textContent.trim() === "Privés");

    if (!privateSectionHeader) {
      console.warn("[content.js] No 'Privés' section found in the forum page");
      return null;
    }

    const privateRows = [];
    let nextRow = privateSectionHeader.parentElement.nextElementSibling;

    while (nextRow && nextRow.classList.contains("tr-cat")) {
      privateRows.push(nextRow);
      nextRow = nextRow.nextElementSibling;
    }

    if (privateRows.length === 0) {
      console.warn("[content.js] No private forums found in the 'Privés' section");
      return null;
    }

    const privateForums = privateRows.map((row) => {
      const forumName = row.querySelector("td.forum")?.getAttribute("data-forum");
      const forumLink = `${baseURL}forum.php?forum=${encodeURIComponent(forumName)}`;
      return { forumName, forumLink };
    });

    console.log("[content.js] Found private forums:", privateForums);

    return privateForums;
  } catch (error) {
    console.error("[content.js] Error fetching private forum:", error);
    return null;
  }
};

const fetchForumTopics = async (forumLink) => {
  try {
    console.log("[content.js] Fetching topics from forum:", forumLink);
    const response = await fetch(forumLink, { credentials: "include" });

    if (!response.ok) {
      console.error("[content.js] Failed to fetch forum topics:", response.statusText);
      return [];
    }

    const text = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    const topicRows = doc.querySelectorAll("tr.tr-forum");
    const topics = Array.from(topicRows).map((row) => {
      const topicNameRaw = row.querySelector("td[data-topic]")?.innerText.trim() || "Unknown Topic";
      const topicName = topicNameRaw.replace(/Par\s+.+$/i, "").trim();

      const topicAuthorRaw = row.querySelector("td[data-topic] div i")?.innerText.trim() || "Unknown Author";
      const topicAuthor = topicAuthorRaw.replace(/^Par\s+/i, "");

      const dataTopic = row.querySelector("td[data-topic]")?.getAttribute("data-topic");
      const topicLink = dataTopic ? `${baseURL}forum.php?topic=${dataTopic}` : null;

      return { topicName, topicAuthor, topicLink };
    });

    console.log("[content.js] Extracted topics:", topics);
    return topics;
  } catch (error) {
    console.error("[content.js] Error fetching forum topics:", error);
    return [];
  }
};

const fetchTopicMessages = async (topicLink) => {
  try {
    console.log("[content.js] Fetching topic messages from:", topicLink);
    
    let allMessages = [];
    let currentPage = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const pageLink = `${topicLink}&page=${currentPage}`;
      const response = await fetch(pageLink, { credentials: "include" });

      if (!response.ok) {
        console.error("[content.js] Failed to fetch topic page:", response.statusText);
        break;
      }

      const text = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");

      // Extract messages from the page
      const messages = Array.from(doc.querySelectorAll("tr.tr-topic1")).map((row) => {
        const authorRow = row.previousElementSibling;
        const authorElement = authorRow.querySelector("a[href*='infos.php?targetId=']");
        const author = authorRow.querySelector("div > a")?.innerText.trim() || "Unknown Author";
        const authorTargetId = authorElement
          ? parseInt(authorElement.getAttribute("href").match(/targetId=(-?\d+)/)?.[1], 10)
          : null;

        const content = row.querySelector("td[data-post] div")?.innerHTML.trim() || "No content";
        const date = authorRow.querySelector("span[style*='color: grey']")?.innerText.trim() || "Unknown Date";

        return {
          author: {
            name: author,
            targetId: authorTargetId,
          },
          content,
          date,
        };
      });

      allMessages = [...allMessages, ...messages];

      console.log(`[content.js] Extracted ${messages.length} messages from page ${currentPage}`);

      // Check for the next page
      const nextPageLink = doc.querySelector(`a[href*="page=${currentPage + 1}"]`);
      if (nextPageLink) {
        currentPage++;
      } else {
        hasNextPage = false;
      }
    }

    console.log("[content.js] All messages fetched successfully:", allMessages);
    return allMessages;
  } catch (error) {
    console.error("[content.js] Error fetching topic messages:", error);
    return [];
  }
};

const fetchPrivateForumData = async () => {
  try {
    console.log("[content.js] Fetching private forum data...");

    const privateForums = await fetchPrivateForumForFaction();

    if (!privateForums || privateForums.length === 0) {
      console.warn("[content.js] No private forum data to fetch.");
      return [];
    }

    const forumsWithTopicsAndMessages = await Promise.all(
      privateForums.map(async (forum) => {
        if (!forum.forumLink) {
          console.warn("[content.js] Missing forumLink in forum object:", forum);
          return null;
        }

        const topics = await fetchForumTopics(forum.forumLink);

        const topicsWithMessages = await Promise.all(
          topics.map(async (topic) => {
            if (!topic.topicLink) {
              console.warn("[content.js] Missing topicLink in topic object:", topic);
              return null;
            }

            const messages = await fetchTopicMessages(topic.topicLink);
            return { ...topic, messages };
          })
        );

        const validTopicsWithMessages = topicsWithMessages.filter(Boolean);

        // Find the faction for the forum
        const faction = Object.keys(factionPrivateForums).find((factionName) =>
          factionPrivateForums[factionName].includes(forum.forumName)
        );

        return {
          forum: {
            name: forum.forumName,
            link: forum.forumLink,
            type: "Private",
            faction: faction || "Unknown Faction", // Assign "Unknown Faction" if no match
          },
          topics: validTopicsWithMessages,
        };
      })
    );

    const validForumsWithTopicsAndMessages = forumsWithTopicsAndMessages.filter(Boolean);

    console.log("[content.js] Private forum data fetched successfully:", validForumsWithTopicsAndMessages);
    return validForumsWithTopicsAndMessages;
  } catch (error) {
    console.error("[content.js] Error fetching private forum data:", error);
    return [];
  }
};

const fetchRPForumData = async () => {
  try {
    console.log("[content.js] Fetching RP forum data...");

    // Fetch the forum page
    const response = await fetch(`${baseURL}forum.php`, {
      credentials: "include", // Include cookies for authentication
    });

    if (!response.ok) {
      console.error("[content.js] Failed to fetch forum page:", response.statusText);
      return [];
    }

    const text = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    // Locate the "RP" section header
    const rpSectionHeader = Array.from(doc.querySelectorAll("th"))
      .find((header) => header.textContent.trim() === "RP");

    if (!rpSectionHeader) {
      console.warn("[content.js] No 'RP' section found in the forum page");
      return [];
    }

    // Find the sibling rows in the table for RP forums
    const rpRows = [];
    let nextRow = rpSectionHeader.parentElement.nextElementSibling;

    while (nextRow && nextRow.classList.contains("tr-cat")) {
      rpRows.push(nextRow);
      nextRow = nextRow.nextElementSibling;
    }

    if (rpRows.length === 0) {
      console.warn("[content.js] No RP forums found in the 'RP' section");
      return [];
    }

    // Extract the name and link of the forums
    const rpForums = rpRows.map((row) => {
      const forumName = row.querySelector("td.forum")?.getAttribute("data-forum");
      const forumLink = `${baseURL}forum.php?forum=${encodeURIComponent(forumName)}`;
      return { forumName, forumLink };
    });

    console.log("[content.js] Found RP forums:", rpForums);

    // Fetch topics and messages for each RP forum
    const forumsWithTopicsAndMessages = await Promise.all(
      rpForums.map(async (forum) => {
        if (!forum.forumLink) {
          console.warn("[content.js] Missing forumLink in forum object:", forum);
          return null;
        }

        const topics = await fetchForumTopics(forum.forumLink);

        const topicsWithMessages = await Promise.all(
          topics.map(async (topic) => {
            if (!topic.topicLink) {
              console.warn("[content.js] Missing topicLink in topic object:", topic);
              return null;
            }

            const messages = await fetchTopicMessages(topic.topicLink);
            return { ...topic, messages };
          })
        );

        const validTopicsWithMessages = topicsWithMessages.filter(Boolean);

        return {
          forum: {
            name: forum.forumName,
            link: forum.forumLink,
            type: "RP",
            faction: "Unknown",
          },
          topics: validTopicsWithMessages,
        };
      })
    );

    const validForumsWithTopicsAndMessages = forumsWithTopicsAndMessages.filter(Boolean);

    console.log("[content.js] RP forum data fetched successfully:", validForumsWithTopicsAndMessages);
    return validForumsWithTopicsAndMessages;
  } catch (error) {
    console.error("[content.js] Error fetching RP forum data:", error);
    return [];
  }
};

function parseAttributes(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const attributes = {};

  const table = doc.querySelector("#caracs-menu");
  if (!table) {
    console.error("[content.js] Attributes table not found.");
    return null;
  }

  const headers = Array.from(table.querySelectorAll("th")).map((th) => th.innerText.trim());

  const dataRow = table.querySelector("tr:nth-child(2)");
  if (dataRow) {
    const values = Array.from(dataRow.querySelectorAll("td")).map((td) => td.innerText.trim());
    headers.forEach((header, index) => {
      let value = values[index];

      if (header === "A" && value.includes("/")) {
        value = value.split("/")[1];
      }

      attributes[header] = isNaN(value) ? value : parseInt(value, 10);
    });
  }

  const additionalRows = table.querySelectorAll("tr:nth-child(n+3)");
  additionalRows.forEach((row) => {
    const text = row.innerText.trim();
    if (text.includes("Xp")) {
      const xpMatch = text.match(/Xp:\s*(\d+)\/(\d+)/);
      if (xpMatch) {
        attributes["Xp"] = { current: parseInt(xpMatch[1], 10), max: parseInt(xpMatch[2], 10) };
      }
    }
    if (text.includes("Pi")) {
      const piMatch = text.match(/Pi:\s*(\d+)/);
      if (piMatch) {
        attributes["Pi"] = parseInt(piMatch[1], 10);
      }
    }
    if (text.includes("Fatigue")) {
      const fatigueMatch = text.match(/Fatigue.*:\s*([-+]?\d+)/);
      if (fatigueMatch) {
        attributes["Fatigue"] = parseInt(fatigueMatch[1], 10);
      }
    }
    if (text.includes("Malus")) {
      const malusMatch = text.match(/Malus.*:\s*(-?\d+)/);
      if (malusMatch) {
        attributes["Malus"] = parseInt(malusMatch[1], 10);
      }
    }
  });

  return attributes;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[content.js] Received message:", message);

  if (message.type === "FETCH_ATTRIBUTES") {
    const responses = {};

    if (window.location.href.includes("index.php")) {
      console.log("[content.js] Fetching attributes for the logged-in character...");

      const caracButton = document.querySelector("#show-caracs");
      if (!caracButton) {
        console.error("[content.js] Caractéristiques button not found.");
        responses.indexAttributesError = "Caractéristiques button not found on index.php";
      } else {
        caracButton.click();

        const observer = new MutationObserver((mutations, observerInstance) => {
          const loadCaracsDiv = document.querySelector("#load-caracs");
          if (loadCaracsDiv && loadCaracsDiv.innerHTML.trim() !== "") {
            console.log("[content.js] Caractéristiques loaded:", loadCaracsDiv.innerHTML);

            const attributes = parseAttributes(loadCaracsDiv.innerHTML);
            console.log("[content.js] Parsed attributes for logged-in character:", attributes);

            responses.indexAttributes = attributes;

            observerInstance.disconnect();

            if (responses.rankings || responses.rankingsError) {
              sendResponse(responses);
            }
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
        });
      }
    }

    if (window.location.href.includes("classements.php")) {
      console.log("[content.js] Fetching rankings data...");

      const table = document.querySelector("table.marbre");
      if (!table) {
        console.error("[content.js] Rankings table not found.");
        responses.rankingsError = "Rankings table not found on classements.php";
      } else {
        const characters = [];
        const rows = table.querySelectorAll("tr");
        rows.forEach((row, index) => {
          if (index === 0) return;
          const columns = row.querySelectorAll("td");
          if (columns.length > 0) {
            const character = {
              rank: columns[0]?.innerText.trim(),
              name: columns[1]?.innerText.trim(),
              targetId: columns[2]?.querySelector("a")?.getAttribute("href")?.match(/targetId=(\d+)/)?.[1],
              reputation: columns[3]?.innerText.trim(),
              xp: parseInt(columns[4]?.innerText.trim(), 10),
            };
            characters.push(character);
          }
        });

        console.log("[content.js] Parsed rankings data:", characters);
        responses.rankings = characters;

        if (responses.indexAttributes || responses.indexAttributesError) {
          sendResponse(responses);
        }
      }
    }

    return true;
  }

  if (message.type === "FETCH_LOGS") {
      console.log("[content.js] Fetching logs...");
      fetchLogsPage().then((logs) => {
          console.log("[content.js] Sending logs back to background script");
          sendResponse({ logs });
      }).catch((error) => {
          console.error("[content.js] Error fetching logs:", error);
          sendResponse({ error: "Failed to fetch logs" });
      });
      return true;
  }

  if (message.type === "FETCH_ALL_CHARACTERS") {
    console.log("[content.js] Fetching all characters...");
    fetchAllCharacters()
      .then((characters) => {
        console.log("[content.js] Sending characters back to background script");
        sendResponse({ characters });
      })
      .catch((error) => {
        console.error("[content.js] Error fetching characters:", error);
        sendResponse({ error: "Failed to fetch characters" });
      });
    return true;
  }

  if (message.type === "FETCH_FORUM_PRIVATE") {
    fetchPrivateForumData()
      .then((forumData) => {
        sendResponse(forumData);
      })
      .catch((error) => {
        console.error("[content.js] Error fetching private forum:", error);
        sendResponse({ error: "Failed to fetch private forum data" });
      });
    return true;
  }

  if (message.type === "FETCH_FORUM_RP") {
    fetchRPForumData()
      .then((forumData) => {
        sendResponse(forumData);
      })
      .catch((error) => {
        console.error("[content.js] Error fetching private forum:", error);
        sendResponse({ error: "Failed to fetch private forum data" });
      });
    return true;
  }

});

console.log("[content.js] Script injected");
checkLogin();

document.addEventListener("DOMContentLoaded", () => {
  console.log("[content.js] DOM fully loaded, running checkLogin...");
  checkLogin();
});
