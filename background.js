let loginState = { loggedIn: false, playerName: null, playerId: null, playerAvatar: null };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[background.js] Received message:", message);

  switch (message.type) {
    case "LOGIN_STATUS":
      if (message.loggedIn !== undefined) {
        loginState.loggedIn = message.loggedIn;

        if (message.loggedIn) {
          loginState.playerName = message.data?.playerName || "Unknown Player";
          loginState.playerId = message.data.playerId || null;
          console.log(`[background.js] Logged in as ${loginState.playerName}`);
        } else {
          console.log("[background.js] User is not logged in.");
        }
      } else {
        console.warn("[background.js] LOGIN_STATUS message missing 'loggedIn' property");
      }
      break;

    case "GET_LOGIN_STATUS":
      console.log("[background.js] Received GET_LOGIN_STATUS request");
      sendResponse(loginState);
      return true;

    case "FETCH_ATTRIBUTES":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          console.error("[background.js] No active tab found");
          return;
        }

        chrome.tabs.sendMessage(tabs[0].id, { type: "FETCH_ATTRIBUTES" }, async (response) => {
          if (chrome.runtime.lastError) {
            console.error("[background.js] Error communicating with content script:", chrome.runtime.lastError.message);
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }

          if (response?.attributes) {
            console.log("[background.js] Attributes received from content script:", response.attributes);

            if (!loginState.playerId) {
              console.error("[background.js] Player id not found in login state.");
              return;
            }

            const characterId = loginState.playerId;

            // Map keys to API expected format
            const mappedAttributes = {
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
            };

            try {
              const apiResponse = await fetch(`http://localhost:3001/api/characters/${characterId}/attributes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(mappedAttributes),
              });
  
              if (apiResponse.ok) {
                console.log("[background.js] Attributes successfully sent to API.");
              } else {
                console.error("[background.js] Failed to send attributes to API:");
              }
            } catch (error) {
              console.error("[background.js] Error sending attributes to API:");
            }
          } else if (response?.error) {
            console.error("[background.js] Error received from content script:");
          } else {
            console.error("[background.js] No attributes received from content script");
          }
        });
      });
      break;

    case "SAVE_STATS":
      chrome.storage.local.get({ history: [] }, (data) => {
        const updatedHistory = [...data.history, message.data];
        chrome.storage.local.set({ history: updatedHistory }, () => {
          console.log("[background.js] Stats saved:", message.data);
        });
      });
      break;

    case "FETCH_LOGS":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          console.error("[background.js] No active tab found");
          return;
        }

        chrome.tabs.sendMessage(tabs[0].id, { type: "FETCH_LOGS" }, (response) => {
          if (chrome.runtime.lastError) {
            console.error("[background.js] Error communicating with content script:", chrome.runtime.lastError.message);
            return;
          }

          if (response?.logs) {
            console.log("[background.js] Logs received from content script:", response.logs);

            // Ensure the playerId is available
            if (!loginState.playerId) {
              console.error("[background.js] Player ID not found in login state.");
              return;
            }
            const playerId = loginState.playerId;

            response.logs.forEach(async (log) => {
              const { event, details, from, withWhom, date, territory, source } = log;

              if (!event || !from || !date) {
                console.warn("[background.js] Skipping invalid log:", log);
                return;
              }

              try {
                const res = await fetch("http://localhost:3001/api/events", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    event,
                    details,
                    fromCol: from,
                    withWhom, 
                    date,
                    territory,
                    source,
                    playerId,
                  }),
                });

                if (res.ok) {
                  console.log("[background.js] Log successfully sent to API:", log);
                } else {
                  console.error("[background.js] Failed to send log to API:", log, await res.text());
                }
              } catch (error) {
                console.error("[background.js] Error sending log to API:", error);
              }
            });
          } else if (response?.error) {
            console.error("[background.js] Error received from content script:", response.error);
          } else {
            console.error("[background.js] No logs received from content script");
          }
        });
      });
      break;

    case "FETCH_ALL_CHARACTERS":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          console.error("[background.js] No active tab found");
          return;
        }

        chrome.tabs.sendMessage(tabs[0].id, { type: "FETCH_ALL_CHARACTERS" }, (response) => {
          if (chrome.runtime.lastError) {
            console.error("[background.js] Error communicating with content script:", chrome.runtime.lastError.message);
            return;
          }

          if (response?.characters) {
            console.log("[background.js] Characters received from content script:", response.characters);

            response.characters.forEach(async (character) => {
              try {
                const { mdj, story, equipment, ...characterData } = character;

                const existingCharacterRes = await fetch(`http://localhost:3001/api/characters/${characterData.targetId}`);
                let existingCharacter = null;

                if (existingCharacterRes.ok) {
                  existingCharacter = await existingCharacterRes.json();
                  console.log(`[background.js] Existing character found:`, existingCharacter);
                } else {
                  console.log(`[background.js] Character does not exist, creating new character:`, characterData);
                }

                const method = existingCharacter ? "PATCH" : "POST";
                const endpoint = `http://localhost:3001/api/characters${existingCharacter ? `/${characterData.targetId}` : ""}`;

                console.log(`[background.js] Endpoint & method:`, endpoint, method);
                const res = await fetch(endpoint, {
                  method,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(characterData),
                });

                if (res.ok) {
                  console.log(`[background.js] Character successfully ${existingCharacter ? "updated" : "created"}:`, character);
                } else {
                  console.error(`[background.js] Failed to ${existingCharacter ? "update" : "create"} character:`, character, await res.text());
                }

                if (mdj !== null) {
                  try {
                    const mdjRes = await fetch(`http://localhost:3001/api/characters/${characterData.targetId}/mdj`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ mdj }),
                    });

                    if (mdjRes.ok) {
                      console.log(`[background.js] MDJ successfully sent for character ${characterData.targetId}: ${mdj}`);
                    } else {
                      console.error(`[background.js] Failed to send MDJ for character ${characterData.targetId}:`, await mdjRes.text());
                    }
                  } catch (error) {
                    console.error(`[background.js] Error sending MDJ for character ${characterData.targetId}:`, error);
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
                      console.log(`[background.js] History successfully sent for character ${characterData.targetId}: ${story}`);
                    } else {
                      console.error(`[background.js] Failed to send history for character ${characterData.targetId}:`, await historyRes.text());
                    }
                  } catch (error) {
                    console.error(`[background.js] Error sending history for character ${characterData.targetId}:`, error);
                  }
                }

                if (equipment !== undefined && equipment !== null) {
                  try {
                    const equipmentRes = await fetch(`http://localhost:3001/api/characters/${characterData.targetId}/equipment`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ equipment }),
                    });
    
                    if (equipmentRes.ok) {
                      console.log(`[background.js] Equipment successfully sent for character ${characterData.targetId}:`, equipment);
                    } else {
                      console.error(`[background.js] Failed to send equipment for character ${characterData.targetId}:`, await equipmentRes.text());
                    }
                  } catch (error) {
                    console.error(`[background.js] Error sending equipment for character ${characterData.targetId}:`, error);
                  }
                } else {
                  console.log(`[background.js] Equipment is not defined for character ${characterData.targetId}. Skipping.`);
                }

              } catch (error) {
                console.error("[background.js] Error processing character data:", error);
              }
            });
          } else if (response?.error) {
            console.error("[background.js] Error received from content script:", response.error);
          } else {
            console.error("[background.js] No characters received from content script");
          }
        });
      });
      break;

    case "FETCH_FORUM_PRIVATE":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          console.error("[background.js] No active tab found");
          return;
        }
    
        chrome.tabs.sendMessage(tabs[0].id, { type: "FETCH_FORUM_PRIVATE" }, async (response) => {
          if (chrome.runtime.lastError) {
            console.error("[background.js] Error communicating with content script:", chrome.runtime.lastError.message);
            return;
          }
    
          if (response?.length) {
            console.log("[background.js] Forum data received from content script:", response);
    
            // Loop through each forum and send it to the API
            for (const forumData of response) {
              const { forum, topics } = forumData; // Ensure proper destructuring
              console.log("[background.js] Forum object being processed:", forum);

              if (!forum) {
                console.error("[background.js] Invalid forum data:", forumData);
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
    
                console.log("[background.js] Sending forum data to API:", payload);
    
                // POST forum data to the API
                const apiResponse = await fetch("http://localhost:3001/api/forums", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                });
    
                if (apiResponse.ok) {
                  console.log("[background.js] Forum data successfully sent to API:", forum.forumName);
                } else {
                  console.error(
                    "[background.js] Failed to send forum data to API:",
                    forum.forumName,
                    await apiResponse.text()
                  );
                }
              } catch (error) {
                console.error("[background.js] Error sending forum data to API:", forum.forumName, error);
              }
            }
          } else if (response?.error) {
            console.error("[background.js] Error received from content script:", response.error);
          } else {
            console.error("[background.js] No forum data received from content script");
          }
        });
      });
      break;

    case "FETCH_FORUM_RP":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          console.error("[background.js] No active tab found");
          return;
        }
    
        chrome.tabs.sendMessage(tabs[0].id, { type: "FETCH_FORUM_RP" }, async (response) => {
          if (chrome.runtime.lastError) {
            console.error("[background.js] Error communicating with content script:", chrome.runtime.lastError.message);
            return;
          }
    
          if (response?.length) {
            console.log("[background.js] RP forum data received from content script:", response);
    
            // Loop through each RP forum and send it to the API
            for (const forumData of response) {
              const { forum, topics } = forumData;
    
              if (!forum) {
                console.error("[background.js] Invalid forum data:", forumData);
                continue;
              }
    
              console.log("[background.js] Processing RP forum object:", forum);
    
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
    
                console.log("[background.js] Sending RP forum data to API:", payload);
    
                // POST forum data to the API
                const apiResponse = await fetch("http://localhost:3001/api/forums", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                });
    
                if (apiResponse.ok) {
                  console.log("[background.js] RP forum data successfully sent to API:", forum.name);
                } else {
                  console.error(
                    "[background.js] Failed to send RP forum data to API:",
                    forum.name,
                    await apiResponse.text()
                  );
                }
              } catch (error) {
                console.error("[background.js] Error sending RP forum data to API:", forum.name, error);
              }
            }
          } else if (response?.error) {
            console.error("[background.js] Error received from content script:", response.error);
          } else {
            console.error("[background.js] No RP forum data received from content script");
          }
        });
      });
      break;

    default:
      console.warn(`[background.js] Unknown message type: ${message.type}`);
  }

});
