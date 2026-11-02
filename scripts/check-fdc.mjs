// Live check of the USDA FoodData Central branded lookup in api/parse-food.js.
// Run from the repo root on a machine with the key (never commit the key):
//   FDC_API_KEY=... node scripts/check-fdc.mjs
// Prints, for each sample item, whether a label was used and the protein per
// serving it produced, plus the raw field names of the first FDC hit so we can
// confirm the field names the parser relies on.
import { applyLabelLookups, rankCandidates } from '../api/parse-food.js';

const key = process.env.FDC_API_KEY;
if (!key) {
  console.error('Set FDC_API_KEY first.');
  process.exit(1);
}

// 1) Raw shape of one FDC Branded search result.
const r = await fetch(
  'https://api.nal.usda.gov/fdc/v1/foods/search' +
    `?api_key=${encodeURIComponent(key)}&query=fairlife%20core%20power&dataType=Branded&pageSize=1`
);
console.log(`FDC search HTTP ${r.status}`);
const data = await r.json();
const f = data.foods?.[0];
if (f) {
  const prot = (f.foodNutrients || []).find((x) => x.nutrientNumber === '203' || /^protein$/i.test(x.nutrientName || ''));
  console.log('First hit:', {
    description: f.description,
    brandOwner: f.brandOwner,
    brandName: f.brandName,
    servingSize: f.servingSize,
    servingSizeUnit: f.servingSizeUnit,
    householdServingFullText: f.householdServingFullText,
  });
  console.log('Protein nutrient entry:', prot || '(none found by nutrientNumber 203 or name "Protein")');
  console.log('Nutrient entry keys:', Object.keys(f.foodNutrients?.[0] || {}).join(', '));
}

// 2) The real lookup path on sample items the model would return.
const items = [
  { name: 'Fairlife Core Power shake', protein: 26, brand: 'Fairlife', product: 'Core Power protein shake chocolate', servings: 1 },
  { name: 'Chobani Greek yogurt', protein: 15, brand: 'Chobani', product: 'Greek yogurt plain nonfat', servings: 1 },
  { name: 'Premier Protein shake', protein: 30, brand: 'Premier Protein', product: 'protein shake chocolate', servings: 1 },
  { name: 'Quest bar', protein: 21, brand: 'Quest', product: 'protein bar chocolate chip cookie dough', servings: 1 },
  { name: 'Oikos Pro yogurt', protein: 20, brand: 'Oikos', product: 'Pro yogurt vanilla', servings: 1 },
  { name: 'Kirkland chicken breast', protein: 23, brand: 'Kirkland Signature', product: 'chicken breast', servings: 1 },
];
const before = items.map((i) => i.protein);
const asked = items.map((i) => ({ brand: i.brand, product: i.product }));
await applyLabelLookups(items, key);
console.log('\nItem | model estimate -> result | source | label serving');
items.forEach((i, n) => {
  console.log(`${i.name} | ${before[n]}g -> ${i.protein}g | ${i.source} | ${i.label_serving || '-'}`);
});

// 3) For any item that fell back, show the top FDC candidates and why each was
// rejected (brand / product / serving), so the matcher can be tuned.
for (const [n, i] of items.entries()) {
  if (i.source === 'label') continue;
  const { brand, product } = asked[n];
  const q = `${brand} ${product}`.toLowerCase();
  const res = await fetch(
    'https://api.nal.usda.gov/fdc/v1/foods/search' +
      `?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&dataType=Branded&pageSize=25`
  );
  const d = await res.json();
  console.log(`\n${i.name}: ${d.foods?.length || 0} FDC hits; top 3 candidates:`);
  for (const c of rankCandidates(d.foods, brand, product).slice(0, 3)) {
    const f = c.food;
    console.log(
      `  [${c.reason || 'ok'}] ${f.brandName || '-'} / ${f.brandOwner || '-'} | ${f.description} | ` +
        `${f.servingSize} ${f.servingSizeUnit} | score ${c.score.toFixed(2)} | ` +
        `${c.perServing == null ? 'no protein/serving' : c.perServing.toFixed(1) + 'g'}`
    );
  }
}
