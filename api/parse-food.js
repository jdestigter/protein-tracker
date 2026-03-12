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

    const systemPrompt = `You are a precise nutritionist AI. The user will tell you what they ate. Parse each food item mentioned and estimate the protein content in grams.

RULES:
- If a quantity/portion IS specified (e.g. "3 eggs", "8 oz chicken", "2 scoops protein powder", "a cup of yogurt"), calculate protein for that amount and mark needs_clarification as false.
- If a quantity/portion is NOT specified (e.g. just "bacon", "chicken", "eggs"), mark needs_clarification as true and suggest a common portion as default_portion. Do NOT assume a quantity — let the user confirm.
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
        model: "claude-sonnet-4-20250514",
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
