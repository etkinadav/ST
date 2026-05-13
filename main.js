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
const { runOcrOnImageBuffer, formatOcrTextReport, stringifyRawResponse, buildLineOverlayItems, getOcrMode } = require('./googleVision.js');
const { translateOcrLineItems, DEFAULT_TARGET_LANGUAGE, initTranslateService } = require('./translateService.js');

const SHORTCUT = 'CommandOrControl+Shift+Z';
const CAPTURES_DIR = path.join(app.getPath('documents'), 'screen-translator-captures');
const DEBUG_OCR = String(process.env.DEBUG_OCR || '').toLowerCase() === 'true';

let tray = null;
/** @type {import('electron').BrowserWindow | null} */
let overlayWin = null;
/**
 * @type {{
 *   loading?: boolean;
 *   errorMessage?: string | null;
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

function perfDetail(label, extra) {
  if (extra !== undefined) {
    console.log(`[perf-detail] ${label}`, extra);
  } else {
    console.log(`[perf-detail] ${label}`);
  }
}

/** @param {{ t0: number; _last?: number }} perf */
function perfLap(perf, label) {
  const now = performance.now();
  if (perf._last == null) perf._last = perf.t0;
  const delta = now - perf._last;
  perf._last = now;
  console.log(`[perf] ${label}: ${delta.toFixed(1)}ms (cumulative ${(now - perf.t0).toFixed(1)}ms)`);
}

function notifyOverlayUpdate() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:update');
  }
}

/**
 * Open fullscreen overlay with "Translating..." before OCR completes.
 * @param {{ width: number; height: number }} imageDims
 * @param {{ t0: number; _last?: number }} perf
 */
function openOverlayLoadingWindow(imageDims, perf) {
  perfDetail('overlay_open_start', {
    imageDimsW: imageDims && imageDims.width,
    imageDimsH: imageDims && imageDims.height,
  });

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
    loading: true,
    errorMessage: null,
    items: [],
    screenshotImageWidth: screenshotW,
    screenshotImageHeight: screenshotH,
    overlayWidth,
    overlayHeight,
    scaleX,
    scaleY,
  };

  perfDetail('overlay_loading_payload_ready', {
    screenshotW,
    screenshotH,
    overlayWidth,
    overlayHeight,
  });

  const tBw = performance.now();
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

  perfDetail('overlay_browserwindow_construct_ms', (performance.now() - tBw).toFixed(1));

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
    perfLap(perf, 'overlay_window_visible');
    console.log('Overlay opened (loading)');
  });

  overlayWin
    .loadFile(path.join(__dirname, 'overlay.html'))
    .then(() => {
      perfLap(perf, 'overlay_html_loaded');
    })
    .catch((err) => {
      console.error('Overlay error', 'failed to load overlay.html:', err.message || err);
    });
}

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

/**
 * Downscale screenshot for OCR upload: longest edge ≤ maxEdge, JPEG.
 * Cuts Vision RPC time by reducing bytes-on-wire and pixels-to-scan.
 * @param {Buffer} pngBuffer
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} maxEdge
 * @param {number} jpegQuality 0-100
 * @returns {{ buffer: Buffer; width: number; height: number; format: 'jpeg' | 'png'; bytes: number }}
 */
