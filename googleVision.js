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

/** @param {Record<string, unknown>} result Vision AnnotateImageResponse-like object */
function formatOcrTextReport(result) {
  const lines = [];
  const annotations = result.textAnnotations || [];

  lines.push('=== Full detected text ===');
  if (annotations.length === 0) {
    lines.push('(no text detected)');
    lines.push('');
    lines.push('=== Detected items ===');
    lines.push('(none)');
    return lines.join('\n');
  }

  lines.push((annotations[0].description || '').trim());
  lines.push('');
  lines.push('=== Detected items ===');

  const items = annotations.slice(1);
  if (items.length === 0) {
    lines.push('(no individual items; only full block returned)');
  } else {
    for (let i = 0; i < items.length; i++) {
      const ann = items[i];
      const text = ann.description ?? '';
      const vertices = ann.boundingPoly?.vertices;
      lines.push(`[${i + 1}] "${text}"`);
      lines.push(`    boundingPoly.vertices: ${formatVertices(vertices)}`);
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
 * Run Vision textDetection on a local image file (ADC only).
 * @param {string} imagePath Absolute or relative path to PNG/JPEG etc.
 * @returns {Promise<{ success: true, rawResponse: object } | { success: false, error: string, code?: number }>}
 */
async function runOcrOnImage(imagePath) {
  if (!fs.existsSync(imagePath)) {
    return { success: false, error: `File not found: ${imagePath}` };
  }

  try {
    const imageBytes = fs.readFileSync(imagePath);
    const [result] = await getClient().textDetection({
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
};
