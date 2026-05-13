/**
 * Google Cloud Translation API v3 via Application Default Credentials (ADC).
 * Same auth as Vision: gcloud auth application-default login
 * Do not use service account JSON keys or GOOGLE_APPLICATION_CREDENTIALS for keys.
 *
 * Overlay policy:
 * 1. OCR line groups come from Vision (unchanged upstream).
 * 2. Drop any group with no Hebrew. Strip non-Hebrew characters from the rest (Hebrew + spaces only for API).
 * 3. Send Hebrew-only strings to Translation → English by default.
 * 4. Return only those groups for the overlay; translatedText is what is shown (English).
 * Target override: process.env.SCREEN_TRANSLATOR_TARGET_LANG
 */

const { TranslationServiceClient } = require('@google-cloud/translate').v3;
const { GoogleAuth } = require('google-auth-library');

/** Target language for Hebrew snippets (BCP-47). */
const DEFAULT_TARGET_LANGUAGE = 'en';

/** Single Translation API client for the process (ADC). */
let translateClientSingleton = null;

/** Cached after {@link initTranslateService} succeeds. */
let cachedProjectId = null;
/** e.g. projects/{id}/locations/global */
let cachedTranslateParent = null;
/** How projectId was obtained (for logs). */
let cachedProjectIdSource = null;

/** In-flight bootstrap promise (concurrent initTranslateService callers share it). */
let translateBootstrapPromise = null;

function getTranslateClient() {
  if (!translateClientSingleton) {
    translateClientSingleton = new TranslationServiceClient();
  }
  return translateClientSingleton;
}

/** Hebrew block + Hebrew presentation forms. */
const HEBREW_RE = /[\u0590-\u05FF\uFB1D-\uFB4F]/;

/** Remove everything that is not Hebrew letter or whitespace (collapse spaces). */
const NOT_HEBREW_OR_SPACE = /[^\u0590-\u05FF\uFB1D-\uFB4F\s]/g;

function containsHebrew(s) {
  return HEBREW_RE.test(s == null ? '' : String(s));
}

