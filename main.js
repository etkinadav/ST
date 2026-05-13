const {
  app,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  screen,
  desktopCapturer,
  shell,
  dialog,
  BrowserWindow,
  ipcMain,
} = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { runOcrOnImage, formatOcrTextReport, stringifyRawResponse } = require('./googleVision.js');

const SHORTCUT = 'CommandOrControl+Shift+Z';
const CAPTURES_DIR = path.join(app.getPath('documents'), 'screen-translator-captures');

let tray = null;
/** @type {import('electron').BrowserWindow | null} */
let overlayWin = null;
/**
 * @type {{
 *   items: any[];
 *   screenshotImageWidth: number;
 *   screenshotImageHeight: number;
 *   overlayWidth: number;
 *   overlayHeight: number;
 *   scaleX: number;
 *   scaleY: number;
 * } | null}
 */
let overlayData = null;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function ensureCapturesDir() {
  fs.mkdirSync(CAPTURES_DIR, { recursive: true });
}

/** @param {string} pngPath e.g. .../screenshot-2026-05-12-10-00-00.png */
function ocrSidecarPaths(pngPath) {
  const base = path.basename(pngPath, '.png');
  const dir = path.dirname(pngPath);
  return {
    jsonPath: path.join(dir, `${base}.ocr.json`),
    txtPath: path.join(dir, `${base}.ocr.txt`),
  };
}

async function runOcrForScreenshot(pngPath, imageDims) {
  console.log('OCR started', pngPath);
  const ocr = await runOcrOnImage(pngPath);
  if (!ocr.success) {
    console.error('OCR error', ocr.error, ocr.code != null ? `(code ${ocr.code})` : '');
    return;
  }

  const { jsonPath, txtPath } = ocrSidecarPaths(pngPath);

  try {
    fs.writeFileSync(jsonPath, stringifyRawResponse(ocr.rawResponse), 'utf8');
    console.log('OCR JSON saved', jsonPath);
  } catch (err) {
    console.error('OCR error', 'failed to write JSON:', err.message || err);
    return;
  }

  try {
    fs.writeFileSync(txtPath, formatOcrTextReport(ocr.rawResponse), 'utf8');
    console.log('OCR TXT saved', txtPath);
  } catch (err) {
    console.error('OCR error', 'failed to write TXT:', err.message || err);
    return;
  }

  console.log('OCR finished', pngPath);

  try {
    const annotations = (ocr.rawResponse && ocr.rawResponse.textAnnotations) || [];
    // textAnnotations[0] is the full block; the rest are individual items.
    const items = annotations.slice(1);
    showOverlay(items, imageDims);
  } catch (err) {
    console.error('Overlay error', err.message || err);
  }
}

function closeOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close();
  }
}

function showOverlay(items, imageDims) {
  closeOverlay();

  const primary = screen.getPrimaryDisplay();
  const { bounds, workArea } = primary;

  const screenshotW = imageDims && imageDims.width ? imageDims.width : bounds.width;
  const screenshotH = imageDims && imageDims.height ? imageDims.height : bounds.height;

  const overlayWidth = bounds.width;
  const overlayHeight = bounds.height;
  const scaleX = overlayWidth / Math.max(1, screenshotW);
  const scaleY = overlayHeight / Math.max(1, screenshotH);

  console.log('Overlay display bounds', JSON.stringify(bounds));
  console.log('Overlay display workArea', JSON.stringify(workArea));
  console.log('Overlay screenshot image size', screenshotW, screenshotH);
  console.log('Overlay scaleX', scaleX, 'scaleY', scaleY);

  overlayData = {
    items: items || [],
    screenshotImageWidth: screenshotW,
    screenshotImageHeight: screenshotH,
    overlayWidth,
    overlayHeight,
    scaleX,
    scaleY,
  };

  overlayWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setMenuBarVisibility(false);

  overlayWin.on('closed', () => {
    overlayWin = null;
    overlayData = null;
    console.log('Overlay closed');
  });

  overlayWin.once('ready-to-show', () => {
    overlayWin.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
    overlayWin.show();
    overlayWin.focus();
    console.log('Overlay opened');
  });

  overlayWin.loadFile(path.join(__dirname, 'overlay.html')).catch((err) => {
    console.error('Overlay error', 'failed to load overlay.html:', err.message || err);
  });
}

