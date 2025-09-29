// /api/gift-finder.js

function fallbackRank(products, criteria) {
  const { interests = '', recipient = '', occasion = '', budgetMin, budgetMax } = criteria || {};
  const words = interests.toLowerCase().split(/[, ]+/).filter(Boolean);
  const min = Number(budgetMin) || 0;
  const max = Number(budgetMax) || Infinity;
  const margin = 0.25; // +/-25% wiggle room

  const withinBudget = (p) =>
    p.price >= min * (1 - margin) && p.price <= (isFinite(max) ? max * (1 + margin) : Infinity);

  const base = products.filter(withinBudget);
  const pool = base.length ? base : products;

  const scored = pool.map((p) => {
    let score = 0;
    const text = [p.title, p.vendor, p.type, (p.tags || []).join(' '), p.description]
      .join(' ')
      .toLowerCase();
    for (const w of words) if (w && text.includes(w)) score += 2;
    if (recipient && text.includes(recipient.toLowerCase())) score += 1;
    if (occasion && text.includes(occasion.toLowerCase())) score += 1;
    if (isFinite(max) && p.price >= min && p.price <= max) score += 1;
    return { p, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.p.price - b.p.price)
    .slice(0, 3)
    .map(({ p, score }) => ({
      handle: p.handle,
      title: p.title,
      reason: 'Matched your interests/budget',
      score,
    }));
}

export default async function handler(req, res) {
  const ALLOWED_ORIGIN = `https://${process.env.SHOPIFY_STOREFRONT_DOMAIN}`;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body || {};
    const { recipient, occasion, interests, budgetMin, budgetMax } = body;

    // 1) Fetch products from Shopify Storefront
    const sfRes = await fetch(`https://${process.env.SHOPIFY_STOREFRONT_DOMAIN}/api/2024-04/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN
      },
      body: JSON.stringify({
        query: `
        query GiftFinderProducts {
          products(first: 30, sortKey: BEST_SELLING) {
            edges {
              node {
                id
                title
                handle
                vendor
                productType
                tags
                description(truncateAt: 160)
                priceRange { minVariantPrice { amount currencyCode } }
                images(first: 1) { edges { node { url altText } } }
              }
            }
          }
        }`
      })
    });

    const sfJson = await sfRes.json();
    const nodes = (sfJson?.data?.products?.edges || []).map(e => e.node);
    const products = nodes.map(p => ({
      id: p.id,
      handle: p.handle,
      title: p.title,
      vendor: p.vendor,
      type: p.productType,
      tags: p.tags,
      description: p.description,
      price: Number(p.priceRange?.minVariantPrice?.amount || 0),
      currency: p.priceRange?.minVariantPrice?.currencyCode || 'INR',
      image: p.images?.edges?.[0]?.node?.url || null
    }));

    console.log('[gift-finder] products:', products.length, 'criteria:', {recipient, occasion, interests, budgetMin, budgetMax});

    // 2) Ask AI (force JSON) to pick top 3
    const prompt = {
      criteria: { recipient, occasion, interests, budgetMin, budgetMax },
      instructions: [
        "Pick the BEST 3 products from the list.",
        "Prefer diversity (type/brand).",
        "Respect budget if given; allow +/- 25%.",
        "Return JSON only: {\"recommendations\":[{\"handle\":\"<handle-from-list>\",\"title\":\"...\",\"reason\":\"...\",\"score\":<number>}]}"
      ],
      products,
      handles: products.map(p => p.handle)
    };

    let recs = [];
    try {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are an ecommerce gift assistant. Output valid JSON only.' },
            { role: 'user', content: JSON.stringify(prompt) }
          ]
        })
      });
      const openaiJson = await openaiRes.json();
      const content = openaiJson?.choices?.[0]?.message?.content || '{}';
      console.log('[gift-finder] openai content:', content.slice(0, 300));
      try {
        const parsed = JSON.parse(content);
        recs = (parsed?.recommendations || []).slice(0, 3);
      } catch { recs = []; }
    } catch (e) {
      console.log('[gift-finder] openai error:', e?.message || e);
      recs = [];
    }

    // 3) Fallback if AI returned nothing
    if (!recs.length) {
      recs = fallbackRank(products, { recipient, occasion, interests, budgetMin, budgetMax });
      console.log('[gift-finder] using fallback, count:', recs.length);
    }

    // 4) Enrich with details
    const byHandle = Object.fromEntries(products.map(p => [p.handle, p]));
    const results = recs.map(r => {
      const p = byHandle[r.handle] || {};
      return {
        handle: r.handle,
        title: r.title || p.title,
        url: `https://${process.env.SHOPIFY_STOREFRONT_DOMAIN}/products/${r.handle}`,
        image: p.image,
        price: p.price,
        currency: p.currency,
        reason: r.reason || 'A good match for your criteria',
        score: r.score || 0
      };
    });

    return res.status(200).json({ results });
  } catch (err) {
    console.error('[gift-finder] fatal error:', err);
    return res.status(500).json({ error: 'AI gift finder failed' });
  }
}
