const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

/* ─── Three fixed angles ─── */
const THREE_ANGLES = [
  { suffix: '0000',  label: 'TV3 – 0°'   },
  { suffix: '0030',  label: 'TV3 – 30°'  },
  { suffix: '0210',  label: 'TV3 – 210°' },
];

/* ─── SKU parsers ─── */

function parseS11Config(sku) {
  // S{model}C{MESH_3chars}{MAT}X  e.g. S111CN74VN39X
  const m = sku.toUpperCase().match(/^S\d+C([A-Z\d]{3})([A-Z\d]+)X/);
  if (!m) return null;
  const frameChar = sku.toUpperCase()[3]; // position 3 = frame letter
  const frameMap  = { B: 'b', C: 'c', D: 'd' };
  return {
    frame: frameMap[frameChar] || 'c',
    mesh:  m[1].toLowerCase(),
    mat:   m[2].toLowerCase(),
  };
}

function parseLibertyConfig(sku) {
  // L{num}{frame}{mesh_letter+2digits}{mat_2letters+2digits}X
  // e.g. L113A N10 ST44 X...
  const m = sku.toUpperCase().match(/^L\d+([A-Z])([A-Z]\d{2})([A-Z]{2}\d{2})X/);
  if (!m) return null;
  return {
    frame: m[1].toLowerCase(),
    mesh:  m[2].toLowerCase(),
    mat:   m[3].toLowerCase(),
  };
}

function parseSku(sku) {
  const u = sku.toUpperCase();
  if (u.startsWith('S11') || u.startsWith('S1')) return parseS11Config(u);
  if (u.startsWith('L'))                          return parseLibertyConfig(u);
  return null;
}

/*
  Apply a SKU's mat/mesh/frame codes into a URL template.
  The URL drives the product family structure; the SKU drives
  the specific colour/material configuration.
  Returns the substituted URL, or null if SKU can't be parsed.
*/
function applyConfigToUrl(templateUrl, sku) {
  const cfg = parseSku(sku);
  if (!cfg) return null;

  let url = templateUrl;
  // material:  $mat=xx  →  $mat={cfg.mat}
  url = url.replace(/(\$mat=)[a-z0-9]+/g,            `$1${cfg.mat}`);
  // mesh:      mesh-mesh-mesh1_xx  →  mesh-mesh-mesh1_{cfg.mesh}
  url = url.replace(/(mesh-mesh-mesh1_)[a-z0-9]+/g,  `$1${cfg.mesh}`);
  // frame:     fram1_x / fram2_x  →  fram1_{cfg.frame} etc.
  url = url.replace(/(fram1_)[a-z]/g,                `$1${cfg.frame}`);
  url = url.replace(/(fram2_)[a-z]/g,                `$1${cfg.frame}`);
  return url;
}

/* Build a full render URL from scratch for S11 SKUs */
function buildRenderUrl(sku, angle) {
  const upper = sku.toUpperCase();
  if (upper.startsWith('S11')) {
    const cfg = parseS11Config(upper);
    if (!cfg) return null;
    const layers = [
      'root-stitches-fs_stat$lt=SO$zo=2',
      `root-stitches-fs-uphl1_up00$lt=RO$zo=3$mat=${cfg.mat}`,
      'root-stitches-fs-fram1_c$lt=SO$zo=36',
      'root-stitches-fs-basescolor-mb-bases-c_drop$lt=SO$zo=50',
      'root-stitches-fs-basescolor-mb-bases-c_stat$lt=SO$zo=51',
      'root-stitches-fs-basescolor-mb-bases-c-fram2_c$lt=SO$zo=54',
      'root-stitches-fs-arms-1_stat$lt=SO$zo=95',
      'root-stitches-fs-arms-1-fram2_c$lt=SO$zo=98',
      'root-stitches-fs-arms-1-mesh-mesh_stat$lt=SO$zo=100',
      `root-stitches-fs-arms-1-mesh-mesh-mesh1_${cfg.mesh}$lt=SO$zo=101`,
    ];
    return `https://machinecore.thebigpicturemachine.com/Ziing3Server/Ziing3.aspx?req=render&humanscale-smart-s11TV3_${angle}&fmt=jpg&bgc=ffffff&size=734&${layers.map(l => `layer=${l}`).join('&')}`;
  }
  return null;
}

