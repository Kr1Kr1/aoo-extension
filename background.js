// Log levels
const LOG_LEVELS = {
  error: 0,
  info: 1,
  debug: 2
};

// Logger
const logger = {
  error: (message, ...args) => {
    console.error(`[background.js] ${message}`, ...args);
  },
  info: (message, ...args) => {
    if (LOG_LEVELS[currentLogLevel] >= LOG_LEVELS.info) {
      console.log(`[background.js] ${message}`, ...args);
    }
  },
  debug: (message, ...args) => {
    if (LOG_LEVELS[currentLogLevel] >= LOG_LEVELS.debug) {
      console.log(`[background.js] ${message}`, ...args);
    }
  }
};

let loginState = { loggedIn: false, playerName: null, playerId: null, playerAvatar: null };
let authToken = null;
let currentLogLevel = 'info'; // Default log level

// Initialize logger
chrome.storage.sync.get(['logLevel'], (result) => {
  currentLogLevel = result.logLevel || 'info';
});

// Listen for changes to log level
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.logLevel) {
    currentLogLevel = changes.logLevel.newValue;
  }
});

// Helper function to download assets
async function downloadAsset(url, type) {
  const response = await fetch('http://localhost:3001/api/assets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, type })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to download asset: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.path;
}

async function callApi(endpoint, method, body) {
  const token = await ensureAuthenticated();
  return fetch(`http://localhost:3001/api/${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function ensureAuthenticated() {
  if (!authToken) {
    const response = await fetch('http://localhost:3001/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'karin',
        password: 'karin'
      })
    });

    if (!response.ok) {
      throw new Error('Authentication failed');
    }

    const data = await response.json();
    authToken = data.token;
  }
  return authToken;
}

async function sendLogToApi(log, playerId) {
  try {
    // Validate required fields
    if (!log || typeof log !== 'object') {
      logger.error("[background.js] Invalid log object:", log);
      return false;
    }

    const payload = {
      event: log.event,
      details: log.details || '',
      fromCol: log.from || '',
      withWhom: log.withWhom || 'None', 
      date: log.date || '',
      territory: log.territory || '',
      source: log.source || 'extension',
      playerId: playerId || null
    };

    // Check if we have minimum required data
    if (!payload.event || !payload.date) {
      logger.error("[background.js] Missing required fields in log:", payload);
      return false;
    }

    // Ensure we have an auth token
    await ensureAuthenticated();
    
    if (!authToken) {
      throw new Error("No auth token available");
    }

    logger.info("[background.js] Sending log to API:", payload);

    const res = await fetch("http://localhost:3001/api/events", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`
      },
      body: JSON.stringify(payload),
    });

    const responseText = await res.text();
    const responseData = responseText ? JSON.parse(responseText) : {};

    if (res.ok || res.status === 409) {
      if (res.status === 409) {
        logger.info("[background.js] Event already exists:", responseData.existingEvent);
      } else {
        logger.info("[background.js] Log sent to API:", payload);
      }
      return true;
    } else {
      logger.error("[background.js] Failed to send log to API. Status:", res.status, "Response:", responseText);
      return false;
    }
  } catch (error) {
    logger.error("[background.js] Error sending log to API:", error.message);
    return false;
  }
}

async function handleLogs(logs) {
  if (!logs || !Array.isArray(logs)) {
    logger.error("[background.js] Invalid logs data received");
    return false;
  }

  if (!loginState.playerId) {
    logger.error("[background.js] Player ID not found in login state.");
    return false;
  }

  logger.info("[background.js] Processing logs:", logs);
  
  const results = await Promise.all(
    logs.map(log => sendLogToApi(log, loginState.playerId))
  );

  const successCount = results.filter(Boolean).length;
  logger.info(`[background.js] Successfully sent ${successCount}/${logs.length} logs`);
  
  return successCount === logs.length;
}

