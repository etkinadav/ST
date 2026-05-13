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

/** Max strings per translateText request (stay under service limits). */
const CHUNK_SIZE = 95;

let client;

function getTranslateClient() {
  if (!client) {
    client = new TranslationServiceClient();
  }
  return client;
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

async function resolveProjectId() {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return String(process.env.GOOGLE_CLOUD_PROJECT).trim();
  }
  if (process.env.GCLOUD_PROJECT) {
    return String(process.env.GCLOUD_PROJECT).trim();
  }
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const id = await auth.getProjectId();
  return id ? String(id).trim() : null;
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
 * @returns {Promise<Array<{ description?: string; boundingPoly?: object; words?: object[]; originalText: string; translatedText: string; hebrewSourceText: string }>>}
 */
async function translateOcrLineItems(items, options = {}) {
  const targetLanguageCode = options.targetLanguageCode || DEFAULT_TARGET_LANGUAGE;

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

  try {
    const projectId = await resolveProjectId();
    if (!projectId) {
      throw new Error(
        'Could not resolve GCP project ID. Set GOOGLE_CLOUD_PROJECT or run gcloud config set project.',
      );
    }
    const parent = `projects/${projectId}/locations/global`;
    const translateClient = getTranslateClient();

    /** @type {string[]} */
    const apiOut = [];
    for (let i = 0; i < stringsToTranslate.length; i += CHUNK_SIZE) {
      const chunk = stringsToTranslate.slice(i, i + CHUNK_SIZE);
      const part = await translateTextChunk(chunk, targetLanguageCode, translateClient, parent);
      apiOut.push(...part);
    }

    const out = candidates.map((c, j) => {
      const translated = apiOut[j] != null ? apiOut[j] : c.hebrewText;
      return {
        ...c.item,
        originalText: c.fullOriginal,
        hebrewSourceText: c.hebrewText,
        translatedText: translated,
      };
    });

    console.log(
      'Translation first translated',
      out.length > 0 && out[0].translatedText ? out[0].translatedText : '(none)',
    );
    console.log('Translation API success');

    return out;
  } catch (err) {
    console.error('Translation API error', err.message || err);
    return candidates.map((c) => ({
      ...c.item,
      originalText: c.fullOriginal,
      hebrewSourceText: c.hebrewText,
      translatedText: c.hebrewText,
    }));
  }
}

module.exports = {
  DEFAULT_TARGET_LANGUAGE,
  translateOcrLineItems,
};