/* Shared fetch helper */
async function probeUrl(url) {
  return fetch(url, { method: 'HEAD', timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } })
    .catch(() => fetch(url, { method: 'GET', timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } }));
}

/* ─────────────────────────────────────────────────────────────
   POST /api/probe
   Body: { skus: string[] }
───────────────────────────────────────────────────────────── */
router.post('/', async (req, res) => {
  const { skus = [] } = req.body;
  if (!skus.length) return res.status(400).json({ error: 'No SKUs provided' });

  const results = [];
  await Promise.all(skus.map(async (sku) => {
    const skuUpper = sku.toUpperCase();
    if (!buildRenderUrl(skuUpper, '0000')) {
      console.log(`[PROBE] ✗ ${skuUpper} → unsupported SKU format`);
      return;
    }
    await Promise.all(THREE_ANGLES.map(async ({ suffix, label }, idx) => {
      const url = buildRenderUrl(skuUpper, suffix);
      try {
        const r = await probeUrl(url);
        if (r && (r.ok || r.status === 200)) {
          results.push({ sku: skuUpper, view: idx + 1, url, angle: suffix, label });
          console.log(`[PROBE] ✓ ${skuUpper} ${label}`);
        }
      } catch (e) { console.log(`[PROBE] ✗ ${skuUpper} ${label} → ${e.message}`); }
    }));
  }));

  results.sort((a, b) => a.sku.localeCompare(b.sku) || a.view - b.view);
  res.json({ total: results.length, results });
});

/* ─────────────────────────────────────────────────────────────
   POST /api/probe/url
   Body: { baseUrl: string }
───────────────────────────────────────────────────────────── */
router.post('/url', async (req, res) => {
  const { baseUrl } = req.body;
  if (!baseUrl || typeof baseUrl !== 'string')
    return res.status(400).json({ error: 'baseUrl is required' });

  const results = [];
  await Promise.all(THREE_ANGLES.map(async ({ suffix, label }, idx) => {
    const url = baseUrl.replace(/_\d+/, `_${suffix}`);
    try {
      const r = await probeUrl(url);
      if (r && (r.ok || r.status === 200)) {
        results.push({ view: idx + 1, url, angle: suffix, label });
        console.log(`[PROBE-URL] ✓ angle ${suffix}`);
      }
    } catch (e) { console.log(`[PROBE-URL] ✗ angle ${suffix} → ${e.message}`); }
  }));

  results.sort((a, b) => a.view - b.view);
  res.json({ results, total: results.length });
});

