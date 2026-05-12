# Screen Translator — Step 1 (MVP)

A tiny tray-only Electron app. Press a global shortcut, get a PNG of your primary screen saved to a folder.

This is **only step 1**. No OCR, no translation, no overlay yet.

## What it does

- Runs in the background with a small tray icon.
- Registers the global shortcut **`Ctrl + Shift + Z`**.
- On shortcut (or via the tray menu), captures the **primary display** and saves it as PNG to:

  `Documents\screen-translator-captures\screenshot-YYYY-MM-DD-HH-mm-ss.png`

- Tray menu:
  - **Take Screenshot Now**
  - **Open Captures Folder**
  - **Quit**

## Requirements

- Node.js 18 or newer
- npm

## Run it locally

From this folder:

```bash
npm install
npm start
```

On first run, look in the system tray (bottom-right on Windows, you may need to click the `^` arrow). You should see a small tile icon. Right-click it for the menu.

Then press `Ctrl + Shift + Z` anywhere — a PNG will appear in `Documents\screen-translator-captures`.

## Console logs

You'll see logs in the terminal where you ran `npm start`:

- `[start] Screen Translator started`
- `[info] Captures folder: ...`
- `[ok] Global shortcut registered: CommandOrControl+Shift+Z`
- `[ok] Screenshot saved: ...`
- `[error] ...` on failures

## Troubleshooting

- **Shortcut didn't register** — Another app is probably using `Ctrl+Shift+Z`. Close it or change `SHORTCUT` in `main.js`.
- **Tray icon not visible** — On Windows, expand the hidden icons tray (the `^` arrow). You can pin it to make it always visible.
- **Black screenshot** — Some DRM-protected windows (e.g. Netflix) will show as black. That's a platform limitation of the underlying capture API.

## Files

- `main.js` — entire app (tray, shortcut, capture)
- `package.json` — Electron dependency and `npm start` script

That's it. Keep it small until step 2.
