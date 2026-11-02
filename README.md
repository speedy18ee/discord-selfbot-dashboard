# 🎵 Discord Selfbot Multi-Account 24/7 & Lavalink Music Dashboard

A Discord Selfbot Management Suite and Web Dashboard featuring **Multi-Account Support**, **Lavalink v4 Audio Streaming**, and **24/7 Voice Channel Stay** with auto-reconnection.

---

## ✨ Features

- **🌐 Web-Based Token Management (No `.env` required for tokens)**:
  - Add, test, and manage unlimited Discord selfbot accounts directly from the Web UI.
  - Set custom nicknames/labels for accounts (e.g. *Main Account*, *24/7 VC Bot*, *Lofi Bot*).
  - Persistent account, license, settings, and session storage in SQLite.
  - Per-account controls: Start, Stop, Delete, Status Changer (Online / Idle / DND / Invisible), and Custom Rich Presence.
  - Global One-Click **Start All** and **Stop All**.

- **🎙️ 24/7 Voice Channel Stay**:
  - Connect any bot to any Voice or Stage Channel.
  - Interactive Server & Voice Channel selector loaded dynamically from Discord.
  - **24/7 Keep-Alive**: Automatically reconnects if kicked, moved, or disconnected.
  - Configurable **Self-Mute** and **Self-Deafen** options.
  - Persists across computer reboots and server restarts.

- **⚡ Lavalink v4 Audio Engine ("Lava Lenin")**:
  - Pre-configured with the requested Lavalink node:
    - **URL:** `noi6.visihost.in:25591`
    - **Name:** `Lava Lenin`
    - **Auth:** `ganahubkl`
    - **Secure:** `false`
  - High-fidelity streaming with YouTube, Spotify, SoundCloud, and direct stream links.
  - Interactive playback controls: Play, Pause, Resume, Skip, Stop, and Click-to-Seek progress bar.
  - Audio tweaks: Volume slider (0 - 300%), Bass Boost EQ, Nightcore, Vaporwave, and 8D audio.
  - Full Queue Management: view upcoming tracks, remove individual tracks, or clear queue.

- **💻 Premium Glassmorphic Cyber Dark UI**:
  - Discord Blurple `#5865F2` theme with glass blur effects and animated visualizer waves.
  - Live statistics: Active accounts, voice connections, Lavalink memory & CPU load, and ping latency.
  - Real-time streaming WebSocket console logs with tag filtering (Bots, Voice, Lavalink, Errors).

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```

Node.js 22.13 or newer is required for the built-in SQLite driver. In production, set `SESSION_SECRET` to a long random value and set `ADMIN_PASSWORD` to a new admin password in the hosting panel's environment settings. Do not commit these values or put them in a public file.

The database is stored at `data/exc.sqlite` by default. Existing `data/*.json` records are imported into SQLite on first startup; keep the existing `data` folder when migrating licenses and accounts. Never deploy `.env` or commit runtime data.

### CloudWave hosting requirements

This application requires a Node.js 22.13+ runtime for its API, WebSocket server, and built-in SQLite driver. CloudWave PHP/HTML-only hosting cannot run the backend; use a Node.js-capable service or plan.

### 3. Open the Web Dashboard

Navigate to:
```
http://localhost:3000
```

---

## 📖 How to Add Accounts

1. Open `http://localhost:3000` in your browser.
2. Click the **"Add Account"** button in the top right header.
3. Paste your Discord user token and give it a nickname.
4. Click **"Connect Account"**. The bot will immediately log in and appear in your dashboard!
5. Head over to the **"24/7 Voice Stay"** tab to choose your server and voice channel, then flip the **24/7 Keep-Alive** switch.

---

## 🛡️ Architecture

```
├── server.js               # Express Server & WebSocket broadcaster
├── src/
│   ├── config.js           # Configuration loader
│   ├── database.js         # JSON persistent storage
│   ├── logger.js           # Centralized in-memory & broadcast logger
│   ├── botManager.js       # Multi-account selfbot controller & 24/7 watchdog
│   └── lavalinkClient.js   # Lavalink v4 WebSocket & REST audio player
├── public/
│   ├── index.html          # Single-Page Application UI
│   ├── css/style.css       # Premium dark glassmorphic styling
│   └── js/app.js           # Frontend reactive controller & WebSockets
└── data/                   # Persistent local storage for accounts & settings
```

---

## 🐳 Docker & Aiven Runtime Deployment

This repository includes full Docker containerization and Docker Compose specifications for deploying to **Aiven Runtime**, **Docker Compose**, **Kubernetes**, or any container platform.

### Quick Deploy with Docker Compose:
```bash
docker compose up -d --build
```

### Deploying to Aiven Runtime:
1. Push this repository to your Git provider (GitHub / GitLab).
2. In the Aiven Console, go to **Runtime** -> **Deploy application** or open:
   `https://console.aiven.io/account/{account_id}/project/{project_name}/runtime/compose`
3. Aiven automatically reads `compose.yaml` / `compose.aiven.yaml` and `Dockerfile` to build and deploy your containerized dashboard.

---

## ⚠️ Disclaimer

This project is created strictly for **educational, testing, and private research purposes**. Using selfbots or automating user accounts is against the **Discord Terms of Service** and may result in account termination. By using this software, you acknowledge that you are doing so entirely at your own risk. The authors and maintainers accept no liability for any damages or account sanctions.

For full terms, see [DISCLAIMER.md](DISCLAIMER.md).

---

## 📜 License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 EXC Development Team & Dhanush.

