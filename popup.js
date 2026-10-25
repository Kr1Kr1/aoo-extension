const statusDiv = document.getElementById("status");
const playerInfoDiv = document.getElementById("player-info");
const playerNameSpan = document.getElementById("player-name");
const statusMessage = document.getElementById("status-message");
const logLevelSelect = document.getElementById("logLevel");
const actionButtons = Array.from(document.querySelectorAll("button[data-action]"));

function setStatusMessage(text, kind = "info") {
  statusMessage.textContent = text;
  statusMessage.className = text ? `status-${kind}` : "";
}

function setButtonsDisabled(disabled) {
  actionButtons.forEach((btn) => {
    btn.disabled = disabled;
  });
}

function summarize(action, result) {
  if (!result || result.error) return null;
  switch (action) {
    case "FETCH_LOGS":
      return `Logs envoyés (${result.count})`;
    case "FETCH_RANKINGS":
      return `Classement envoyé (${result.count})`;
    case "FETCH_ALL_CHARACTERS":
      return `Personnages envoyés (${result.count})`;
    case "FETCH_FORUM_PRIVATE":
    case "FETCH_FORUM_RP":
    case "FETCH_FORUM_HRP":
      return `Forums envoyés (${result.count})`;
    case "FETCH_MISSIVES":
      return `Missives envoyées (${result.count})`;
    case "FETCH_FORUMS_FULL":
      if (result.failed?.length) {
        return `Forums (complet) : ${result.count}/${result.total} (échecs: ${result.failed.join(", ")})`;
      }
      return `Forums (complet) : ${result.count}/${result.total}`;
    case "FETCH_MAP":
      return "Carte envoyée";
    case "FETCH_MAP_MDJ":
      return `MDJ perception : ${result.count}/${result.total}`;
    case "FETCH_LOGS_MDJ":
      return `MDJ logs : ${result.count}/${result.total}`;
    case "FETCH_ATTRIBUTES":
      return "Caractéristiques envoyées";
    case "FETCH_ALL":
      if (result.failed?.length) {
        return `Fetch All: ${result.count}/${result.total} (échecs: ${result.failed.join(", ")})`;
      }
      return `Fetch All: ${result.count}/${result.total}`;
    default:
      return "OK";
  }
}

function sendAction(action, label) {
  setButtonsDisabled(true);
  setStatusMessage(`${label} en cours…`, "pending");
  chrome.runtime.sendMessage({ type: action }, (response) => {
    setButtonsDisabled(false);
    if (chrome.runtime.lastError) {
      setStatusMessage(`Erreur: ${chrome.runtime.lastError.message}`, "error");
      return;
    }
    if (response?.error) {
      setStatusMessage(`Échec: ${response.error}`, "error");
      console.error(`[popup] ${action} failed:`, response.error);
      return;
    }
    setStatusMessage(summarize(action, response) || "OK", "success");
    console.log(`[popup] ${action} result:`, response);
  });
}

// Login status
chrome.runtime.sendMessage({ type: "GET_LOGIN_STATUS" }, (response) => {
  if (chrome.runtime.lastError) {
    statusDiv.textContent = "Erreur de communication avec le background.";
    return;
  }
  if (response?.loggedIn) {
    statusDiv.style.display = "none";
    playerInfoDiv.style.display = "block";
    playerNameSpan.textContent = response.playerName || "Unknown Player";
  } else {
    statusDiv.textContent = "Utilisateur non connecté.";
    playerInfoDiv.style.display = "none";
  }
});

// Wire action buttons
actionButtons.forEach((btn) => {
  btn.addEventListener("click", () => sendAction(btn.dataset.action, btn.textContent.trim()));
});

// Log level selector
chrome.storage.sync.get(["logLevel"], (result) => {
  logLevelSelect.value = result.logLevel || "info";
});
logLevelSelect.addEventListener("change", (e) => {
  chrome.storage.sync.set({ logLevel: e.target.value });
});