function downscaleToJpegForOcr(pngBuffer, srcW, srcH, maxEdge, jpegQuality) {
  const longest = Math.max(srcW, srcH);
  if (!Number.isFinite(maxEdge) || maxEdge <= 0 || longest <= maxEdge) {
    let buffer = pngBuffer;
    let format = 'png';
    try {
      const img = nativeImage.createFromBuffer(pngBuffer);
      const jpeg = img.toJPEG(Math.max(1, Math.min(100, jpegQuality || 82)));
      if (jpeg && jpeg.length > 0 && jpeg.length < pngBuffer.length) {
        buffer = jpeg;
        format = 'jpeg';
      }
    } catch (_) {
      // keep PNG fallback
    }
    return { buffer, width: srcW, height: srcH, format, bytes: buffer.length };
  }

  const ratio = maxEdge / longest;
  const targetW = Math.max(1, Math.round(srcW * ratio));
  const targetH = Math.max(1, Math.round(srcH * ratio));
  try {
    const img = nativeImage.createFromBuffer(pngBuffer);
    const resized = img.resize({ width: targetW, height: targetH, quality: 'good' });
    const size = resized.getSize();
    const jpeg = resized.toJPEG(Math.max(1, Math.min(100, jpegQuality || 82)));
    if (jpeg && jpeg.length > 0) {
      return { buffer: jpeg, width: size.width, height: size.height, format: 'jpeg', bytes: jpeg.length };
    }
  } catch (err) {
    console.error('[error] OCR downscale failed; sending raw PNG:', err.message || err);
  }
  return { buffer: pngBuffer, width: srcW, height: srcH, format: 'png', bytes: pngBuffer.length };
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

function closeOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close();
  }
}

ipcMain.handle('overlay:get-data', () => overlayData);
ipcMain.on('overlay:ready', (_event, payload) => {
  if (payload && typeof payload === 'object') {
    console.log(
      `[perf] overlay_render phase=${payload.phase} render_ms=${
        typeof payload.renderMs === 'number' && Number.isFinite(payload.renderMs)
          ? payload.renderMs.toFixed(1)
          : '?'
      }`,
    );
    if (payload.phase === 'content') {
      console.log('Overlay items displayed', payload.count);
    }
  } else {
    console.log('Overlay items displayed', payload);
  }
});
ipcMain.on('overlay:close', () => closeOverlay());

