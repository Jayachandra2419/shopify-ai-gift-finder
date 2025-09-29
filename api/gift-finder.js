// /api/gift-finder.js
export default async function handler(req, res) {
  const ALLOWED_ORIGIN = `https://${process.env.SHOPIFY_STOREFRONT_DOMAIN}`;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { recipient, occasion, interests, budgetMin, budgetMax } = req.body || {};

    // 1) Fetch products (server-side) from Shopify Storefront API
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
              edges { node {
                id title handle vendor productType tags
                description(truncateAt: 160)
                priceRange { minVariantPrice { amount currencyCode } }
                images(first:1){ edges { node { url altText } } }
              } }
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

    // 2) Ask AI to pick top 3
    const prompt = {
      criteria: { recipient, occasion, interests, budgetMin, budgetMax },
      instructions: [
        "Pick the BEST 3 products from the list.",
        "Respect budget if given (+/- 10%).",
        "Prefer diversity (type/brand).",
        "Return JSON only: {\"recommendations\":[{handle,title,reason,score}]}"
      ],
      products
    };

    const ai = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are an ecommerce gift assistant. Output valid JSON only.' },
          { role: 'user', content: JSON.stringify(prompt) }
        ]
      })
    });
    const aiJson = await ai.json();
    const content = aiJson?.choices?.[0]?.message?.content || '{}';

    let parsed; try { parsed = JSON.parse(content); } catch { parsed = { recommendations: [] }; }
    const recs = (parsed.recommendations || []).slice(0, 3);

    // 3) Enrich with price/image/url
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
        reason: r.reason || 'Great match for your criteria',
        score: r.score || 0
      };
    });

    res.status(200).json({ results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'AI gift finder failed' });
  }
}
