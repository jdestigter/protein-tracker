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
- protein_per_unit means protein per single countable unit (per slice, per egg, per oz, etc.)
- If the user says something that isn't food, return an empty items array
- Always respond ONLY with valid JSON, no markdown, no explanation
 
Respond ONLY with this JSON format:
{
  "items": [
    { "name": "chicken breast", "portion": "6 oz", "protein": 42, "needs_clarification": false },
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

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Function error:", error);
    return res.status(500).json({ error: "Failed to process request" });
  }
}
