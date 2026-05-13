/**
 * Google Cloud Vision OCR via Application Default Credentials (ADC).
 * Use: gcloud auth application-default login
 * Do not set GOOGLE_APPLICATION_CREDENTIALS or keyFilename.
 */

const fs = require('fs');
const vision = require('@google-cloud/vision');

let client;

function getClient() {
  if (!client) {
    client = new vision.ImageAnnotatorClient();
  }
  return client;
}

function formatVertices(vertices) {
  if (!vertices || vertices.length === 0) {
    return '(no vertices)';
  }
  return vertices.map((v) => `(${v.x ?? 0}, ${v.y ?? 0})`).join(' → ');
}

/**
 * @param {{ vertices?: { x?: number; y?: number }[]; normalizedVertices?: { x?: number; y?: number }[] } | null | undefined} poly
 * @param {number} imgW
 * @param {number} imgH
 * @returns {{ minX: number; minY: number; maxX: number; maxY: number } | null}
 */
function polyToRect(poly, imgW, imgH) {
  if (!poly) return null;
  const verts = poly.vertices;
  if (verts && verts.length > 0) {
    const xs = verts.map((v) => Number(v.x) || 0);
    const ys = verts.map((v) => Number(v.y) || 0);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }
  const nv = poly.normalizedVertices;
  if (nv && nv.length > 0 && imgW > 0 && imgH > 0) {
    const xs = nv.map((v) => (Number(v.x) || 0) * imgW);
    const ys = nv.map((v) => (Number(v.y) || 0) * imgH);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }
  return null;
}

function unionRects(rects) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    minX = Math.min(minX, r.minX);
    minY = Math.min(minY, r.minY);
    maxX = Math.max(maxX, r.maxX);
    maxY = Math.max(maxY, r.maxY);
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

function rectHeight(r) {
  return Math.max(0, r.maxY - r.minY);
}

/** Hebrew block + Hebrew presentation forms (reading order within a line). */
const HEBREW_RE = /[\u0590-\u05FF\uFB1D-\uFB4F]/;

/**
 * @param {Array<{ text: string; rect: object; word: object }>} wordEntries
 */
function lineLooksMostlyHebrew(wordEntries) {
  let heb = 0;
  let lat = 0;
  for (const w of wordEntries) {
    const t = w.text || '';
    for (let i = 0; i < t.length; i++) {
      const c = t.charAt(i);
      if (HEBREW_RE.test(c)) heb++;
      else if (/[A-Za-z]/.test(c)) lat++;
    }
  }
  return heb > 0 && heb >= lat;
}

/**
 * @param {Array<{ rect: object; text: string; word: object; centerX: number; centerY: number; height: number }>} lineWords
 */
function lineMetricsFromWords(lineWords) {
  if (lineWords.length === 0) {
    return { centerY: 0, avgHeight: 10 };
  }
  let sumCy = 0;
  let sumH = 0;
  for (const w of lineWords) {
    sumCy += w.centerY;
    sumH += w.height;
  }
  return {
    centerY: sumCy / lineWords.length,
    avgHeight: sumH / lineWords.length,
  };
}

/** Left fraction of image width = sidebar; never merge with main region. */
const REGION_SIDEBAR_X_FRAC = 0.35;

/**
 * @param {{ centerX: number }} w
 * @param {number} imgW
 * @returns {'sidebar' | 'main'}
 */
function wordScreenRegion(w, imgW) {
  const boundary = imgW * REGION_SIDEBAR_X_FRAC;
  return w.centerX < boundary ? 'sidebar' : 'main';
}

/**
 * @param {Array<{ text: string; rect: object; word: object }>} parsed
 * @param {number} imgW
 */
function splitWordsByScreenRegion(parsed, imgW) {
  const enriched = enrichWordsForClustering(parsed);
  /** @type {typeof enriched[]} */
  const sidebar = [];
  /** @type {typeof enriched[]} */
  const main = [];
  for (const w of enriched) {
    if (wordScreenRegion(w, imgW) === 'sidebar') {
      sidebar.push(w);
    } else {
      main.push(w);
    }
  }
  return { sidebar, main };
}

