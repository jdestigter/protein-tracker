// ---------------------------------------------------------------------------
// Abuse guards (added 2026-08-24).
//
// Why: this endpoint is unauthenticated and spends ANTHROPIC_API_KEY on every
// call. Before this change an oversized POST could cost ~$0.05 in a single
// request and nothing limited how many requests one caller could make.
//
// The input cap is the load-bearing control: it bounds worst-case spend per
// request to a fraction of a cent. The rate limiter is best-effort only --
// Vercel functions are stateless and this Map lives per warm instance, so a
// distributed caller can still get around it. It stops naive scripted abuse,
// not a determined attacker. The real fix is a KV-backed limiter (Vercel KV /
// Upstash); see the GTM log for that recommendation.
//
// NOTE: deliberately NO Origin allowlist. These endpoints are called by the
// React Native apps, which do not send a browser Origin header. An allowlist
// would break the apps and would not stop curl anyway.
// ---------------------------------------------------------------------------
const MAX_INPUT_CHARS = 1000;
const RL_MINUTE_MAX = 30;
const RL_HOUR_MAX = 300;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const hits = new Map(); // ip -> timestamps[] (per warm instance, best-effort)

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();

  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > HOUR_MS) hits.delete(k);
    }
  }

  const recent = (hits.get(ip) || []).filter((t) => now - t < HOUR_MS);
  const lastMinute = recent.filter((t) => now - t < MINUTE_MS).length;

  if (lastMinute >= RL_MINUTE_MAX || recent.length >= RL_HOUR_MAX) {
    hits.set(ip, recent);
    return true;
  }

  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// Returns a trimmed string, or null if the input is unusable.
function cleanText(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_INPUT_CHARS) return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

// ---------------------------------------------------------------------------
// Branded label lookup (added 2026-11).
//
// Why: users reported branded items coming back at ~2x the package label even
// after the 2026-09-22 prompt change ("prefer package label for named brands").
// The model guesses labels from memory; this looks the product up in USDA
// FoodData Central's Branded Foods data instead.
//
// How: the model now tags branded items with `brand`, `product` and `servings`.
// For those items we search FDC, keep only a confident match (brand matches and
// most product words appear), convert FDC's per-100g protein to per-serving, and
// overwrite `protein`. Each item gets `source: "label"` or `source: "estimate"`.
//
// Safe by default: no FDC_API_KEY env var -> lookup is skipped and responses are
// exactly what they were before (plus `source: "estimate"`). Any FDC error,
// timeout or weak match falls back to the model's estimate. The app ignores
// fields it does not know, so the response stays backward compatible.
// ---------------------------------------------------------------------------
const FDC_TIMEOUT_MS = 2500;
const FDC_CACHE_MAX = 500;
const fdcCache = new Map(); // query -> result|null (per warm instance)

function words(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

// FDC Branded values are per 100 g / 100 ml. Returns grams protein per label
// serving, or null when the record can't be converted reliably.
function proteinPerServing(food) {
  const n = (food.foodNutrients || []).find(
    (x) => x.nutrientNumber === '203' || /^protein$/i.test(x.nutrientName || '')
  );
  const per100 = Number(n?.value);
  const size = Number(food.servingSize);
  const unit = String(food.servingSizeUnit || '').toLowerCase();
  if (!Number.isFinite(per100) || !Number.isFinite(size) || size <= 0) return null;
  if (!['g', 'grm', 'ml', 'mlt'].includes(unit)) return null;
  const grams = (per100 * size) / 100;
  return grams >= 0 && grams <= 80 ? grams : null; // sanity bound per serving
}

// Pick a match only when the brand matches and most product words appear.
function bestMatch(foods, brand, product) {
  const b = words(brand).join(' ');
  const want = words(product);
  let best = null;
  for (const f of foods || []) {
    const owner = words(`${f.brandName || ''} ${f.brandOwner || ''}`).join(' ');
    if (!b || !owner.includes(b)) continue;
    const have = new Set(words(f.description));
    const hits = want.filter((w) => have.has(w)).length;
    const score = want.length ? hits / want.length : 0;
    const perServing = proteinPerServing(f);
    if (perServing == null || score < 0.6) continue;
    if (!best || score > best.score) best = { food: f, score, perServing };
  }
  return best;
}

async function lookupBranded(brand, product, apiKey) {
  const query = `${brand} ${product}`.trim().toLowerCase();
  if (fdcCache.has(query)) return fdcCache.get(query);

  const url =
    'https://api.nal.usda.gov/fdc/v1/foods/search' +
    `?api_key=${encodeURIComponent(apiKey)}` +
    `&query=${encodeURIComponent(query)}` +
    '&dataType=Branded&pageSize=10';

  let result = null;
  let cacheable = false; // only cache real answers, never errors or timeouts
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(FDC_TIMEOUT_MS) });
    if (r.ok) {
      cacheable = true;
      const data = await r.json();
      const m = bestMatch(data.foods, brand, product);
      if (m) {
        result = {
          perServing: m.perServing,
          serving: m.food.householdServingFullText || `${m.food.servingSize} ${m.food.servingSizeUnit}`,
          fdcId: m.food.fdcId,
        };
      }
    }
  } catch (e) {
    console.error('FDC lookup failed:', e?.name || e);
  }

  if (cacheable) {
    if (fdcCache.size >= FDC_CACHE_MAX) fdcCache.clear();
    fdcCache.set(query, result);
  }
  return result;
}

