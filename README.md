# mega-discord-bot — Complete (Parts 1–5)

This is the **full 5-part project** (see the PRD/TRD document for background). What it does:

1. Watches `watched-folder/` for new `.zip` files (processed one at a time via an internal queue)
2. Extracts and re-packs each zip as an **AES-256 password-protected zip** (output in `watched-folder/encrypted/`)
3. Uploads the encrypted zip to **MEGA** and retrieves a public share link (retries 3x with backoff on failure)
4. Waits `uploadDelaySeconds` between files to avoid MEGA rate-limiting
5. Creates a **Discord text channel** named using `channelNameTemplate` (default `『🎐』|{name}`), with `@everyone` denied and `permissionRoleId` allowed to view/read/send (retries 3x on Discord rate limits)
6. Sends a **webhook message** into that channel with the zip name, MEGA link, and password, built from `messageTemplate`
7. Lets you **edit the message template live** via the `/settemplate` slash command (owner-only if `botOwnerId` is set)
8. Serves a **live GUI dashboard** (`http://localhost:3737` by default) showing every file's status in real time, with a Retry button for failures and an in-browser template editor
9. Tracks every file's progress in `state.json` (statuses: `pending → encrypting → uploading → uploaded → channel_created → message_sent`, or `failed`), and **resumes from wherever it left off** on retry instead of redoing completed steps

## Setupz

```bash
npm install
```

Edit `config/config.json`:
- `watchFolder` — folder to monitor (default: `./watched-folder`)
- `zipPasswordMode` — `"auto-random"` for a unique password per zip, or a fixed string
- `megaEmail` / `megaPassword` — your MEGA account login
- `uploadDelaySeconds` — seconds to wait between files (default 8)
- `discordToken` — your bot's token (Discord Developer Portal → Bot tab)
- `discordClientId` — your bot's **Application ID** (Developer Portal → General Information) — needed to register `/settemplate`
- `botOwnerId` — your Discord user ID; if set, only you can run `/settemplate`
- `guildId` — the server (guild) ID where channels should be created
- `categoryId` — the category ID under which new channels are created
- `permissionRoleId` — the role ID allowed to view the new channels
- `channelNameTemplate` — decorative wrapper for the channel name; `{name}` is replaced with the zip's filename (hyphenated). Default matches a `『emoji』|Name` style — edit the emoji/brackets to whatever you like
- `channelNameBoldStyle` — set to `true` to additionally render `{name}` in bold Unicode math characters; `false` keeps it as plain hyphenated text (Discord already bolds channel names in its own UI)
- `messageTemplate` — the message posted in each channel; supports `{name}`, `{link}`, `{password}`
- `guiPort` — port for the local dashboard (default 3737)

> Make sure your bot has **Manage Channels** and **Manage Webhooks** permissions in the server.

## Run

```bash
npm start
```

Drop a `.zip` file into `watched-folder/` — it gets encrypted, uploaded to MEGA, a styled channel is created, and a webhook message with the name/link/password is posted automatically. Check `state.json` for the tracked status of every file.

To change the message template anytime without restarting the bot, use `/settemplate` in Discord:
```
/settemplate template: **{name}** is ready!
🔗 {link}
🔑 {password}
```

## Project structure
```
mega-discord-bot/
├── config/config.json
├── watched-folder/          ← drop your zips here
│   └── encrypted/           ← auto-created; password-protected output zips land here
├── src/
│   ├── folderWatcher.js
│   ├── zipEncryptor.js
│   ├── megaUploader.js
│   ├── unicodeFormatter.js
│   ├── discordClient.js
│   ├── discordManager.js
│   ├── webhookSender.js
│   ├── commandHandler.js
│   ├── stateStore.js
│   ├── gui/
│   │   ├── server.js
│   │   └── public/index.html
│   ├── downloadEngine/
│   │   ├── index.js
│   │   ├── messageScanner.js
│   │   ├── linkExtractor.js
│   │   ├── downloadManager.js
│   │   └── scanState.js
│   ├── utils/
│   │   └── retry.js
│   └── index.js
├── downloads/                 ← download engine's staging folder (auto-created)
├── download-scan-state.json   ← auto-created; tracks scan progress + processed links
├── state.json                ← auto-created on first run
├── package.json
└── .gitignore
```