/**
 * Horizontal overlap as a fraction of the narrower span (0..1).
 * @param {{ minX: number; maxX: number }} a
 * @param {{ minX: number; maxX: number }} b
 */
function xOverlapRatio(a, b) {
  const wA = Math.max(0, a.maxX - a.minX);
  const wB = Math.max(0, b.maxX - b.minX);
  const overlap = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const denom = Math.min(wA, wB);
  if (denom <= 0) return overlap > 0 ? 1 : 0;
  return overlap / denom;
}

/**
 * @param {Array<{ rect: object; text: string; word: object; centerX: number; centerY: number; height: number }>} segWords
 * @param {'sidebar' | 'main'} region
 */
function lineRunFromSegment(segWords, region) {
  if (!segWords || segWords.length === 0) return null;
  const rtl = lineLooksMostlyHebrew(segWords);
  const ordered = sortWordsInLineByReadingOrder(segWords, rtl);
  const rect = unionRects(ordered.map((s) => s.rect));
  if (!rect) return null;
  const description = ordered
    .map((s) => s.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!description) return null;
  return {
    words: ordered,
    rect,
    region,
    description,
    height: rectHeight(rect),
  };
}

/**
 * Merge visual line runs into message-style blocks within one screen region.
 * @param {NonNullable<ReturnType<typeof lineRunFromSegment>>[]} runs
 * @returns {NonNullable<ReturnType<typeof lineRunFromSegment>>[][]}
 */
function mergeLineRunsIntoMessageBlocks(runs) {
  const lines = [...runs].sort((a, b) => a.rect.minY - b.rect.minY || a.rect.minX - b.rect.minX);
  /** @type {typeof lines[][]} */
  const blocks = [];

  for (const line of lines) {
    if (blocks.length === 0) {
      blocks.push([line]);
      continue;
    }
    const cur = blocks[blocks.length - 1];
    const last = cur[cur.length - 1];
    const unionBlock = unionRects(cur.map((c) => c.rect));
    if (!unionBlock) {
      blocks.push([line]);
      continue;
    }

    const verticalGap = line.rect.minY - last.rect.maxY;
    const avgH = (last.height + line.height) / 2;
    if (verticalGap >= avgH * 1.2) {
      blocks.push([line]);
      continue;
    }

    const xOv = xOverlapRatio(line.rect, unionBlock);
    if (xOv <= 0.6) {
      blocks.push([line]);
      continue;
    }

    const anchorMinX = cur[0].rect.minX;
    const alignTol = Math.max(12, avgH * 0.45);
    if (Math.abs(line.rect.minX - anchorMinX) > alignTol) {
      blocks.push([line]);
      continue;
    }

    cur.push(line);
  }

  return blocks;
}

/**
 * @param {NonNullable<ReturnType<typeof lineRunFromSegment>>[][]} blockLines
 */
function messageBlockToOverlayItem(blockLines) {
  const texts = [];
  /** @type {object[]} */
  const visionWords = [];
  for (const ln of blockLines) {
    texts.push(ln.description);
    for (const w of ln.words) {
      visionWords.push(w.word);
    }
  }
  const union = unionRects(blockLines.map((l) => l.rect));
  if (!union) return null;
  const description = texts.join(' ').replace(/\s+/g, ' ').trim();
  if (!description) return null;
  return {
    description,
    boundingPoly: { vertices: rectToVertices(union) },
    words: visionWords,
  };
}

/** Any Unicode letter (incl. Hebrew). */
const HAS_LETTER_RE = /[\p{L}\p{M}]/u;

/**
 * Timestamps, tiny non-text, icon noise, short sidebar nav labels.
 * @param {string} description
 * @param {'sidebar' | 'main'} region
 */
function isLikelyUiNoise(description, region) {
  const t = String(description || '').trim();
  if (t.length < 2) return true;

  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return true;
  if (/^\d{1,2}\s*[.:]\s*\d{2}\s*([AP]M)?$/i.test(t)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) return true;

  if (!HAS_LETTER_RE.test(t) && t.length < 4) return true;

  if (t.length === 1 && !HAS_LETTER_RE.test(t)) return true;

  if (region === 'sidebar' && t.length <= 14) {
    if (/^(chats|calls|status|settings|search|archive|starred|messages?|updates?)$/i.test(t)) {
      return true;
    }
  }

  return false;
}

