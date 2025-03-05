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
    if (response.error) {
      console.error("[popup.js] Error fetching attributes:", response.error);
    } else {
      console.log("[popup.js] Attributes fetched:", response.characters);
    }
  });
});

// Fetch events
document.getElementById("fetchLogs").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FETCH_LOGS" });
});

// Fetch all characters
document.getElementById("fetchAllCharacters").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FETCH_ALL_CHARACTERS" }, (response) => {
    if (response.error) {
      console.error("[popup.js] Error fetching characters:", response.error);
    } else {
      console.log("[popup.js] Characters fetched:", response.characters);
    }
  });
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
