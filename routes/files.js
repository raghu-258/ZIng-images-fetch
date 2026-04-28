const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

function normalizeStore(store) {
  let s = store.trim();
  const m = s.match(/^(?:https?:\/\/)?([^\/]+)/);
  if (m) s = m[1];
  if (!s.includes('.')) s += '.myshopify.com';
  return s;
}

async function shopifyGQL(store, token, version, query, variables = {}) {
  const url = `https://${normalizeStore(store)}/admin/api/${version}/graphql.json`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body:    JSON.stringify({ query, variables }),
    timeout: 30000,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${text.substring(0, 150)}`);
  const data = JSON.parse(text);
  if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join('; '));
  return data;
}

/* ── List files (with optional alt text search) ── */
router.post('/list', async (req, res) => {
  const { store, token, version = '2025-01', search = '', cursor = null } = req.body;
  if (!store || !token) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const gql = `
      query listFiles($first: Int!, $after: String, $query: String) {
        files(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
          edges {
            cursor
            node {
              id
              alt
              createdAt
              ... on MediaImage {
                image { url width height }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const searchQuery = search.trim()
      ? `(${search.trim()}) media_type:IMAGE`
      : 'media_type:IMAGE';

    const data = await shopifyGQL(store, token, version, gql, {
      first: 50,
      after: cursor || null,
      query: searchQuery,
    });

    const edges = data.data.files.edges;
    res.json({
      files: edges.map(e => ({
        id:        e.node.id,
        alt:       e.node.alt || '',
        url:       e.node.image?.url || null,
        cursor:    e.cursor,
      })),
      pageInfo: data.data.files.pageInfo,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Bulk update alt text ── */
router.post('/update-alt', async (req, res) => {
  const { store, token, version = '2025-01', files } = req.body;
  if (!store || !token) return res.status(400).json({ error: 'Missing credentials' });
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'No files provided' });

  try {
    const mutation = `
      mutation fileUpdate($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) {
          files { id alt }
          userErrors { field message }
        }
      }
    `;
    const data   = await shopifyGQL(store, token, version, mutation, {
      files: files.map(f => ({ id: f.id, alt: f.alt })),
    });
    const result = data.data.fileUpdate;
    if (result.userErrors?.length) {
      return res.status(400).json({ error: result.userErrors.map(e => e.message).join('; ') });
    }
    res.json({ updated: result.files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;