/**
 * Per region: lines + horizontal splits + message blocks + noise filter.
 * @param {ReturnType<typeof enrichWordsForClustering>} regionWords
 * @param {'sidebar' | 'main'} region
 * @param {{ verticalCount: number; lineRunCount: number; blockCount: number; itemCount: number }} stats
 */
function buildOverlayItemsForRegion(regionWords, region, stats) {
  if (regionWords.length === 0) return [];

  const { verticalLines, horizontalSegments } = clusterWordsIntoVisualLines(regionWords);
  stats.verticalCount += verticalLines.length;

  /** @type {NonNullable<ReturnType<typeof lineRunFromSegment>>[]} */
  const lineRuns = [];
  for (const seg of horizontalSegments) {
    const run = lineRunFromSegment(seg, region);
    if (run) lineRuns.push(run);
  }
  stats.lineRunCount += lineRuns.length;

  const blocks = mergeLineRunsIntoMessageBlocks(lineRuns);
  stats.blockCount += blocks.length;

  /** @type {Array<{ description: string; boundingPoly: { vertices: { x: number; y: number }[] }; words: object[] }>} */
  const out = [];
  for (const block of blocks) {
    const item = messageBlockToOverlayItem(block);
    if (!item) continue;
    if (isLikelyUiNoise(item.description, region)) continue;
    out.push(item);
  }
  stats.itemCount += out.length;
  return out;
}

/**
 * Enrich Vision words with geometry used for clustering.
 * @param {Array<{ rect: object; text: string; word: object }>} parsed
 */
function enrichWordsForClustering(parsed) {
  return parsed.map((w) => {
    const height = rectHeight(w.rect);
    return {
      ...w,
      centerX: (w.rect.minX + w.rect.maxX) / 2,
      centerY: (w.rect.minY + w.rect.maxY) / 2,
      height,
    };
  });
}

/**
 * Group Vision words by vertical center proximity only (used before horizontal gap splitting).
 * @param {Array<{ rect: object; text: string; word: object; centerX: number; centerY: number; height: number }>} words
 * @returns {Array<{ words: typeof words }>}
 */
function clusterWordsByVerticalProximity(words) {
  if (words.length === 0) return [];

  const sorted = [...words].sort((a, b) => a.centerY - b.centerY || a.centerX - b.centerX);

  /** @type {Array<{ words: typeof sorted }>} */
  const lines = [];

  for (const w of sorted) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const existing = lines[i].words;
      const { centerY: lineCy, avgHeight } = lineMetricsFromWords(existing);
      const thr = Math.max(avgHeight * 0.6, 8);
      const d = Math.abs(w.centerY - lineCy);
      if (d < thr && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      lines[bestIdx].words.push(w);
    } else {
      lines.push({ words: [w] });
    }
  }

  return lines;
}

/**
 * Split one vertical line into horizontal runs when gaps between boxes are too large
 * (e.g. WhatsApp sidebar vs chat on the same scanline).
 * Words are ordered by minX; gap = next.minX - prev.maxX.
 * @param {Array<{ rect: object; text: string; word: object; centerX: number; centerY: number; height: number }>} lineWords
 * @returns {Array<typeof lineWords[]>}
 */
function splitVerticalLineByHorizontalGaps(lineWords) {
  if (lineWords.length === 0) return [];
  if (lineWords.length === 1) return [lineWords];

  const { avgHeight } = lineMetricsFromWords(lineWords);
  const maxJoinGap = Math.max(avgHeight * 4, 40);

  const byX = [...lineWords].sort((a, b) => a.rect.minX - b.rect.minX || a.centerY - b.centerY);

  /** @type {typeof lineWords[][]} */
  const runs = [];
  let cur = [byX[0]];
  for (let i = 1; i < byX.length; i++) {
    const prev = cur[cur.length - 1];
    const w = byX[i];
    const horizontalGap = w.rect.minX - prev.rect.maxX;
    if (horizontalGap > 120 || horizontalGap >= maxJoinGap) {
      runs.push(cur);
      cur = [w];
    } else {
      cur.push(w);
    }
  }
  runs.push(cur);
  return runs;
}

