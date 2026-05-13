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

function rectCenterY(r) {
  return (r.minY + r.maxY) / 2;
}

/** Vertical overlap / min(heights) in [0, 1] */
function verticalOverlapRatio(a, b) {
  const h1 = rectHeight(a);
  const h2 = rectHeight(b);
  const minH = Math.min(h1, h2);
  if (minH <= 0) return 0;
  const inter = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return Math.max(0, inter) / minH;
}

function unionWordBounds(words) {
  return unionRects(words.map((w) => w.rect));
}

/**
 * Group words that sit on the same horizontal line (within a paragraph).
 * @param {Array<{ rect: object; text: string; word: object }>} words
 */
function clusterWordsIntoLines(words) {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.rect.minY - b.rect.minY || a.rect.minX - b.rect.minX);
  /** @type {{ words: typeof words }[]} */
  const lines = [];

  for (const w of sorted) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < lines.length; i++) {
      const lineRect = unionWordBounds(lines[i].words);
      if (!lineRect) continue;
      const ov = verticalOverlapRatio(w.rect, lineRect);
      const h = Math.max(rectHeight(w.rect), rectHeight(lineRect), 1);
      const cyDist = Math.abs(rectCenterY(w.rect) - rectCenterY(lineRect)) / h;
      const score = ov > 0.2 ? ov : cyDist < 0.5 ? 0.5 - cyDist : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore > 0.15) {
      lines[bestIdx].words.push(w);
    } else {
      lines.push({ words: [w] });
    }
  }
  return lines;
}

/**
 * Split words on one visual line into groups when there is a large horizontal gap (separate UI columns).
 * @param {Array<{ rect: object; text: string; word: object }>} words sorted by x
 * @param {number} imgW
 */
function splitWordsByHorizontalGap(words, imgW) {
  if (words.length === 0) return [];
  const gapThreshold = Math.min(180, Math.max(32, (imgW || 1920) * 0.045));
  /** @type {typeof words[]} */
  const groups = [];
  let cur = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const prev = cur[cur.length - 1];
    const w = words[i];
    const gap = w.rect.minX - prev.rect.maxX;
    if (gap > gapThreshold) {
      groups.push(cur);
      cur = [w];
    } else {
      cur.push(w);
    }
  }
  groups.push(cur);
  return groups;
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
 * Walk pages → blocks → paragraphs → words; build line-level overlay items.
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

  for (const page of pages) {
    const blocks = page.blocks || [];
    for (const block of blocks) {
      const paragraphs = block.paragraphs || [];
      for (const paragraph of paragraphs) {
        const rawWords = paragraph.words || [];
        const parsed = [];
        for (const w of rawWords) {
          const uw = wordFromSymbols(w, imgW, imgH);
          if (uw && uw.text.length > 0) parsed.push(uw);
        }
        if (parsed.length === 0) continue;

        const lineClusters = clusterWordsIntoLines(parsed);
        for (const line of lineClusters) {
          const byX = [...line.words].sort((a, b) => a.rect.minX - b.rect.minX);
          const segments = splitWordsByHorizontalGap(byX, imgW);
          for (const seg of segments) {
            const union = unionRects(seg.map((s) => s.rect));
            if (!union) continue;
            const description = seg
              .map((s) => s.text)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (!description) continue;
            items.push({
              description,
              boundingPoly: { vertices: rectToVertices(union) },
              words: seg.map((s) => s.word),
            });
          }
        }
      }
    }
  }
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
    const [result] = await getClient().documentTextDetection({
      image: { content: imageBytes },
    });

    return { success: true, rawResponse: result || {} };
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
  formatOcrTextReport,
  stringifyRawResponse,
  buildLineOverlayItems,
};
