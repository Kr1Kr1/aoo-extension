# Age of Olympia Data Scraper

A Chrome extension designed to scrape and organize data from the **Age of Olympia** game, providing players with valuable insights and tools for better strategy (or not).

## 📖 Overview

The **Age of Olympia Data Scraper** simplifies the process of gathering in-game data, such as resources, rankings, territories, and character stats. The tool allows players to save data locally or export it for further analysis.

### Features

- **Automated Data Scraping**: Collect data directly from the game interface in real-time.
- **Customizable Data Capture**: Choose specific data points to scrape.
- **Data Export**: Send results to aoo-tracker API
- **User-Friendly Interface**: Start, pause, or stop scraping with intuitive controls.
- **Secure and Private**: All operations run locally in the browser, ensuring privacy.

### Moteur local (http://localhost:9000)

L'extension tourne aussi sur l'instance locale du jeu (docker, cf. `aoo-engine`),
mais elle n'y remonte **que la carte** : le décor arpenté, jamais les positions,
ni les stats, ni les forums, ni les missives (tout le reste y est de la donnée
de dev). Une seule joueuse y est suivie, `LOCAL_ENGINE_PLAYER` dans
`background.js` ; toute autre persona repart sans rien envoyer. Les relevés
partent avec l'en-tête `X-AOO-Source: local-engine`, que le tracker refuse
partout ailleurs que sur l'ingestion de carte (cf. `middleware.ts` et
`lib/api.ts` dans aoo-tracker).

---

## 🛠️ Installation

To install the **Age of Olympia Data Scraper**:

1. **Clone or download the repository**:
```bash
git clone https://github.com/yourusername/age-of-olympia-scraper.git
```

2. **Enable Developer Mode in Chrome**:

Open Google Chrome and go to chrome://extensions.
Enable "Developer mode" by toggling the switch in the top-right corner

3. **Load the extension**:

Click "Load unpacked" and select the folder where the extension files are located.
The extension will now appear in your Chrome toolbar.