async function takeScreenshot() {
  closeOverlay();
  const perf = { t0: performance.now() };
  perf._last = perf.t0;

  try {
    if (DEBUG_OCR) {
      ensureCapturesDir();
    }

    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;
    const scale = primary.scaleFactor || 1;
    const imageWidth = Math.round(width * scale);
    const imageHeight = Math.round(height * scale);
    perfDetail('capture_thumbnail_request', `${imageWidth}x${imageHeight} dipLogical=${width}x${height} scaleFactor=${scale}`);

    const tSources = performance.now();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: imageWidth,
        height: imageHeight,
      },
    });
    perfDetail('capture_getSources_ms', (performance.now() - tSources).toFixed(1));

    if (sources.length === 0) {
      throw new Error('No screen sources available');
    }

    const primaryId = String(primary.id);
    const tPick = performance.now();
    const source = sources.find((s) => s.display_id === primaryId) || sources[0];
    perfDetail('capture_pick_source_ms', (performance.now() - tPick).toFixed(1));

    const tPng = performance.now();
    const pngBuffer = source.thumbnail.toPNG();
    perfDetail('capture_toPNG_ms', (performance.now() - tPng).toFixed(1));

    if (!pngBuffer || pngBuffer.length === 0) {
      throw new Error('Captured image was empty');
    }
    perfDetail('capture_png_bytes', pngBuffer.length);

    const tSize = performance.now();
    const { width: actualW, height: actualH } = nativeImage.createFromBuffer(pngBuffer).getSize();
    perfDetail('capture_getSize_ms', (performance.now() - tSize).toFixed(1));
    perfDetail('capture_png_dimensions', `${actualW}x${actualH}`);

    perfLap(perf, 'screenshot_capture');

    // 960px max-edge = ~50% fewer pixels than 1280, measurably faster Vision RPC.
    // Override: OCR_MAX_EDGE=1280 for better quality, =800 for max speed.
    const ocrMaxEdge = Number(process.env.OCR_MAX_EDGE) || 960;
    // Lower quality = smaller payload with negligible OCR quality loss for UI text.
    const ocrJpegQuality = Number(process.env.OCR_JPEG_QUALITY) || 72;
    const ocr = downscaleToJpegForOcr(pngBuffer, actualW, actualH, ocrMaxEdge, ocrJpegQuality);
    const imageDims = { width: ocr.width, height: ocr.height };
    perfDetail('ocr_payload_dimensions', `${ocr.width}x${ocr.height} from ${actualW}x${actualH}`);
    perfDetail('ocr_payload_bytes', ocr.bytes);
    perfDetail('ocr_payload_format', ocr.format);
    perfLap(perf, 'ocr_payload_prepare');

    let filepath = null;
    if (DEBUG_OCR) {
      const filename = `screenshot-${timestamp()}.png`;
      filepath = path.join(CAPTURES_DIR, filename);
      fs.writeFileSync(filepath, pngBuffer);
      console.log('[debug] Screenshot saved', filepath);
      const ocrFilename = `ocr-${timestamp()}.${ocr.format === 'jpeg' ? 'jpg' : 'png'}`;
      const ocrPath = path.join(CAPTURES_DIR, ocrFilename);
      fs.writeFileSync(ocrPath, ocr.buffer);
      console.log('[debug] OCR payload saved', ocrPath);
      perfLap(perf, 'debug_image_save');
    } else {
      console.log('[perf] debug_image_save: skipped (DEBUG_OCR not true)');
    }

    openOverlayLoadingWindow(imageDims, perf);

    void (async () => {
      const primaryDisp = screen.getPrimaryDisplay();
      const { bounds } = primaryDisp;
      const screenshotW = imageDims.width;
      const screenshotH = imageDims.height;
      const overlayWidth = bounds.width;
      const overlayHeight = bounds.height;
      const scaleX = overlayWidth / Math.max(1, screenshotW);
      const scaleY = overlayHeight / Math.max(1, screenshotH);

      const safeNotify = (data) => {
        if (!overlayWin || overlayWin.isDestroyed()) {
          return;
        }
        overlayData = data;
        notifyOverlayUpdate();
      };

      try {
        perfDetail('pipeline_async_start', {
          ocrBytes: ocr.buffer.length,
          ocrFormat: ocr.format,
          imageDims: `${screenshotW}x${screenshotH}`,
        });
        console.log('OCR started', DEBUG_OCR && filepath ? filepath : '(memory only)');
        const ocrRes = await runOcrOnImageBuffer(ocr.buffer);
        if (ocrRes.success) {
          perfDetail('vision_ocr_mode_used', ocrRes.ocrMode || getOcrMode());
        }
        perfLap(perf, 'google_vision_ocr');

        if (ocrRes.success && ocrRes.rawResponse) {
          const fta = ocrRes.rawResponse.fullTextAnnotation;
          const ta = ocrRes.rawResponse.textAnnotations || [];
          perfDetail('vision_response_summary', {
            pages: fta && fta.pages ? fta.pages.length : 0,
            has_fullTextAnnotation: !!fta,
            fullText_char_len: fta && typeof fta.text === 'string' ? fta.text.length : 0,
            textAnnotations_count: ta.length,
          });
        }

        if (DEBUG_OCR && filepath && ocrRes.success) {
          const { jsonPath, txtPath } = ocrSidecarPaths(filepath);
          setImmediate(() => {
            try {
              fs.writeFileSync(jsonPath, stringifyRawResponse(ocrRes.rawResponse), 'utf8');
              console.log('[debug] OCR JSON saved', jsonPath);
            } catch (err) {
              console.error('OCR error', 'failed to write JSON:', err.message || err);
            }
            try {
              fs.writeFileSync(txtPath, formatOcrTextReport(ocrRes.rawResponse, imageDims), 'utf8');
              console.log('[debug] OCR TXT saved', txtPath);
            } catch (err) {
              console.error('OCR error', 'failed to write TXT:', err.message || err);
            }
          });
        }

        if (!ocrRes.success) {
          console.error('OCR error', ocrRes.error, ocrRes.code != null ? `(code ${ocrRes.code})` : '');
          safeNotify({
            loading: false,
            errorMessage: String(ocrRes.error || 'OCR failed'),
            items: [],
            screenshotImageWidth: screenshotW,
            screenshotImageHeight: screenshotH,
            overlayWidth,
            overlayHeight,
            scaleX,
            scaleY,
          });
          console.log(`[perf] total_ms: ${(performance.now() - perf.t0).toFixed(1)}`);
          return;
        }

        console.log('OCR finished', DEBUG_OCR && filepath ? filepath : '(memory)');

        const lineItems = buildLineOverlayItems(ocrRes.rawResponse, imageDims);
        perfDetail('ocr_line_groups_count', lineItems.length);
        perfLap(perf, 'ocr_parse_group');

        const targetLang = process.env.SCREEN_TRANSLATOR_TARGET_LANG || DEFAULT_TARGET_LANGUAGE;
        const overlayItems = await translateOcrLineItems(lineItems, { targetLanguageCode: targetLang });
        perfLap(perf, 'google_translate');

        const emptyMsg =
          overlayItems.length === 0 ? 'No Hebrew text found for translation.' : null;

        safeNotify({
          loading: false,
          errorMessage: emptyMsg,
          items: overlayItems,
          screenshotImageWidth: screenshotW,
          screenshotImageHeight: screenshotH,
          overlayWidth,
          overlayHeight,
          scaleX,
          scaleY,
        });
        perfDetail('overlay_hebrew_items_for_display', overlayItems.length);
        perfLap(perf, 'overlay_payload_notify');

        const ann = ocrRes.rawResponse && ocrRes.rawResponse.textAnnotations;
        const visionAnnotationCount = Array.isArray(ann) ? ann.length : 0;
        const totalMs = Number((performance.now() - perf.t0).toFixed(1));
        console.log('[perf] ocr_pipeline_summary', {
          ocr_mode: ocrRes.ocrMode,
          ocr_rpc_ms: ocrRes.ocrRpcMs != null ? Number(ocrRes.ocrRpcMs.toFixed(1)) : null,
          pipeline_total_ms: totalMs,
          vision_textAnnotations_count: visionAnnotationCount,
          ocr_grouped_items_count: lineItems.length,
          overlay_translated_items_count: overlayItems.length,
        });
        console.log(
          '[perf-detail] vision_quality_note',
          ocrRes.ocrMode === 'text'
            ? 'textDetection: typically faster RPC; Vision returns textAnnotations only (no fullText page hierarchy). Grouping uses the same app pipeline from boxes — bubble boundaries may differ vs documentTextDetection.'
            : 'documentTextDetection: fullTextAnnotation with pages/blocks/words; richer geometry, usually slower RPC.',
        );

        console.log(`[perf] total_ms: ${totalMs}`);
      } catch (err) {
        console.error('Pipeline error', err.message || err);
        safeNotify({
          loading: false,
          errorMessage: String((err && err.message) || err),
          items: [],
          screenshotImageWidth: screenshotW,
          screenshotImageHeight: screenshotH,
          overlayWidth,
          overlayHeight,
          scaleX,
          scaleY,
        });
        console.log(`[perf] total_ms: ${(performance.now() - perf.t0).toFixed(1)}`);
      }
    })();

    return DEBUG_OCR ? filepath : null;
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

app.whenReady().then(async () => {
  console.log('[start] Screen Translator started');
  console.log(`[info] Captures folder: ${CAPTURES_DIR}`);

  try {
    ensureCapturesDir();
  } catch (err) {
    console.error('[error] Failed to create captures folder:', err);
  }

  try {
    await initTranslateService();
  } catch (err) {
    console.error('[error] Translate service bootstrap failed:', err.message || err);
    console.error('[info] Set GOOGLE_CLOUD_PROJECT or run gcloud config set project; will retry on first translation.');
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
