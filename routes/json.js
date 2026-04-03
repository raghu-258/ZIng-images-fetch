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

/* ════════════════════════════════════════════════════
   POST /api/json/search-product
   Body: { store, token, version, query }
   Returns: [{ id, title, handle }]
════════════════════════════════════════════════════ */
router.post('/search-product', async (req, res) => {
  const { store, token, version = '2025-01', query: searchQuery } = req.body;
  if (!store || !token) return res.status(400).json({ error: 'Missing store or token' });
  if (!searchQuery) return res.status(400).json({ error: 'Missing search query' });

  let normalizedStore = store.trim().replace(/^https?:\/\//, '');
  if (!normalizedStore.includes('.')) normalizedStore += '.myshopify.com';

  const gql = `
    query searchProducts($q: String!) {
      products(first: 10, query: $q) {
        edges {
          node {
            id
            title
            handle
            featuredImage { url }
          }
        }
      }
    }
  `;

  try {
    const r = await fetch(`https://${normalizedStore}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: gql, variables: { q: searchQuery } }),
      timeout: 15000,
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: `Shopify HTTP ${r.status}` });
    if (data.errors) {
      const msg = data.errors.map(e => e.message).join('; ');
      const isAccessDenied = msg.toLowerCase().includes('access denied') || msg.toLowerCase().includes('unauthorized');
      return res.status(400).json({
        error: isAccessDenied
          ? 'Token missing read_products scope. In Shopify Admin → Apps → your custom app → API scopes, enable "Read products" then save and copy the new token.'
          : msg,
      });
    }
    const products = (data.data?.products?.edges || []).map(e => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      image: e.node.featuredImage?.url || null,
    }));
    res.json({ products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   POST /api/json/push-metafield
   Body: { store, token, version, productId, namespace, key, jsonData }
════════════════════════════════════════════════════ */
router.post('/push-metafield', async (req, res) => {
  const { store, token, version = '2025-01', productId, namespace = 'custom', key = 'gallery_images', jsonData } = req.body;
  if (!store || !token) return res.status(400).json({ error: 'Missing store or token' });
  if (!productId) return res.status(400).json({ error: 'Missing productId' });
  if (!jsonData) return res.status(400).json({ error: 'Missing jsonData' });

  let normalizedStore = store.trim().replace(/^https?:\/\//, '');
  if (!normalizedStore.includes('.')) normalizedStore += '.myshopify.com';

  const newData = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;

  // ── Step 1: Fetch existing metafield value ──
  let existingData = {};
  try {
    const fetchQuery = `
      query getMetafield($id: ID!, $ns: String!, $key: String!) {
        product(id: $id) {
          metafield(namespace: $ns, key: $key) { value }
        }
      }
    `;
    const fr = await fetch(`https://${normalizedStore}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: fetchQuery, variables: { id: productId, ns: namespace, key } }),
      timeout: 15000,
    });
    const fd = await fr.json();
    const existing = fd?.data?.product?.metafield?.value;
    if (existing) {
      try { existingData = JSON.parse(existing); } catch (_) { existingData = {}; }
    }
    console.log(`[METAFIELD] Existing keys: ${Object.keys(existingData).join(', ') || 'none'}`);
  } catch (e) {
    console.warn(`[METAFIELD] Could not fetch existing metafield: ${e.message}`);
  }

  // ── Step 2: Merge — append new URLs to existing, deduplicate ──
  const merged = { ...existingData };
  for (const [k, urls] of Object.entries(newData)) {
    if (!merged[k]) {
      merged[k] = urls;
    } else {
      const combined = [...merged[k], ...urls];
      merged[k] = [...new Set(combined)]; // deduplicate
    }
  }

  const addedKeys = Object.keys(newData).length;
  const totalKeys = Object.keys(merged).length;
  console.log(`[METAFIELD] Merging ${addedKeys} new key(s) → total ${totalKeys} key(s)`);

  // ── Step 3: Push merged value ──
  const mutation = `
    mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value }
        userErrors { field message }
      }
    }
  `;

  try {
    const r = await fetch(`https://${normalizedStore}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({
        query: mutation,
        variables: {
          metafields: [{ ownerId: productId, namespace, key, type: 'json', value: JSON.stringify(merged) }],
        },
      }),
      timeout: 15000,
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: `Shopify HTTP ${r.status}` });
    if (data.errors) return res.status(400).json({ error: data.errors.map(e => e.message).join('; ') });
    const ue = data.data?.metafieldsSet?.userErrors || [];
    if (ue.length) return res.status(400).json({ error: ue.map(e => `${e.field}: ${e.message}`).join('; ') });
    const mf = data.data?.metafieldsSet?.metafields?.[0];
    res.json({ success: true, metafield: mf, merged, addedKeys, totalKeys });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;