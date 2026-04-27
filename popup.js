chrome.runtime.sendMessage({ type: "GET_LOGIN_STATUS" }, (response) => {
    console.log("Login status response:", response);
    const statusDiv = document.getElementById("status");
    const playerInfoDiv = document.getElementById("player-info");
    const playerNameSpan = document.getElementById("player-name");
  
    if (response?.loggedIn) {
      statusDiv.style.display = "none";
      playerInfoDiv.style.display = "block";
      playerNameSpan.textContent = response.playerName || "Unknown Player";
    } else {
      statusDiv.textContent = "User not logged in.";
      playerInfoDiv.style.display = "none";
    }

  });

// Fetch attributes
document.getElementById("fetchAttributes").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FETCH_ATTRIBUTES" }, (response) => {
    if (!response) {
      console.error("[popup.js] No response received");
      return;
    }
    
    if (response.error) {
      console.error("[popup.js] Error fetching attributes:", response.error);
      return;
    }
    console.log("[popup.js] Attributes fetched:", response.attributes);
  });
});

// Fetch events
document.getElementById("fetchLogs").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FETCH_LOGS" });
});

// Fetch all characters
document.getElementById("fetchAllCharacters").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FETCH_ALL_CHARACTERS" });
  console.log("[popup.js] Triggered FETCH_ALL_CHARACTERS");
});

// Fetch Forum Private
document.getElementById("fetchForumPrivate").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FETCH_FORUM_PRIVATE" }, (response) => {
    if (response.error) {
      console.error("[popup.js] Error fetching Forum Private:", response.error);
      alert("Failed to fetch Forum Private. Check console for details.");
    } else {
      console.log("[popup.js] Forum Private fetched:", response.forums);
      alert("Forum Private data fetched successfully. Check console for details.");
    }
  });
});

// Fetch Forum RP
document.getElementById("fetchForumRP").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FETCH_FORUM_RP" }, (response) => {
    if (response.error) {
      console.error("[popup.js] Error fetching Forum RP:", response.error);
      alert("Failed to fetch Forum RP. Check console for details.");
    } else {
      console.log("[popup.js] Forum RP fetched:", response.forums);
      alert("Forum RP data fetched successfully. Check console for details.");
    }
  });
});

// Fetch Map
document.getElementById("fetchMap").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FETCH_MAP" }, (response) => {
    if (response?.error) {
      console.error("[popup.js] Error fetching map data:", response.error);
    } else {
      console.log("[popup.js] Map data fetched successfully");
    }
  });
});

// Fetch Reputation: removed. Reputation is now fetched automatically during 'Fetch All Characters'.

// Initialize log level selector
document.addEventListener('DOMContentLoaded', () => {
  const logLevelSelect = document.getElementById('logLevel');
  
  // Load current log level
  chrome.storage.sync.get(['logLevel'], (result) => {
    logLevelSelect.value = result.logLevel || 'info';
  });

  // Save log level changes
  logLevelSelect.addEventListener('change', (e) => {
    chrome.storage.sync.set({ logLevel: e.target.value });
  });
});

// Fetch Rankings
document.getElementById("fetchRankings").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FETCH_RANKINGS" }, (response) => {
    if (response.error) {
      console.error("[popup.js] Error fetching rankings:", response.error);
      alert("Failed to fetch rankings. Check console for details.");
    } else {
      console.log("[popup.js] Rankings fetched:", response.rankings);
      alert("Rankings data fetched successfully. Check console for details.");
    }
  });
});
