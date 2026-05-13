/**
 * Local OCR smoke test using Application Default Credentials (ADC).
 * Run: gcloud auth application-default login
 * Do not set GOOGLE_APPLICATION_CREDENTIALS or use JSON key files.
 */

const fs = require('fs');
const path = require('path');
const vision = require('@google-cloud/vision');

const IMAGE_PATH = path.join(__dirname, 'test.png');

function formatVertices(vertices) {
  if (!vertices || vertices.length === 0) {
    return '(no vertices)';
  }
  return vertices
    .map((v) => `(${v.x ?? 0}, ${v.y ?? 0})`)
    .join(' → ');
}

async function main() {
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`[error] Missing image file: ${IMAGE_PATH}`);
    console.error('Place a PNG named test.png in the project root next to testVision.js.');
    process.exitCode = 1;
    return;
  }

  // ADC only: no keyFilename, no GOOGLE_APPLICATION_CREDENTIALS.
  const client = new vision.ImageAnnotatorClient();

  const imageBytes = fs.readFileSync(IMAGE_PATH);

  try {
    const [result] = await client.textDetection({
      image: { content: imageBytes },
    });

    const annotations = result.textAnnotations || [];

    if (annotations.length === 0) {
      console.log('[ok] Request succeeded but no text was detected.');
      return;
    }

    const fullBlock = annotations[0];
    console.log('--- Full detected text ---');
    console.log(fullBlock.description?.trim() || '(empty description)');
    console.log();

    const items = annotations.slice(1);
    console.log(`--- Individual items (${items.length}) ---`);

    for (let i = 0; i < items.length; i++) {
      const ann = items[i];
      const text = ann.description ?? '';
      const vertices = ann.boundingPoly?.vertices;
      console.log(`[${i + 1}] "${text}"`);
      console.log(`    boundingPoly.vertices: ${formatVertices(vertices)}`);
    }
  } catch (err) {
    console.error('[error] Vision textDetection failed:', err.message || err);
    if (err.code) {
      console.error('    code:', err.code);
    }
    process.exitCode = 1;
  }
}

main();