ipcMain.handle('overlay:get-data', () => overlayData);
ipcMain.on('overlay:ready', (_event, count) => {
  console.log('Overlay items displayed', count);
});
ipcMain.on('overlay:close', () => closeOverlay());

async function takeScreenshot() {
  try {
    ensureCapturesDir();

    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;
    const scale = primary.scaleFactor || 1;
    const imageWidth = Math.round(width * scale);
    const imageHeight = Math.round(height * scale);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: imageWidth,
        height: imageHeight,
      },
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available');
    }

    const primaryId = String(primary.id);
    const source = sources.find((s) => s.display_id === primaryId) || sources[0];

    const pngBuffer = source.thumbnail.toPNG();
    if (!pngBuffer || pngBuffer.length === 0) {
      throw new Error('Captured image was empty');
    }

    const { width: actualW, height: actualH } = nativeImage.createFromBuffer(pngBuffer).getSize();

    const filename = `screenshot-${timestamp()}.png`;
    const filepath = path.join(CAPTURES_DIR, filename);
    fs.writeFileSync(filepath, pngBuffer);

    console.log('Screenshot saved', filepath);

    await runOcrForScreenshot(filepath, { width: actualW, height: actualH });

    return filepath;
  } catch (err) {
    console.error('[error] Screenshot failed:', err);
    try {
      dialog.showErrorBox('Screenshot failed', String((err && err.message) || err));
    } catch (_) {
      // ignore dialog errors
    }
    return null;
  }
}

// Build a small 16x16 PNG in memory so the project has no binary assets.
// Dark blue square with a lighter inner rectangle (a tiny "screen" glyph).
function makeTrayIcon() {
  const size = 16;
  const channels = 4;
  const stride = 1 + size * channels;
  const raw = Buffer.alloc(size * stride);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // PNG filter: None
    for (let x = 0; x < size; x++) {
      const off = y * stride + 1 + x * channels;
      let r = 30;
      let g = 60;
      let b = 120;
      const a = 255;
      const inner = x >= 3 && x <= 12 && y >= 4 && y <= 11;
      if (inner) {
        r = 235;
        g = 235;
        b = 240;
      }
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = (crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);

  const pngBuffer = Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return nativeImage.createFromBuffer(pngBuffer);
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Screen Translator');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Take Screenshot Now',
      click: () => {
        void takeScreenshot();
      },
    },
    {
      label: 'Open Captures Folder',
      click: async () => {
        ensureCapturesDir();
        const result = await shell.openPath(CAPTURES_DIR);
        if (result) {
          console.error('[error] Could not open captures folder:', result);
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => tray.popUpContextMenu());
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.screen-translator.mvp');
}

app.whenReady().then(() => {
  console.log('[start] Screen Translator started');
  console.log(`[info] Captures folder: ${CAPTURES_DIR}`);

  try {
    ensureCapturesDir();
  } catch (err) {
    console.error('[error] Failed to create captures folder:', err);
  }

  const registered = globalShortcut.register(SHORTCUT, () => {
    void takeScreenshot();
  });
  if (registered) {
    console.log(`[ok] Global shortcut registered: ${SHORTCUT}`);
  } else {
    console.error(`[error] Failed to register global shortcut: ${SHORTCUT}`);
  }

  try {
    createTray();
  } catch (err) {
    console.error('[error] Failed to create tray:', err);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Tray-only app: don't quit when there are no windows.
app.on('window-all-closed', () => {
  // intentionally left blank
});