/**
 * Vertical line clustering, then horizontal gap splits within each line.
 * @param {Array<{ rect: object; text: string; word: object }>} parsed
 * @returns {{ verticalLines: Array<{ words: object[] }>; horizontalSegments: object[][] }}
 */
function clusterWordsIntoVisualLines(parsed) {
  const enriched = enrichWordsForClustering(parsed);
  const verticalLines = clusterWordsByVerticalProximity(enriched);
  /** @type {typeof enriched[][]} */
  const horizontalSegments = [];
  for (const line of verticalLines) {
    for (const run of splitVerticalLineByHorizontalGaps(line.words)) {
      horizontalSegments.push(run);
    }
  }
  return { verticalLines, horizontalSegments };
}

/**
 * Reading order: LTR by increasing centerX; RTL (Hebrew-dominant) by decreasing centerX (no string reversal).
 * @param {Array<{ centerX: number }>} lineWords
 * @param {boolean} rtl
 */
function sortWordsInLineByReadingOrder(lineWords, rtl) {
  const sorted = [...lineWords];
  sorted.sort((a, b) => (rtl ? b.centerX - a.centerX : a.centerX - b.centerX));
  return sorted;
}

function rectToVertices(r) {
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
}

function wordFromSymbols(word, imgW, imgH) {
  const symbols = word.symbols || [];
  let text = '';
  for (const sym of symbols) {
    text += sym.text != null ? String(sym.text) : '';
  }
  let rect = polyToRect(word.boundingBox, imgW, imgH);
  if (!rect && symbols.length > 0) {
    const symRects = symbols.map((s) => polyToRect(s.boundingBox, imgW, imgH)).filter(Boolean);
    rect = unionRects(symRects);
  }
  if (!rect) return null;
  return { text, rect, word };
}

/**
 * Collect every word on one Vision page (flatten blocks/paragraphs).
 * @param {Record<string, unknown>} page
 * @param {number} imgW
 * @param {number} imgH
 * @returns {Array<{ text: string; rect: object; word: object }>}
 */
function collectWordsFromPage(page, imgW, imgH) {
  const blocks = page.blocks || [];
  /** @type {Array<{ text: string; rect: object; word: object }>} */
  const parsed = [];
  for (const block of blocks) {
    const paragraphs = block.paragraphs || [];
    for (const paragraph of paragraphs) {
      const rawWords = paragraph.words || [];
      for (const w of rawWords) {
        const uw = wordFromSymbols(w, imgW, imgH);
        if (uw && uw.text.length > 0) parsed.push(uw);
      }
    }
  }
  return parsed;
}

/**
 * OCR_MODE=document → documentTextDetection.
 * OCR_MODE=text → textDetection (default for speed comparison vs document).
 */
function getOcrMode() {
  const m = String(process.env.OCR_MODE || 'text')
    .trim()
    .toLowerCase();
  if (m === 'document') return 'document';
  return 'text';
}

/**
 * @param {Record<string, unknown>} result
 * @returns {Array<{ text: string; rect: object; word: object }>}
 */
