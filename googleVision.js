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
 * Flatten all words, cluster by vertical centerY, split runs by horizontal gaps, one boundingPoly per segment.
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
  let verticalLineTotal = 0;

  for (const page of pages) {
    const parsed = collectWordsFromPage(page, imgW, imgH);
    totalWords += parsed.length;
    const { verticalLines, horizontalSegments } = clusterWordsIntoVisualLines(parsed);
    verticalLineTotal += verticalLines.length;

    for (const seg of horizontalSegments) {
      const rtl = lineLooksMostlyHebrew(seg);
      const ordered = sortWordsInLineByReadingOrder(seg, rtl);
      const union = unionRects(ordered.map((s) => s.rect));
      if (!union) continue;
      const description = ordered
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!description) continue;
      items.push({
        description,
        boundingPoly: { vertices: rectToVertices(union) },
        words: ordered.map((s) => s.word),
      });
    }
  }

  items.sort((a, b) => {
    const va = a.boundingPoly && a.boundingPoly.vertices;
    const vb = b.boundingPoly && b.boundingPoly.vertices;
    const ya = va && va.length ? Math.min(...va.map((v) => v.y || 0)) : 0;
    const yb = vb && vb.length ? Math.min(...vb.map((v) => v.y || 0)) : 0;
    return ya - yb;
  });

  console.log('[ocr-group] ocr_raw_word_count', totalWords);
  console.log('[ocr-group] line_groups_before_horizontal_gap_filter', verticalLineTotal);
  console.log('[ocr-group] line_groups_after_horizontal_gap_filter', items.length);
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
 * Build overlay line items from a Vision AnnotateImageResponse (documentTextDetection).
 * @param {Record<string, unknown>} result
 * @param {{ width: number; height: number }} imageDims
 */
function buildLineOverlayItems(result, imageDims) {
  const fullText = result.fullTextAnnotation;
  if (fullText && typeof fullText === 'object') {
    return buildLineGroupsFromFullText(/** @type {Record<string, unknown>} */ (fullText), imageDims);
  }
  return buildLineGroupsFromTextAnnotations(result);
}

/**
 * Image size for coordinate math (Vision page dims match the analyzed image).
 * @param {Record<string, unknown>} result
 */
function inferImageDimsFromResult(result) {
  const fta = result.fullTextAnnotation;
  const pages = fta && fta.pages;
  if (pages && pages.length > 0) {
    const w = Number(pages[0].width);
    const h = Number(pages[0].height);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return { width: 1, height: 1 };
}

/** @param {Record<string, unknown>} result Vision AnnotateImageResponse-like object */
function formatOcrTextReport(result) {
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
  const dims = inferImageDimsFromResult(result);
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
 * Run Vision documentTextDetection on image bytes (ADC only). Avoids re-reading the PNG from disk.
 * @param {Buffer} imageBytes
 * @returns {Promise<{ success: true, rawResponse: object } | { success: false, error: string, code?: number }>}
 */
async function runOcrOnImageBuffer(imageBytes) {
  if (!imageBytes || imageBytes.length === 0) {
    return { success: false, error: 'Empty image buffer' };
  }

  const t0 = performance.now();
  console.log('[perf-detail] vision_request_png_bytes', imageBytes.length);
  console.log('[perf-detail] vision_documentTextDetection_rpc_start');

  try {
    const [result] = await getClient().documentTextDetection({
      image: { content: imageBytes },
    });

    const rpcMs = performance.now() - t0;
    const fta = result && result.fullTextAnnotation;
    console.log('[perf-detail] vision_documentTextDetection_rpc_done_ms', rpcMs.toFixed(1));
    console.log('[perf-detail] vision_result_pages', fta && fta.pages ? fta.pages.length : 0);

    return { success: true, rawResponse: result || {} };
  } catch (err) {
    const rpcMs = performance.now() - t0;
    console.log('[perf-detail] vision_documentTextDetection_failed_after_ms', rpcMs.toFixed(1));
    return {
      success: false,
      error: err.message || String(err),
      code: err.code,
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
};