function hebrewOnlyForTranslate(s) {
  const t = String(s == null ? '' : s)
    .replace(NOT_HEBREW_OR_SPACE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

/** @param {{ vertices?: { x?: number; y?: number }[] } | null | undefined} poly */
function boundingBoxFromPoly(poly) {
  const verts = poly && poly.vertices;
  if (!verts || verts.length === 0) return null;
  const xs = verts.map((v) => Number(v.x) || 0);
  const ys = verts.map((v) => Number(v.y) || 0);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/**
 * Resolve GCP project id once: env vars first (sync), else a single ADC metadata lookup.
 * Does not run on the hot translation path after {@link initTranslateService} has succeeded.
 */
async function bootstrapTranslateProjectAndParent() {
  getTranslateClient();

  let projectId = null;
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    projectId = String(process.env.GOOGLE_CLOUD_PROJECT).trim();
    cachedProjectIdSource = 'GOOGLE_CLOUD_PROJECT';
  } else if (process.env.GCLOUD_PROJECT) {
    projectId = String(process.env.GCLOUD_PROJECT).trim();
    cachedProjectIdSource = 'GCLOUD_PROJECT';
  } else {
    cachedProjectIdSource = 'GoogleAuth.getProjectId';
    console.log(
      '[translate-init] No GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT; calling GoogleAuth.getProjectId() once (ADC)',
    );
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const tAdc = performance.now();
    const id = await auth.getProjectId();
    console.log(
      '[translate-init] GoogleAuth.getProjectId_ms',
      (performance.now() - tAdc).toFixed(1),
    );
    projectId = id ? String(id).trim() : null;
  }

  if (!projectId) {
    throw new Error(
      'Could not resolve GCP project ID. Set GOOGLE_CLOUD_PROJECT or run gcloud config set project.',
    );
  }

  cachedProjectId = projectId;
  cachedTranslateParent = `projects/${projectId}/locations/global`;
  console.log('[translate-init] cached parent', cachedTranslateParent, 'source', cachedProjectIdSource);
}

/**
 * Idempotent: safe to await from app startup and from translate. After success,
 * {@link translateOcrLineItems} uses cached parent only (no getProjectId).
 */
async function initTranslateService() {
  if (cachedTranslateParent) {
    return { projectId: cachedProjectId, parent: cachedTranslateParent };
  }
  if (!translateBootstrapPromise) {
    translateBootstrapPromise = (async () => {
      try {
        await bootstrapTranslateProjectAndParent();
      } catch (err) {
        translateBootstrapPromise = null;
        throw err;
      }
    })();
  }
  await translateBootstrapPromise;
  translateBootstrapPromise = null;
  return { projectId: cachedProjectId, parent: cachedTranslateParent };
}

/**
 * @param {string[]} contents
 * @param {string} targetLanguageCode
 * @param {*} translateClient
 * @param {string} parent projects/{id}/locations/global
 * @returns {Promise<string[]>} same length as contents
 */
async function translateTextChunk(contents, targetLanguageCode, translateClient, parent) {
  const [response] = await translateClient.translateText({
    parent,
    contents,
    mimeType: 'text/plain',
    targetLanguageCode,
  });
  const translations = response.translations || [];
  return contents.map((original, i) => {
    const t = translations[i];
    if (t && t.translatedText != null && String(t.translatedText).length > 0) {
      return String(t.translatedText);
    }
    return original;
  });
}

/**
 * Filter to Hebrew lines, strip non-Hebrew, translate, return only overlay rows (English text).
 * @param {Array<{ description?: string; boundingPoly?: object; words?: object[] }>} items from buildLineOverlayItems
 * @param {{ targetLanguageCode?: string }} [options]
 * @returns {Promise<Array<{ description?: string; boundingPoly?: object; words?: object[]; originalText: string; translatedText: string; hebrewSourceText: string; boundingBox: { minX: number; minY: number; maxX: number; maxY: number } | null; sourceWasRtl: boolean }>>}
 */
async function translateOcrLineItems(items, options = {}) {
  const targetLanguageCode = options.targetLanguageCode || DEFAULT_TARGET_LANGUAGE;
  const tFilter0 = performance.now();

  console.log('Translation OCR groups count (input)', items.length);

  if (items.length === 0) {
    console.log('Translation overlay groups (Hebrew only)', 0);
    console.log('Translation API skipped (no OCR groups)');
    return [];
  }

  /** @type {{ item: object; fullOriginal: string; hebrewText: string }[]} */
  const candidates = [];
  for (const item of items) {
    const fullOriginal = item.description != null ? String(item.description) : '';
    if (!containsHebrew(fullOriginal)) {
      continue;
    }
    const hebrewText = hebrewOnlyForTranslate(fullOriginal);
    if (!hebrewText || !containsHebrew(hebrewText)) {
      continue;
    }
    candidates.push({ item, fullOriginal, hebrewText });
  }

  console.log('Translation overlay groups (Hebrew only, after strip)', candidates.length);
  console.log(
    'Translation first Hebrew snippet (sent to API)',
    candidates.length > 0 ? candidates[0].hebrewText : '(none)',
  );

  if (candidates.length === 0) {
    console.log('Translation API skipped (no Hebrew text to translate)');
    return [];
  }

  const stringsToTranslate = candidates.map((c) => c.hebrewText);

  console.log('[perf-detail] translate_filter_hebrew_candidates_ms', (performance.now() - tFilter0).toFixed(1));
  console.log('Translation translateText single request, string count:', stringsToTranslate.length);

  try {
    const tReady = performance.now();
    await initTranslateService();
    console.log('[perf-detail] translate_ensure_ready_ms', (performance.now() - tReady).toFixed(1));
    console.log(
      '[perf-detail] translate_hot_path_googleAuth_getProjectId_called',
      false,
      '(project resolved only in initTranslateService / env)',
    );
    console.log('[perf-detail] translate_project_id', cachedProjectId || '(null)');
    console.log('[perf-detail] translate_parent', cachedTranslateParent || '(null)');

    const parent = cachedTranslateParent;
    const translateClient = getTranslateClient();

    const totalChars = stringsToTranslate.reduce((sum, s) => sum + s.length, 0);
    const maxLen = stringsToTranslate.reduce((m, s) => Math.max(m, s.length), 0);
    console.log('[perf-detail] translate_payload_chars_total', totalChars);
    console.log('[perf-detail] translate_payload_max_string_len', maxLen);

    const tRpc = performance.now();
    const apiOut = await translateTextChunk(
      stringsToTranslate,
      targetLanguageCode,
      translateClient,
      parent,
    );
    console.log('[perf-detail] translate_translateText_rpc_ms', (performance.now() - tRpc).toFixed(1));

    const out = candidates.map((c, j) => {
      const translated = apiOut[j] != null ? apiOut[j] : c.hebrewText;
      const box = boundingBoxFromPoly(c.item && c.item.boundingPoly);
      return {
        ...c.item,
        originalText: c.fullOriginal,
        hebrewSourceText: c.hebrewText,
        translatedText: translated,
        boundingBox: box,
        sourceWasRtl: containsHebrew(c.fullOriginal),
      };
    });

    console.log(
      'Translation first translated',
      out.length > 0 && out[0].translatedText ? out[0].translatedText : '(none)',
    );
    console.log(
      '[ocr-translate] first_5_original_lines',
      out.slice(0, 5).map((o) => o.originalText),
    );
    console.log(
      '[ocr-translate] first_5_translated_lines',
      out.slice(0, 5).map((o) => o.translatedText),
    );
    console.log('Translation API success');

    return out;
  } catch (err) {
    console.error('Translation API error', err.message || err);
    return candidates.map((c) => {
      const box = boundingBoxFromPoly(c.item && c.item.boundingPoly);
      return {
        ...c.item,
        originalText: c.fullOriginal,
        hebrewSourceText: c.hebrewText,
        translatedText: c.hebrewText,
        boundingBox: box,
        sourceWasRtl: containsHebrew(c.fullOriginal),
      };
    });
  }
}

module.exports = {
  DEFAULT_TARGET_LANGUAGE,
  initTranslateService,
  translateOcrLineItems,
};