function parsedWordsFromTextAnnotations(result) {
  const annotations = result.textAnnotations || [];
  const words = annotations.slice(1);
  /** @type {Array<{ text: string; rect: object; word: object }>} */
  const out = [];
  for (const ann of words) {
    const text = (ann.description != null ? String(ann.description) : '').trim();
    const verts = ann.boundingPoly && ann.boundingPoly.vertices;
    if (!text || !verts || verts.length === 0) continue;
    const xs = verts.map((v) => Number(v.x) || 0);
    const ys = verts.map((v) => Number(v.y) || 0);
    const rect = {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
    out.push({ text, rect, word: ann });
  }
  return out;
}

/**
 * @param {Array<{ text: string; rect: object; word: object }>} parsed
 * @param {{ width: number; height: number }} imageDims
 * @param {Array<{ description: string; boundingPoly: { vertices: { x: number; y: number }[] }; words: object[] }>} items
 * @param {{ verticalCount: number; lineRunCount: number; blockCount: number; itemCount: number; sidebarWords: number; mainWords: number }} stats
 */
function appendGroupedOcrFromParsedWords(parsed, imageDims, items, stats) {
  if (!parsed || parsed.length === 0) return;
  const imgW = imageDims.width || 1;
  const { sidebar, main } = splitWordsByScreenRegion(parsed, imgW);
  stats.sidebarWords += sidebar.length;
  stats.mainWords += main.length;
  items.push(...buildOverlayItemsForRegion(sidebar, 'sidebar', stats));
  items.push(...buildOverlayItemsForRegion(main, 'main', stats));
}

/**
 * @param {Array<{ description: string; boundingPoly: { vertices: { x: number; y: number }[] }; words: object[] }>} items
 * @param {{ verticalCount: number; lineRunCount: number; blockCount: number; itemCount: number; sidebarWords: number; mainWords: number }} stats
 * @param {number} totalWords
 */
function sortAndLogOcrGroupedItems(items, stats, totalWords) {
  items.sort((a, b) => {
    const va = a.boundingPoly && a.boundingPoly.vertices;
    const vb = b.boundingPoly && b.boundingPoly.vertices;
    const ya = va && va.length ? Math.min(...va.map((v) => v.y || 0)) : 0;
    const yb = vb && vb.length ? Math.min(...vb.map((v) => v.y || 0)) : 0;
    return ya - yb;
  });

  console.log('[ocr-group] ocr_raw_word_count', totalWords);
  console.log('[ocr-group] region_sidebar_word_count', stats.sidebarWords);
  console.log('[ocr-group] region_main_word_count', stats.mainWords);
  console.log('[ocr-group] line_groups_before_horizontal_gap_filter', stats.verticalCount);
  console.log('[ocr-group] line_groups_after_horizontal_gap_filter', stats.lineRunCount);
  console.log('[ocr-group] message_block_count_before_noise_filter', stats.blockCount);
  console.log('[ocr-group] overlay_item_count_after_noise_filter', stats.itemCount);
  const sample = items.slice(0, 10).map((it) => {
    const v = it.boundingPoly && it.boundingPoly.vertices;
    let boundingBox = null;
    if (v && v.length) {
      const xs = v.map((p) => Number(p.x) || 0);
      const ys = v.map((p) => Number(p.y) || 0);
      boundingBox = {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      };
    }
    return { text: it.description, boundingBox };
  });
  console.log('[ocr-group] first_10_grouped_lines_with_boxes', sample);
}

/**
 * Regions (sidebar vs main) → visual lines → horizontal runs → message blocks → noise filter.
 * @param {Record<string, unknown>} fullText
 * @param {{ width: number; height: number }} imageDims
 * @returns {Array<{ description: string; boundingPoly: { vertices: { x: number; y: number }[] }; words: object[] }>}
 */
function buildLineGroupsFromFullText(fullText, imageDims) {
  const imgW = imageDims.width || 1;
  const imgH = imageDims.height || 1;
  const pages = fullText.pages || [];

  /** @type {Array<{ description: string; boundingPoly: { vertices: { x: number; y: number }[] }; words: object[] }>} */
  const items = [];
  let totalWords = 0;
  const stats = {
    verticalCount: 0,
    lineRunCount: 0,
    blockCount: 0,
    itemCount: 0,
    sidebarWords: 0,
    mainWords: 0,
  };

  for (const page of pages) {
    const parsed = collectWordsFromPage(page, imgW, imgH);
    totalWords += parsed.length;
    appendGroupedOcrFromParsedWords(parsed, imageDims, items, stats);
  }

  sortAndLogOcrGroupedItems(items, stats, totalWords);
  return items;
}

/**
 * textAnnotations / textDetection → same grouping as document OCR (parsed word list).
 * @param {Record<string, unknown>} result
 * @param {{ width: number; height: number }} imageDims
 */
function buildLineGroupsFromTextAnnotationsPipeline(result, imageDims) {
  const parsed = parsedWordsFromTextAnnotations(result);
  if (parsed.length === 0) {
    return buildLineGroupsFromTextAnnotations(result);
  }

  /** @type {Array<{ description: string; boundingPoly: { vertices: { x: number; y: number }[] }; words: object[] }>} */
  const items = [];
  const stats = {
    verticalCount: 0,
    lineRunCount: 0,
    blockCount: 0,
    itemCount: 0,
    sidebarWords: 0,
    mainWords: 0,
  };
  appendGroupedOcrFromParsedWords(parsed, imageDims, items, stats);
  sortAndLogOcrGroupedItems(items, stats, parsed.length);
  return items;
}

/**
 * Fallback: coarse groups from legacy textAnnotations (word-level).
 * @param {Record<string, unknown>} result
 */
function buildLineGroupsFromTextAnnotations(result) {
  const annotations = result.textAnnotations || [];
  const words = annotations.slice(1);
  if (words.length === 0) return [];
  return words
    .map((ann) => {
      const text = (ann.description || '').trim();
      const verts = ann.boundingPoly && ann.boundingPoly.vertices;
      if (!text || !verts || verts.length === 0) return null;
      const xs = verts.map((v) => Number(v.x) || 0);
      const ys = verts.map((v) => Number(v.y) || 0);
      const rect = {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      };
      return {
        description: text,
        boundingPoly: { vertices: rectToVertices(rect) },
        words: [ann],
      };
    })
    .filter(Boolean);
}

/**
 * Build overlay line items from a Vision AnnotateImageResponse.
 * Document layout uses fullTextAnnotation.pages; otherwise textAnnotations + same grouping pipeline.
 * @param {Record<string, unknown>} result
 * @param {{ width: number; height: number }} imageDims
 */
function buildLineOverlayItems(result, imageDims) {
  const fullText = result.fullTextAnnotation;
  if (
    fullText &&
    typeof fullText === 'object' &&
    Array.isArray(fullText.pages) &&
    fullText.pages.length > 0
  ) {
    return buildLineGroupsFromFullText(/** @type {Record<string, unknown>} */ (fullText), imageDims);
  }
  return buildLineGroupsFromTextAnnotationsPipeline(result, imageDims);
}

/**
 * Image size for coordinate math (Vision page dims match the analyzed image when present).
 * @param {Record<string, unknown>} result
 * @param {{ width?: number; height?: number }} [fallbackDims] screenshot / PNG size when pages missing (textDetection).
 */
function inferImageDimsFromResult(result, fallbackDims) {
  const fta = result.fullTextAnnotation;
  const pages = fta && fta.pages;
  if (pages && pages.length > 0) {
    const w = Number(pages[0].width);
    const h = Number(pages[0].height);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  if (fallbackDims && Number(fallbackDims.width) > 0 && Number(fallbackDims.height) > 0) {
    return { width: Number(fallbackDims.width), height: Number(fallbackDims.height) };
  }
  return { width: 1, height: 1 };
}

/**
 * @param {Record<string, unknown>} result Vision AnnotateImageResponse-like object
 * @param {{ width?: number; height?: number }} [imageDims] PNG dimensions for grouping when using textDetection
 */
function formatOcrTextReport(result, imageDims) {
  const lines = [];
  const fullText = result.fullTextAnnotation;

  lines.push('=== Full detected text ===');
  if (fullText && typeof fullText.text === 'string' && fullText.text.trim()) {
    lines.push(String(fullText.text).trim());
  } else {
    const annotations = result.textAnnotations || [];
    if (annotations.length > 0 && annotations[0].description) {
      lines.push(String(annotations[0].description).trim());
    } else {
      lines.push('(no text detected)');
    }
  }

  lines.push('');
  lines.push('=== Line groups (overlay) ===');
  const dims = inferImageDimsFromResult(result, imageDims);
  const groups = buildLineOverlayItems(result, dims);
  if (groups.length === 0) {
    lines.push('(none)');
    return lines.join('\n');
  }
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    lines.push(`[${i + 1}] "${g.description}"`);
    lines.push(`    boundingPoly.vertices: ${formatVertices(g.boundingPoly.vertices)}`);
    lines.push(`    wordCount: ${g.words ? g.words.length : 0}`);
  }

  lines.push('');
  lines.push('=== Legacy textAnnotations (word-level, if present) ===');
  const annotations = result.textAnnotations || [];
  const items = annotations.slice(1);
  if (items.length === 0) {
    lines.push('(none)');
  } else {
    for (let i = 0; i < Math.min(items.length, 50); i++) {
      const ann = items[i];
      lines.push(`[${i + 1}] "${ann.description ?? ''}"`);
      lines.push(`    boundingPoly.vertices: ${formatVertices(ann.boundingPoly?.vertices)}`);
    }
    if (items.length > 50) {
      lines.push(`... (${items.length - 50} more words omitted)`);
    }
  }

  return lines.join('\n');
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

/**
 * Run Vision OCR on image bytes (ADC only). Mode: OCR_MODE=document | text.
 * @param {Buffer} imageBytes
 * @returns {Promise<{ success: true, rawResponse: object, ocrMode: string, ocrRpcMs: number } | { success: false, error: string, code?: number, ocrMode?: string, ocrRpcMs?: number }>}
 */
async function runOcrOnImageBuffer(imageBytes) {
  if (!imageBytes || imageBytes.length === 0) {
    return { success: false, error: 'Empty image buffer' };
  }

  const mode = getOcrMode();
  const t0 = performance.now();
  console.log('[perf-detail] vision_ocr_mode', mode);
  console.log('[perf-detail] vision_request_png_bytes', imageBytes.length);

  try {
    if (mode === 'text') {
      console.log('[perf-detail] vision_textDetection_rpc_start');
      const [result] = await getClient().textDetection({
        image: { content: imageBytes },
      });

      const rpcMs = performance.now() - t0;
      const ta = result && result.textAnnotations;
      console.log('[perf-detail] vision_textDetection_rpc_done_ms', rpcMs.toFixed(1));
      console.log('[perf-detail] vision_result_textAnnotations_count', ta ? ta.length : 0);

      return { success: true, rawResponse: result || {}, ocrMode: 'text', ocrRpcMs: rpcMs };
    }

    console.log('[perf-detail] vision_documentTextDetection_rpc_start');
    const [result] = await getClient().documentTextDetection({
      image: { content: imageBytes },
    });

    const rpcMs = performance.now() - t0;
    const fta = result && result.fullTextAnnotation;
    console.log('[perf-detail] vision_documentTextDetection_rpc_done_ms', rpcMs.toFixed(1));
    console.log('[perf-detail] vision_result_pages', fta && fta.pages ? fta.pages.length : 0);

    return { success: true, rawResponse: result || {}, ocrMode: 'document', ocrRpcMs: rpcMs };
  } catch (err) {
    const rpcMs = performance.now() - t0;
    if (mode === 'text') {
      console.log('[perf-detail] vision_textDetection_failed_after_ms', rpcMs.toFixed(1));
    } else {
      console.log('[perf-detail] vision_documentTextDetection_failed_after_ms', rpcMs.toFixed(1));
    }
    return {
      success: false,
      error: err.message || String(err),
      code: err.code,
      ocrMode: mode,
      ocrRpcMs: rpcMs,
    };
  }
}

/**
 * Run Vision documentTextDetection on a local image file (ADC only).
 * @param {string} imagePath Absolute or relative path to PNG/JPEG etc.
 * @returns {Promise<{ success: true, rawResponse: object } | { success: false, error: string, code?: number }>}
 */
async function runOcrOnImage(imagePath) {
  if (!fs.existsSync(imagePath)) {
    return { success: false, error: `File not found: ${imagePath}` };
  }

  try {
    const imageBytes = fs.readFileSync(imagePath);
    return runOcrOnImageBuffer(imageBytes);
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      code: err.code,
    };
  }
}

function stringifyRawResponse(rawResponse) {
  return JSON.stringify(rawResponse, jsonReplacer, 2);
}

module.exports = {
  runOcrOnImage,
  runOcrOnImageBuffer,
  formatOcrTextReport,
  stringifyRawResponse,
  buildLineOverlayItems,
  getOcrMode,
  inferImageDimsFromResult,
};