async function sendMapToApi(map, playerId) {
  try {
    if (!map || typeof map !== 'object') {
      logger.error("[background.js] Invalid map object:", map);
      return false;
    }

    const payload = {
      ...map,
      source: map.source || 'extension',
      playerId: playerId || null
    };

    await ensureAuthenticated();
    
    if (!authToken) {
      throw new Error("No auth token available");
    }

    logger.info("[background.js] Sending map to API:", payload);

    const res = await fetch("http://localhost:3001/api/maps", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`
      },
      body: JSON.stringify(payload),
    });

    const responseText = await res.text();
    const responseData = responseText ? JSON.parse(responseText) : {};

    if (res.ok || res.status === 409) {
      if (res.status === 409) {
        logger.info("[background.js] Map already exists:", responseData.existingMap);
      } else {
        logger.info("[background.js] Map sent to API:", payload);
      }
      return true;
    } else {
      logger.error("[background.js] Failed to send map to API. Status:", res.status, "Response:", responseText);
      return false;
    }
  } catch (error) {
    logger.error("[background.js] Error sending map to API:", error.message);
    return false;
  }
}

async function handleMap(map) {
  if (!map || !Array.isArray(map)) {
    logger.error("[background.js] Invalid map data received");
    return false;
  }

  if (!loginState.playerId) {
    logger.error("[background.js] Player ID not found in login state.");
    return false;
  }

  logger.info("[background.js] Processing maps:", map);
  
  const results = await Promise.all(
    map.map(item => sendMapToApi(item, loginState.playerId))
  );

  const successCount = results.filter(Boolean).length;
  logger.info(`[background.js] Successfully sent ${successCount}/${map.length} maps`);
  
  return successCount === map.length;
}

async function sendAttributesToApi(attributes) {
  try {
    if (!attributes || !Array.isArray(attributes)) {
      logger.error("[background.js] Invalid attributes data received");
      return false;
    }

    if (!loginState.playerId) {
      logger.error("[background.js] Player ID not found in login state.");
      return false;
    }

    logger.info("[background.js] Processing attributes:", attributes);

    const characterId = loginState.playerId;

    const results = await Promise.all(
      attributes.map(async (attribute) => {
        try {
          const apiResponse = await fetch(`http://localhost:3001/api/characters/${characterId}/attributes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(attribute),
          });

          if (apiResponse.ok) {
            logger.info("[background.js] Attributes successfully sent to API.");
            return true;
          } else {
            logger.error("[background.js] Failed to send attributes to API:");
            return false;
          }
        } catch (error) {
          logger.error("[background.js] Error sending attributes to API:", error.message);
          return false;
        }
      })
    );

    const successCount = results.filter(Boolean).length;
    logger.info(`[background.js] Successfully sent ${successCount}/${attributes.length} attributes`);
    
    return successCount === attributes.length;
  } catch (error) {
    logger.error("[background.js] Error processing attributes:", error.message);
    return false;
  }
}

async function handleAttributes(attributes) {
  if (!attributes || !Array.isArray(attributes)) {
    logger.error("[background.js] Invalid attributes data received");
    return false;
  }

  if (!loginState.playerId) {
    logger.error("[background.js] Player ID not found in login state.");
    return false;
  }

  logger.info("[background.js] Processing attributes:", attributes);
  
  const results = await Promise.all(
    attributes.map(attribute => sendAttributesToApi([attribute]))
  );

  const successCount = results.filter(Boolean).length;
  logger.info(`[background.js] Successfully sent ${successCount}/${attributes.length} attributes`);
  
  return successCount === attributes.length;
}

