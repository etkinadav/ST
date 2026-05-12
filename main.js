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
} = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SHORTCUT = 'CommandOrControl+Shift+Z';
const CAPTURES_DIR = path.join(app.getPath('documents'), 'screen-translator-captures');

let tray = null;

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

async function takeScreenshot() {
  try {
    ensureCapturesDir();

    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;
    const scale = primary.scaleFactor || 1;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(width * scale),
        height: Math.round(height * scale),
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

    const filename = `screenshot-${timestamp()}.png`;
    const filepath = path.join(CAPTURES_DIR, filename);
    fs.writeFileSync(filepath, pngBuffer);

    console.log(`[ok] Screenshot saved: ${filepath}`);
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
