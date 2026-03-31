const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const router  = express.Router();

const upload = multer({ dest: 'uploads/' });

function normalizeShopifyUrl(url) {
  if (!url) return null;
  if (url.includes('shopify-staged-uploads.storage.googleapis.com')) return null;
  return url;
}

function isShopifyCdnUrl(url) {
  return /^https?:\/\/cdn\.shopify\.com\/.+$/i.test(url);
}

/* ════════════════════════════════════════════════════
   POST /api/json/from-sheet
   Multipart: file (xlsx with Shopify URLs filled)
════════════════════════════════════════════════════ */
router.post('/from-sheet', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { keyMode = 'altbase', strictCDN = false } = req.body;

  const wb = XLSX.readFile(req.file.path);
  const ws = wb.Sheets['Images'];
  if (!ws) return res.status(400).json({ error: 'Sheet "Images" not found' });

  const rows = XLSX.utils.sheet_to_json(ws);
  const map = {};
  let skipped = 0;

  rows.forEach(row => {
    const rawUrl   = normalizeShopifyUrl(row['Shopify URL']);
    let url = null;

    // ★ ONLY use Shopify URLs - DO NOT fall back to Product URL
    if (isShopifyCdnUrl(rawUrl)) {
      url = rawUrl;
    }

    if (!url) {
      skipped++;
      console.warn(`[JSON] ⚠ Skipped row "${row['SKU']}" — Shopify URL is missing or invalid. Shopify URL: "${row['Shopify URL']}"`);
      return;
    }

    let key;
    if (keyMode === 'sku') {
      key = (row['SKU'] || '').trim();
    } else if (keyMode === 'prefix') {
      key = (row['Alt Text'] || '').trim().split(/[\s-]/)[0];
    } else {
      // altbase: strip trailing -N from alt text
      const alt = (row['Alt Text'] || row['SKU'] || '').trim();
      key = alt.replace(/-\d+$/, '');
    }

    if (!key) return;
    if (!map[key]) map[key] = [];
    map[key].push(url);
  });

  // Sort URLs within each key by trailing number
  Object.keys(map).forEach(k => {
    map[k].sort((a, b) => {
      const numA = parseInt((a.match(/-(\d+)\.\w+/) || [])[1] || 0);
      const numB = parseInt((b.match(/-(\d+)\.\w+/) || [])[1] || 0);
      return numA - numB;
    });
  });

  if (skipped > 0) console.warn(`[JSON] Skipped ${skipped} rows with no valid URL`);
  res.json(map);
});

/* ════════════════════════════════════════════════════
   POST /api/json/from-results
   Body: { results: [{ sku, view, url, shopifyUrl, altText }], keyMode }
════════════════════════════════════════════════════ */
router.post('/from-results', (req, res) => {
  const { results = [], keyMode = 'altbase', strictCDN = true } = req.body;  // FORCE Shopify URLs
  const map = {};
  let skipped = 0;

  results.forEach(r => {
    const rawUrl   = normalizeShopifyUrl(r.shopifyUrl);
    let url = null;

    // ★ ONLY use Shopify URLs - DO NOT fall back to Product URL
    if (isShopifyCdnUrl(rawUrl)) {
      url = rawUrl;
    }

    if (!url) {
      skipped++;
      // Log the actual values to help debug
      const shopifyUrlStatus = r.shopifyUrl 
        ? (r.shopifyUrl.includes('shopify-staged') ? 'STAGED URL (not ready)' : 'INVALID URL: ' + r.shopifyUrl)
        : 'EMPTY/NULL';
      console.warn(`[JSON] ⚠ Skipped row "${r.sku}" view ${r.view} — Shopify URL is ${shopifyUrlStatus}. Re-upload or verify credentials.`);
      return;
    }

    let key;
    if (keyMode === 'sku')         key = r.sku;
    else if (keyMode === 'prefix') key = (r.altText || '').split(/[\s-]/)[0] || r.sku;
    else {
      const alt = r.altText || r.sku;
      key = alt.replace(/-\d+$/, '');
    }

    if (!key) return;
    if (!map[key]) map[key] = [];
    map[key].push(url);
  });

  if (skipped > 0) console.warn(`[JSON] Skipped ${skipped} results with no valid URL`);
  res.json(map);
});

module.exports = router;