export async function applyLabelLookups(items, apiKey) {
  await Promise.all(
    items.map(async (item) => {
      if (!item || typeof item !== 'object') return;
      item.source = 'estimate';
      if (!apiKey || item.needs_clarification || item.user_stated_protein) return;
      if (typeof item.brand !== 'string' || typeof item.product !== 'string') return;
      const hit = await lookupBranded(item.brand, item.product, apiKey);
      if (!hit) return;
      const servings = Number(item.servings) > 0 && Number(item.servings) <= 20 ? Number(item.servings) : 1;
      item.protein = Math.round(hit.perServing * servings);
      item.source = 'label';
      item.label_serving = hit.serving;
    })
  );
  return items;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
 
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Too many requests" });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "API key not configured" });
  }
 
  try {
    const text = cleanText((req.body || {}).text);
    if (!text) {
      return res.status(400).json({ error: "Invalid input" });
    }
 
    const systemPrompt = `You are a precise nutritionist AI. The user will tell you what they ate. Parse each food item and estimate protein in grams.
 
CRITICAL RULES FOR needs_clarification:
- ONLY set needs_clarification to true when the user gives a bare food name with NO quantity or amount whatsoever (e.g. just "bacon", "chicken", "eggs", "a cookie")
- If the user provides ANY quantity — a number ("one cookie", "2 eggs", "3 slices"), a word amount ("a couple eggs", "some chicken"), a portion ("a bowl of", "a plate of", "a cup of"), or a size ("large cookie", "small steak") — set needs_clarification to FALSE and estimate the protein
- "one chocolate chip cookie" = quantity provided (one) → needs_clarification: false
- "a protein shake" = quantity provided (a/one) → needs_clarification: false  
- "chicken breast" with no amount = needs_clarification: true
- When in doubt, DEFAULT to needs_clarification: false and estimate a reasonable single serving
- Be realistic with protein estimates based on USDA data
- Round to nearest whole gram

PORTION SIZING RULES (the most common error is overestimating small-format foods — size the unit, not just the food):
- Words that signal a SMALL unit: breakfast, mini, small, slider, cocktail, snack-size, fun-size, bite-size, party, link, stick, nugget, popper. Use the small unit's real weight, not a full-size default.
- Breakfast sausage is small: a breakfast patty is about 1 oz (5–7 g protein each); a breakfast link is about 0.75 oz (2–3 g protein each). This applies to chicken, turkey and pork breakfast sausage alike.
- Dinner sausage is large: an Italian sausage, bratwurst or kielbasa link is about 3 oz (12–16 g protein each). Do NOT apply dinner-sausage numbers to anything described as breakfast sausage, and do not apply breakfast numbers to dinner sausage.
- Other small units: cocktail meatball ≈ 2 g each, mini bagel ≈ 3 g each, slider ≈ 7–9 g each, turkey bacon ≈ 2 g per slice, fun-size candy bar ≈ 1 g.
- If the user states a protein amount ("13 grams", "20g protein"), use that number exactly and do not estimate.
- If a brand or packaged product is named, estimate from that product's typical label rather than a generic version of the food.
- For a named brand or packaged product, ALSO include "brand" (the brand only, e.g. "Fairlife"), "product" (the product name without the brand, e.g. "Core Power Elite chocolate shake") and "servings" (how many label servings were eaten, default 1). Omit these three fields for unbranded foods.
- If the user states a protein amount, include "user_stated_protein": true.
- protein_per_unit means protein per single countable unit (per slice, per egg, per oz, etc.)
- If the user says something that isn't food, return an empty items array
- Always respond ONLY with valid JSON, no markdown, no explanation
 
Respond ONLY with this JSON format:
{
  "items": [
    { "name": "chicken breast", "portion": "6 oz", "protein": 42, "needs_clarification": false },
    { "name": "Fairlife Core Power shake", "portion": "1 bottle", "protein": 26, "needs_clarification": false, "brand": "Fairlife", "product": "Core Power protein shake", "servings": 1 },
    { "name": "bacon", "needs_clarification": true, "default_portion": "3 slices", "unit": "slice", "protein_per_unit": 4 }
  ]
}`;
 
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: text }],
      }),
    });
 
    const data = await response.json();
 
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || "API request failed" });
    }
 
    const content = data.content?.[0]?.text || "";
    const cleaned = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    // Shape guard: never hand the app something it can't iterate.
    if (!parsed || !Array.isArray(parsed.items)) {
      return res.status(200).json({ items: [] });
    }

    await applyLabelLookups(parsed.items, process.env.FDC_API_KEY);

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Function error:", error);
    return res.status(500).json({ error: "Failed to process request" });
  }
}
