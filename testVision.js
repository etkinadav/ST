/**
 * Local OCR smoke test using Application Default Credentials (ADC).
 * Uses documentTextDetection (same as the app). Run: gcloud auth application-default login
 * Do not set GOOGLE_APPLICATION_CREDENTIALS or use JSON key files.
 */

const fs = require('fs');
const path = require('path');
const { runOcrOnImage, formatOcrTextReport } = require('./googleVision.js');

const IMAGE_PATH = path.join(__dirname, 'test.png');

async function main() {
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`[error] Missing image file: ${IMAGE_PATH}`);
    console.error('Place a PNG named test.png in the project root next to testVision.js.');
    process.exitCode = 1;
    return;
  }

  const ocr = await runOcrOnImage(IMAGE_PATH);
  if (!ocr.success) {
    console.error('[error] Vision textDetection failed:', ocr.error);
    if (ocr.code) {
      console.error('    code:', ocr.code);
    }
    process.exitCode = 1;
    return;
  }

  console.log(formatOcrTextReport(ocr.rawResponse));
}

main();
