# game-plan-auto-browser

Launches real Chrome through `puppeteer-real-browser` (optionally via a rotating
proxy pool), opens ConnectCDK Unify, follows the SSO redirect to the login page,
reports where it landed, and closes the browser.

## Requirements

| | |
|---|---|
| Node.js | 18.17+ (20 LTS recommended) — `node -v` |
| Google Chrome | **must be installed.** This drives your system Chrome; it does *not* download its own Chromium like plain puppeteer. |
| OS | Windows / macOS / Linux. On Linux you also need `Xvfb` (`sudo apt install xvfb`); on Windows and macOS it is disabled automatically. |

## Setup (PowerShell)

```powershell
cd D:\game-plan-auto-browser

npm install

copy .env.example .env
notepad .env          # fill in the proxy, or set PROXY_HOST_CONNECTCDK=direct
notepad proxies.txt   # if using the file-based pool
```

## Run

```powershell
npm start                     # normal run, proxy from .env
npm run direct                # force a direct connection (no proxy)
npm run headless              # headless — debug only, detection is worse
node index.js --keep-open 30  # hold the window open 30s before closing
```

Flags are used instead of env prefixes because `HEADLESS=true node index.js` is
bash syntax and fails in PowerShell.

## What a good run looks like

```
  [  0.0s] Routing connectcdk through proxy 45.38.107.97:6014 (1 of 10 in the pool)
  [  2.4s] Opening the applications URL
  [  3.1s] nav https://app-unify.app.connectcdk.com/applications
  [  3.9s] Waiting for the redirect to the login page
  [  4.6s] nav https://.../authorize?client_id=...
────────────────────────────────────────────────────────────────────
  landed   : https://.../authorize?client_id=...
  detected : URL is an auth endpoint
────────────────────────────────────────────────────────────────────
  [  5.2s] Closing the browser
```

## Files

```
index.js            the run: navigate, wait for redirect, close
src/browser.js      the ONLY place Chrome is launched (proxy + launch gap)
.env                your config (gitignored)
proxies.txt         host:port:user:pass, one per line (gitignored)
```

## Two things not to change

**`customConfig` stays empty.** The tempting optimisation is a persistent
`userDataDir` so a solved bot-check survives between runs. It backfires:
`puppeteer-real-browser` prepares its own throwaway profile with the preferences
and flags that stop Chrome looking automated, and it expects to own that
directory. Pointing it at your own skips that preparation entirely, and Chrome
gets challenged on every attempt. The throwaway profile *is* the mechanism.

**`disableXvfb` is derived from `process.platform`.** Xvfb is an X11 virtual
display — it does not exist on Windows. Hard-coding `disableXvfb: false` makes
the launch hang or throw before Chrome starts.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Failed to launch the browser process` | Chrome not installed, or not on PATH |
| Page never loads, any URL | dead/unauthorised proxy — run `npm run direct` to confirm |
| `'HEADLESS=true' is not recognized` | bash syntax in PowerShell — use `npm run headless` |
| Timeout with `still at .../applications` | it rendered without redirecting; the tenant may already hold a session cookie, or the URL is wrong |
| Orphaned `chrome.exe` after a crash | `Get-Process chrome \| Stop-Process` |