## Bugs fixed in the audit pass
- **Duplicate work on retry**: retrying a failed file used to redo every step from scratch (re-encrypt, re-upload, re-create channel). Now each step is skipped if already done, so retry resumes instead of duplicating MEGA uploads/Discord channels.
- **Duplicate queueing**: a file could get queued twice if detected twice in quick succession; now guarded with a `queuedFiles` set.
- **Surrogate-pair truncation bug**: channel names longer than 100 characters were truncated with a raw `.slice()`, which can cut a bold-Unicode or emoji character in half (all of them use 2-unit surrogate pairs), producing a broken glyph. Truncation is now done code-point by code-point.
- **Dashboard HTML injection**: the GUI table built rows via string-concatenated `innerHTML`, so a zip filename containing `<`, `"`, etc. could break the page or inject markup. Rewritten using DOM APIs (`textContent`/`createElement`), which auto-escape everything.
- **Silent post-login Discord errors**: only the very first Discord client error was ever handled (a one-time listener used for startup). Added a persistent listener so later errors are still logged instead of disappearing.
- Verified against current documentation: `megajs` upload callback shape, `discord.js` v14 webhook/channel/REST/slash-command syntax, and `guild.roles.everyone` usage all confirmed correct.

## Download Engine (archive recovery / migration)

A separate module that scans **your own** configured Discord channels for MEGA links already posted there, downloads + validates each file, and feeds it into the exact same pipeline described above (starting at the MEGA-upload step, since the recovered file is already an encrypted zip). This is meant for backing up, migrating, or reorganizing content you already own — it only ever touches the guild/channel IDs you explicitly configure.

**How it works:**
1. **Backfill** — walks a channel's full history backwards (resumable — safe to stop/restart mid-scan), extracting every MEGA link + nearby password + suggested filename from each message.
2. **Forward-poll** — after backfill finishes, checks for new messages every `scanIntervalMinutes`.
3. **Download** — each detected link is queued (respecting `concurrentDownloads`), downloaded via MEGA, and validated (non-zero size + intact zip structure). Failed downloads retry up to `retryCount` times before being marked failed and skipped — the engine moves on to the next file rather than getting stuck.
4. **Dedup** — every link is tracked in `download-scan-state.json`; the same link is never downloaded twice, even across restarts.
5. **Ingestion** — a successfully downloaded zip is moved into `watched-folder/encrypted/` and handed to the normal pipeline, which re-uploads it to MEGA, creates a styled channel, and posts the message — reusing the existing upload logic unchanged.

**Enable it** in `config/config.json` under `downloadEngine`:
```json
"downloadEngine": {
  "enabled": true,
  "sourceGuildId": "YOUR_SERVER_ID",
  "sourceChannelIds": ["CHANNEL_ID_1", "CHANNEL_ID_2"],
  "downloadFolder": "./downloads",
  "concurrentDownloads": 2,
  "retryCount": 3,
  "timeoutMs": 120000,
  "scanIntervalMinutes": 30
}
```
- `sourceGuildId` / `sourceChannelIds` — only these channels are ever scanned
- `downloadFolder` — staging area for in-progress downloads (kept separate from `watched-folder/`)
- `concurrentDownloads` — how many files download in parallel
- `retryCount` — retries per failed download before giving up on it
- `timeoutMs` — per-download timeout in milliseconds
- `scanIntervalMinutes` — how often to check for new messages after the initial backfill completes

**Controls:** the dashboard's Download Engine section has Pause / Resume / Cancel-queue buttons. Cancel clears anything not yet started; downloads already in progress finish normally.

**Known limitations (by design, not oversights):**
- MEGA **folder** links aren't downloaded (only single-file links) — these are logged and skipped rather than guessed at.
- Password extraction is a best-effort text match (`password: xyz` style patterns near the link). If a message doesn't clearly state one, the file is re-posted without a password and a warning is logged — worth spot-checking those particular ones.
- The bot needs **Read Message History** permission in every source channel.