async function sendRankingsToApi(rankings) {
  try {
    if (!rankings || !Array.isArray(rankings)) {
      logger.error("[background.js] Invalid rankings data:", rankings);
      return false;
    }

    logger.info("[background.js] Processing rankings data:", rankings);

    const results = await Promise.all(
      rankings.map(async (ranking) => {
        try {
          // Only send the XP value
          const res = await fetch(`http://localhost:3001/api/characters/${ranking.targetId}/attributes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ xp: ranking.xp }),
          });

          if (res.ok) {
            logger.info(`[background.js] Successfully updated XP for character ${ranking.targetId}`);
            return true;
          } else {
            const responseText = await res.text();
            logger.error(`[background.js] Failed to update XP for character ${ranking.targetId}. Status: ${res.status}, Response: ${responseText}`);
            return false;
          }
        } catch (error) {
          logger.error(`[background.js] Error updating XP for character ${ranking.targetId}:`, error.message);
          return false;
        }
      })
    );

    const successCount = results.filter(Boolean).length;
    logger.info(`[background.js] Successfully updated XP for ${successCount}/${rankings.length} characters`);
    
    return successCount === rankings.length;
  } catch (error) {
    logger.error("[background.js] Error processing rankings:", error.message);
    return false;
  }
}

async function handleRankings(rankings) {
  if (!rankings || !Array.isArray(rankings)) {
    logger.error("[background.js] Invalid rankings data received");
    return false;
  }

  if (!loginState.playerId) {
    logger.error("[background.js] Player ID not found in login state.");
    return false;
  }

  logger.info("[background.js] Processing rankings:", rankings);
  
  const result = await sendRankingsToApi(rankings, loginState.playerId);
  
  if (result) {
    logger.info("[background.js] Successfully sent rankings data");
  }
  
  return result;
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  logger.info("[background.js] Received message:", message);

  switch (message.type) {
    case "LOGIN_STATUS":
      if (message.loggedIn !== undefined) {
        loginState.loggedIn = message.loggedIn;

        if (message.loggedIn) {
          loginState.playerName = message.data?.playerName || "Unknown Player";
          loginState.playerId = message.data.playerId || null;
          logger.info(`[background.js] Logged in as ${loginState.playerName}`);
        } else {
          logger.info("[background.js] User is not logged in.");
        }
      } else {
        logger.warn("[background.js] LOGIN_STATUS message missing 'loggedIn' property");
      }
      break;

    case "GET_LOGIN_STATUS":
      logger.info("[background.js] Received GET_LOGIN_STATUS request");
      sendResponse(loginState);
      return true;

    case "FETCH_MAP":
      chrome.tabs.query({}, (tabs) => {
        if (tabs.length === 0) {
          logger.error("[background.js] No tabs found");
          return;
        }

        // Try to find Age of Olympia tab first
        let targetTab = tabs.find(tab => tab.url?.includes('age-of-olympia.net'));
        if (!targetTab) {
          targetTab = tabs[0];
        }

        chrome.tabs.sendMessage(targetTab.id, { type: "FETCH_MAP" }, async (response) => {
          if (chrome.runtime.lastError) {
            logger.error("[background.js] Error:", chrome.runtime.lastError.message);
            return;
          }

          if (response?.map) {
            logger.info("[background.js] Map received from content script:", response.map);
            await handleMap(response.map);
          } else {
            logger.error("[background.js] No map received from content script");
          }
        });
      });
      return true;

    case "FETCH_ATTRIBUTES":
      chrome.tabs.query({}, async (tabs) => {
        if (tabs.length === 0) {
          logger.error("[background.js] No tabs found");
          return;
        }

        // Try to find Age of Olympia tab first
        let targetTab = tabs.find(tab => tab.url?.includes('age-of-olympia.net'));
        if (!targetTab) {
          targetTab = tabs[0];
        }

        // First, navigate to the rankings page
        await chrome.tabs.update(targetTab.id, { url: 'https://age-of-olympia.net/classements.php' });

        // Wait for the page to load before fetching attributes
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === targetTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            
            // Now fetch the attributes
            chrome.tabs.sendMessage(targetTab.id, { type: "FETCH_ATTRIBUTES" }, async (response) => {
              if (chrome.runtime.lastError) {
                logger.error("[background.js] Error:", chrome.runtime.lastError.message);
                return;
              }

              if (response?.attributes) {
                logger.info("[background.js] Attributes received from content script:", response.attributes);
                
                // Transform attributes to match API format
                const transformedAttributes = [{
                  a: response.attributes.A,
                  mvt: response.attributes.Mvt,
                  p: response.attributes.P,
                  pv: response.attributes.PV,
                  cc: response.attributes.CC,
                  ct: response.attributes.CT,
                  f: response.attributes.F,
                  e: response.attributes.E,
                  agi: response.attributes.Agi,
                  pm: response.attributes.PM,
                  fm: response.attributes.FM,
                  m: response.attributes.M,
                  r: response.attributes.R,
                  rm: response.attributes.RM,
                  xp: response.attributes.Xp?.current || 0,
                }];

                await handleAttributes(transformedAttributes);
              } else {
                logger.error("[background.js] No attributes received from content script");
              }
            });
          }
        });
      });
      return true;

    case "FETCH_LOGS":
      chrome.tabs.query({}, (tabs) => {
        if (tabs.length === 0) {
          logger.error("[background.js] No tabs found");
          return;
        }

        // Try to find Age of Olympia tab first
        let targetTab = tabs.find(tab => tab.url?.includes('age-of-olympia.net'));
        if (!targetTab) {
          targetTab = tabs[0];
        }

        chrome.tabs.sendMessage(targetTab.id, { type: "FETCH_LOGS" }, async (response) => {
          if (chrome.runtime.lastError) {
            logger.error("[background.js] Error:", chrome.runtime.lastError.message);
            return;
          }

          if (response?.logs) {
            logger.info("[background.js] Logs received from content script:", response.logs);
            await handleLogs(response.logs);
          } else {
            logger.error("[background.js] No logs received from content script");
          }
        });
      });
      return true;

    case "FETCH_ALL_CHARACTERS":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          logger.error("[background.js] No active tab found");
          return;
        }

        chrome.tabs.sendMessage(tabs[0].id, { type: "FETCH_ALL_CHARACTERS" }, (response) => {
          if (chrome.runtime.lastError) {
            logger.error("[background.js] Error communicating with content script:", chrome.runtime.lastError.message);
            return;
          }

          if (response?.characters) {
            logger.info("[background.js] Characters received from content script:", response.characters);

            response.characters.forEach(async (character) => {
              try {
                const { mdj, story, equipment, ...characterData } = character;

                const existingCharacterRes = await fetch(`http://localhost:3001/api/characters/${characterData.targetId}`);
                let existingCharacter = null;

                if (existingCharacterRes.ok) {
                  existingCharacter = await existingCharacterRes.json();
                  logger.info(`[background.js] Existing character found:`, existingCharacter);
                } else {
                  logger.info(`[background.js] Character does not exist, creating new character:`, characterData);
                }

                const method = existingCharacter ? "PATCH" : "POST";
                const endpoint = `http://localhost:3001/api/characters${existingCharacter ? `/${characterData.targetId}` : ""}`;

                logger.info(`[background.js] Endpoint & method:`, endpoint, method);
                const res = await fetch(endpoint, {
                  method,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(characterData),
                });

                if (res.ok) {
                  logger.info(`[background.js] Character successfully ${existingCharacter ? "updated" : "created"}:`, character);
                } else {
                  logger.error(`[background.js] Failed to ${existingCharacter ? "update" : "create"} character:`, character, await res.text());
                }

                if (mdj !== null) {
                  try {
                    const mdjRes = await fetch(`http://localhost:3001/api/characters/${characterData.targetId}/mdj`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ mdj }),
                    });

                    const responseText = await mdjRes.text();
                    if (mdjRes.ok) {
                      logger.info(`[background.js] MDJ successfully sent for character ${characterData.targetId}: ${mdj}`);
                    } else if (responseText.includes("Duplicate MDJ content detected")) {
                      logger.info(`[background.js] Duplicate MDJ detected for character ${characterData.targetId} - skipping`);
                    } else {
                      logger.error(`[background.js] Failed to send MDJ for character ${characterData.targetId}:`, responseText);
                    }
                  } catch (error) {
                    logger.error(`[background.js] Error sending MDJ for character ${characterData.targetId}:`, error);
                  }
                }

                if (story !== null) {
                  try {
                    const historyRes = await fetch(`http://localhost:3001/api/characters/${characterData.targetId}/history`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ story }),
                    });

                    if (historyRes.ok) {
                      logger.info(`[background.js] History successfully sent for character ${characterData.targetId}: ${story}`);
                    } else {
                      logger.error(`[background.js] Failed to send history for character ${characterData.targetId}:`, await historyRes.text());
                    }
                  } catch (error) {
                    logger.error(`[background.js] Error sending history for character ${characterData.targetId}:`, error);
                  }
                }

                if (equipment !== undefined && equipment !== null && Array.isArray(equipment) && equipment.length > 0) {
                  try {
                    // Convert price to integer for each equipment item
                    const processedEquipment = equipment.map(item => ({
                      ...item,
                      price: item.price ? parseInt(item.price, 10) : null
                    }));

                    // Send all equipment items in a single request
                    const equipmentRes = await fetch(`http://localhost:3001/api/characters/${characterData.targetId}/equipment`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ equipment: processedEquipment }), // Send the processed equipment array
                    });

                    if (equipmentRes.ok) {
                      const response = await equipmentRes.json();
                      
                      // Log successful creations
                      if (response.results?.length > 0) {
                        logger.info(`[background.js] Successfully added ${response.results.length} equipment items for character ${characterData.targetId}`);
                      }
                      
                      // Log any errors
                      if (response.errors?.length > 0) {
                        response.errors.forEach(error => {
                          logger.error(`[background.js] Failed to add equipment item for character ${characterData.targetId}:`, error);
                        });
                      }
                    } else {
                      const errorText = await equipmentRes.text();
                      logger.error(`[background.js] Failed to send equipment for character ${characterData.targetId}:`, errorText);
                    }
                  } catch (error) {
                    logger.error(`[background.js] Error processing equipment for character ${characterData.targetId}:`, error);
                  }
                } else {
                  logger.debug(`[background.js] No equipment data to process for character ${characterData.targetId}`);
                }

              } catch (error) {
                logger.error("[background.js] Error processing character data:", error);
              }
            });
          } else if (response?.error) {
            logger.error("[background.js] Error received from content script:", response.error);
          } else {
            logger.error("[background.js] No characters received from content script");
          }
        });
      });
      break;

    case "FETCH_FORUM_PRIVATE":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          logger.error("[background.js] No active tab found");
          return;
        }
    
        chrome.tabs.sendMessage(tabs[0].id, { type: "FETCH_FORUM_PRIVATE" }, async (response) => {
          if (chrome.runtime.lastError) {
            logger.error("[background.js] Error communicating with content script:", chrome.runtime.lastError.message);
            return;
          }
    
          if (response?.length) {
            logger.info("[background.js] Forum data received from content script:", response);
    
            // Loop through each forum and send it to the API
            for (const forumData of response) {
              const { forum, topics } = forumData; // Ensure proper destructuring
              logger.info("[background.js] Forum object being processed:", forum);

              if (!forum) {
                logger.error("[background.js] Invalid forum data:", forumData);
                continue;
              }

              try {
                // Prepare the API payload
                const payload = {
                  forum: {
                    name: forum.name,
                    link: forum.link,
                    type: forum.type,
                    faction: forum.faction,
                  },
                  topics: topics.map((topic) => ({
                    name: topic.topicName,
                    link: topic.topicLink,
                    author: {
                      name: topic.topicAuthor, // Only name available from content.js
                    },
                    messages: topic.messages.map((message) => ({
                      author: {
                        name: message.author.name, // Include the author's name
                        targetId: message.author.targetId, // Include the author's targetId
                      },
                      content: message.content,
                      date: message.date,
                    })),
                  })),
                };
    
                logger.info("[background.js] Sending forum data to API:", payload);
    
                // POST forum data to the API
                const apiResponse = await fetch("http://localhost:3001/api/forums", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                });
    
                if (apiResponse.ok) {
                  logger.info("[background.js] Forum data successfully sent to API:", forum.forumName);
                } else {
                  logger.error(
                    "[background.js] Failed to send forum data to API:",
                    forum.forumName,
                    await apiResponse.text()
                  );
                }
              } catch (error) {
                logger.error("[background.js] Error sending forum data to API:", forum.forumName, error);
              }
            }
          } else if (response?.error) {
            logger.error("[background.js] Error received from content script:", response.error);
          } else {
            logger.error("[background.js] No forum data received from content script");
          }
        });
      });
      break;

    case "FETCH_FORUM_RP":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          logger.error("[background.js] No active tab found");
          return;
        }
    
        chrome.tabs.sendMessage(tabs[0].id, { type: "FETCH_FORUM_RP" }, async (response) => {
          if (chrome.runtime.lastError) {
            logger.error("[background.js] Error communicating with content script:", chrome.runtime.lastError.message);
            return;
          }
    
          if (response?.length) {
            logger.info("[background.js] RP forum data received from content script:", response);
    
            // Loop through each RP forum and send it to the API
            for (const forumData of response) {
              const { forum, topics } = forumData;
    
              if (!forum) {
                logger.error("[background.js] Invalid forum data:", forumData);
                continue;
              }
    
              logger.info("[background.js] Processing RP forum object:", forum);
    
              try {
                // Prepare the API payload
                const payload = {
                  forum: {
                    name: forum.name,
                    link: forum.link,
                    type: forum.type,
                    faction: forum.faction,
                  },
                  topics: topics.map((topic) => ({
                    name: topic.topicName,
                    link: topic.topicLink,
                    author: {
                      name: topic.topicAuthor, // Only name available from content.js
                    },
                    messages: topic.messages.map((message) => ({
                      author: {
                        name: message.author.name, // Include the author's name
                        targetId: message.author.targetId, // Include the author's targetId
                      },
                      content: message.content,
                      date: message.date,
                    })),
                  })),
                };
    
                logger.info("[background.js] Sending RP forum data to API:", payload);
    
                // POST forum data to the API
                const apiResponse = await fetch("http://localhost:3001/api/forums", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                });
    
                if (apiResponse.ok) {
                  logger.info("[background.js] RP forum data successfully sent to API:", forum.name);
                } else {
                  logger.error(
                    "[background.js] Failed to send RP forum data to API:",
                    forum.name,
                    await apiResponse.text()
                  );
                }
              } catch (error) {
                logger.error("[background.js] Error sending RP forum data to API:", forum.name, error);
              }
            }
          } else if (response?.error) {
            logger.error("[background.js] Error received from content script:", response.error);
          } else {
            logger.error("[background.js] No RP forum data received from content script");
          }
        });
      });
      break;

    case "FETCH_RANKINGS":
      chrome.tabs.query({}, (tabs) => {
        if (tabs.length === 0) {
          logger.error("[background.js] No tabs found");
          return;
        }

        // Try to find Age of Olympia tab first
        let targetTab = tabs.find(tab => tab.url?.includes('age-of-olympia.net'));
        if (!targetTab) {
          targetTab = tabs[0];
        }

        // Navigate to rankings page and fetch data
        chrome.tabs.update(targetTab.id, { url: 'https://age-of-olympia.net/classements.php' }, (updatedTab) => {
          chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
            if (tabId === updatedTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              
              chrome.tabs.sendMessage(updatedTab.id, { type: "FETCH_RANKINGS" }, async (response) => {
                if (chrome.runtime.lastError) {
                  logger.error("[background.js] Error:", chrome.runtime.lastError.message);
                  return;
                }

                if (response?.rankings) {
                  logger.info("[background.js] Rankings received from content script:", response.rankings);
                  await handleRankings(response.rankings);
                } else {
                  logger.error("[background.js] No rankings received from content script");
                }
              });
            }
          });
        });
      });
      return true;

    case "FETCH_REPUTATION":
      if (!loginState.playerId) {
        logger.error("[background.js] Cannot fetch reputation: playerId unknown. Make sure you're logged in.");
        sendResponse && sendResponse({ error: 'Not logged in or playerId missing' });
        return true;
      }

      chrome.tabs.query({}, (tabs) => {
        if (tabs.length === 0) {
          logger.error("[background.js] No tabs found");
          sendResponse && sendResponse({ error: 'No tabs found' });
          return;
        }

        // Prefer the Age of Olympia tab
        let targetTab = tabs.find(tab => tab.url?.includes('age-of-olympia.net')) || tabs[0];

        chrome.tabs.sendMessage(targetTab.id, { type: "FETCH_REPUTATION", targetId: loginState.playerId }, (response) => {
          if (chrome.runtime.lastError) {
            logger.error("[background.js] Error communicating with content script:", chrome.runtime.lastError.message);
            sendResponse && sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }

          if (response) {
            logger.info("[background.js] Reputation data received from content script:", response);
            sendResponse && sendResponse(response);
          } else {
            logger.error("[background.js] No reputation data received from content script");
            sendResponse && sendResponse({ error: 'No reputation data' });
          }
        });
      });
      return true;

    default:
      logger.warn(`[background.js] Unknown message type: ${message.type}`);
  }

});
