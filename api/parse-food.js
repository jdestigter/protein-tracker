export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
 
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "API key not configured" });
  }
 
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: "No text provided" });
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
 
    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Function error:", error);
    return res.status(500).json({ error: "Failed to process request" });
  }
}