/* ─────────────────────────────────────────────────────────────
   POST /api/probe/url-batch
   Body: { products: [{ url: string, sku: string }] }

   Priority per row:
   1. URL + SKU  → apply SKU's mat/mesh/frame into URL template → 3 angles
   2. SKU only   → build URL from scratch (S11 supported)
   3. URL only   → use URL as-is (SKU is a display label)
───────────────────────────────────────────────────────────── */
router.post('/url-batch', async (req, res) => {
  const { products = [] } = req.body;
  if (!products.length) return res.status(400).json({ error: 'No products provided' });

  const allResults = await Promise.all(products.map(async ({ url: baseUrl, sku }) => {
    const skuLabel = (sku || '').trim().toUpperCase() || 'PRODUCT';
    const hasUrl   = baseUrl && typeof baseUrl === 'string' && baseUrl.trim();
    const hasSku   = skuLabel !== 'PRODUCT';

    let getUrl;

    if (hasUrl && hasSku) {
      // Case 1: URL is the template, SKU provides mat/mesh/frame
      const configured = applyConfigToUrl(baseUrl.trim(), skuLabel);
      if (configured) {
        console.log(`[BATCH] ${skuLabel} → SKU config applied to URL template (mat/mesh/frame substituted)`);
        getUrl = (suffix) => configured.replace(/_\d+/, `_${suffix}`);
      } else {
        // SKU not parseable — use URL as-is, treat SKU as label only
        console.log(`[BATCH] ${skuLabel} → URL used as-is (SKU label only)`);
        getUrl = (suffix) => baseUrl.trim().replace(/_\d+/, `_${suffix}`);
      }
    } else if (!hasUrl && hasSku) {
      // Case 2: build URL from SKU (S11 only currently)
      const testUrl = buildRenderUrl(skuLabel, '0000');
      if (testUrl) {
        console.log(`[BATCH] ${skuLabel} → built from SKU`);
        getUrl = (suffix) => buildRenderUrl(skuLabel, suffix);
      } else {
        return { sku: skuLabel, images: [], error: 'Paste a render URL for this product family (SKU-only not supported yet)' };
      }
    } else if (hasUrl) {
      // Case 3: URL only, no SKU
      console.log(`[BATCH] ${skuLabel} → URL only`);
      getUrl = (suffix) => baseUrl.trim().replace(/_\d+/, `_${suffix}`);
    } else {
      return { sku: skuLabel, images: [], error: 'Provide at least a URL or SKU' };
    }

    const images = [];
    await Promise.all(THREE_ANGLES.map(async ({ suffix, label }, idx) => {
      const url = getUrl(suffix);
      try {
        const r = await probeUrl(url);
        if (r && (r.ok || r.status === 200)) {
          images.push({ sku: skuLabel, view: idx + 1, url, angle: suffix, label });
          console.log(`[BATCH] ✓ ${skuLabel} ${label}`);
        } else {
          console.log(`[BATCH] ✗ ${skuLabel} ${label} → ${r?.status}`);
        }
      } catch (e) { console.log(`[BATCH] ✗ ${skuLabel} ${label} → ${e.message}`); }
    }));

    images.sort((a, b) => a.view - b.view);
    return { sku: skuLabel, images };
  }));

  const total = allResults.reduce((sum, p) => sum + p.images.length, 0);
  console.log(`[BATCH] Complete: ${total} image(s) for ${products.length} product(s)`);
  res.json({ total, products: allResults });
});

/* ─────────────────────────────────────────────────────────────
   POST /api/probe/bulk-url
   Body: { templateUrl: string, skus: string[] }
   One locked URL template + many SKUs → 3 angles each.
───────────────────────────────────────────────────────────── */
router.post('/bulk-url', async (req, res) => {
  const { templateUrl, skus = [] } = req.body;
  if (!templateUrl) return res.status(400).json({ error: 'templateUrl is required' });
  if (!skus.length)  return res.status(400).json({ error: 'No SKUs provided' });

  const allResults = await Promise.all(skus.map(async (sku) => {
    const skuLabel = (sku || '').trim().toUpperCase();
    if (!skuLabel) return null;

    const configured = applyConfigToUrl(templateUrl, skuLabel);
    const getUrl = configured
      ? (suffix) => configured.replace(/_\d+/, `_${suffix}`)
      : (suffix) => templateUrl.replace(/_\d+/, `_${suffix}`);

    if (!configured) console.log(`[BULK] ${skuLabel} → SKU not parsed, using template as-is`);
    else              console.log(`[BULK] ${skuLabel} → mat/mesh/frame applied`);

    const images = [];
    await Promise.all(THREE_ANGLES.map(async ({ suffix, label }, idx) => {
      const url = getUrl(suffix);
      try {
        const r = await probeUrl(url);
        if (r && (r.ok || r.status === 200)) {
          images.push({ sku: skuLabel, view: idx + 1, url, angle: suffix, label });
          console.log(`[BULK] ✓ ${skuLabel} ${label}`);
        } else {
          console.log(`[BULK] ✗ ${skuLabel} ${label} → ${r?.status}`);
        }
      } catch (e) { console.log(`[BULK] ✗ ${skuLabel} ${label} → ${e.message}`); }
    }));

    images.sort((a, b) => a.view - b.view);
    return { sku: skuLabel, images };
  }));

  const products = allResults.filter(Boolean);
  const total    = products.reduce((sum, p) => sum + p.images.length, 0);
  console.log(`[BULK] Complete: ${total} image(s) for ${products.length} SKU(s)`);
  res.json({ total, products });
});

module.exports = router;
