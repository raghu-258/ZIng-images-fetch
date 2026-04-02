const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const fetch   = require('node-fetch');
const router  = express.Router();

const upload = multer({ dest: 'uploads/' });

// ════════════════════════════════════════════════════
// SHOPIFY METAFIELD HELPERS
// ════════════════════════════════════════════════════
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

async function getProductIdBySku(sku) {
  try {
    const query = `
      query {
        products(first: 1, query: "sku:'${sku}'") {
          edges {
            node {
              id
              title
            }
          }
        }
      }
    `;

    const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    
    const product = data.data?.products?.edges?.[0]?.node;
    return product?.id || null;
  } catch (err) {
    console.error(`[METAFIELD] Error fetching product for SKU "${sku}":`, err.message);
    return null;
  }
}

async function updateProductMetafield(productId, imageUrls) {
  try {
    const mutation = `
      mutation {
        metafieldsSet(metafields: [{
          ownerId: "${productId}"
          namespace: "custom"
          key: "gallery_images"
          type: "json"
          value: "${JSON.stringify(imageUrls).replace(/"/g, '\\"')}"
        }]) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ mutation }),
    });

    const data = await response.json();
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    
    const userErrors = data.data?.metafieldsSet?.userErrors;
    if (userErrors && userErrors.length > 0) {
      console.error(`[METAFIELD] Shopify errors:`, userErrors);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error(`[METAFIELD] Error updating metafield:`, err.message);
    return false;
  }
}

async function postToMetafields(imageMap) {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    console.warn('[METAFIELD] ⚠ SHOPIFY_STORE or SHOPIFY_TOKEN not configured. Skipping metafield posting.');
    return { successful: 0, failed: 0, skipped: 0 };
  }

  const results = { successful: 0, failed: 0, skipped: 0 };

  for (const [sku, urls] of Object.entries(imageMap)) {
    console.log(`[METAFIELD] Processing SKU: ${sku} (${urls.length} URLs)`);
    
    const productId = await getProductIdBySku(sku);
    if (!productId) {
      console.warn(`[METAFIELD] ⚠ Product not found for SKU: ${sku}`);
      results.skipped++;
      continue;
    }

    const success = await updateProductMetafield(productId, urls);
    if (success) {
      console.log(`[METAFIELD] ✓ Successfully updated metafield for SKU: ${sku}`);
      results.successful++;
    } else {
      console.error(`[METAFIELD] ✗ Failed to update metafield for SKU: ${sku}`);
      results.failed++;
    }
  }

  return results;
}

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
   Body: { keyMode, postToMetafield }
════════════════════════════════════════════════════ */
router.post('/from-sheet', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { keyMode = 'altbase', strictCDN = false, postToMetafield = false } = req.body;

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

  // Post to metafields if requested
  let metafieldResults = null;
  if (postToMetafield) {
    console.log('[JSON] 📤 Posting to Shopify metafields...');
    metafieldResults = await postToMetafields(map);
  }

  res.json({
    data: map,
    metafield: metafieldResults
  });
});

/* ════════════════════════════════════════════════════
   POST /api/json/from-results
   Body: { results: [{ sku, view, url, shopifyUrl, altText }], keyMode, postToMetafield }
════════════════════════════════════════════════════ */
router.post('/from-results', async (req, res) => {
  const { results = [], keyMode = 'altbase', strictCDN = true, postToMetafield = false } = req.body;  // FORCE Shopify URLs
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

  // Post to metafields if requested
  let metafieldResults = null;
  if (postToMetafield) {
    console.log('[JSON] 📤 Posting to Shopify metafields...');
    metafieldResults = await postToMetafields(map);
  }

  res.json({
    data: map,
    metafield: metafieldResults
  });
});

module.exports = router;