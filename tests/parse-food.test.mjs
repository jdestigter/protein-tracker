// Offline tests for the branded label lookup. Run: node --test tests/*.test.mjs
// FDC responses are mocked; the Core Power record is the real shape Jason's
// live run returned on 2026-11-02.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLabelLookups, bestMatch } from '../api/parse-food.js';

const prot = (value) => [{ nutrientId: 1003, nutrientName: 'Protein', nutrientNumber: '203', unitName: 'G', value }];
const food = (o) => ({ fdcId: Math.floor(Math.random() * 1e7), foodNutrients: prot(o.per100), ...o });

const corePowerBanana = food({
  description: 'CORE POWER, HIGH PROTEIN MILK SHAKE, BANANA, BANANA',
  brandOwner: 'Fair Oaks Farms Brands, Inc.', brandName: 'CORE POWER',
  servingSize: 340, servingSizeUnit: 'ml', householdServingFullText: '11.5 OZA', per100: 7.65,
});
const corePowerChoc = food({
  description: 'CORE POWER, HIGH PROTEIN MILK SHAKE, CHOCOLATE',
  brandOwner: 'Fair Oaks Farms Brands, Inc.', brandName: 'CORE POWER',
  servingSize: 340, servingSizeUnit: 'ml', householdServingFullText: '11.5 OZA', per100: 7.65,
});
const chobani = food({
  description: 'NON-FAT GREEK YOGURT, PLAIN', brandOwner: 'Chobani Global Holdings, LLC', brandName: 'CHOBANI',
  servingSize: 170, servingSizeUnit: 'g', per100: 9.41,
});
const kirkland = food({
  description: 'BONELESS SKINLESS CHICKEN BREASTS', brandOwner: 'Costco Companies Inc.', brandName: 'KIRKLAND SIGNATURE',
  servingSize: 112, servingSizeUnit: 'g', per100: 20.5,
});
const premier = food({
  description: 'HIGH PROTEIN SHAKE, CHOCOLATE', brandOwner: 'Premier Nutrition Company, LLC', brandName: 'PREMIER PROTEIN',
  servingSize: 325, servingSizeUnit: 'MLT', per100: 9.23,
});
const otherBrandShake = food({
  description: 'PROTEIN SHAKE, CHOCOLATE', brandOwner: 'Muscle Milk', brandName: 'MUSCLE MILK',
  servingSize: 414, servingSizeUnit: 'ml', per100: 6.04,
});

test('Fairlife Core Power matches via FDC brandName, any flavour', () => {
  const m = bestMatch([corePowerBanana], 'Fairlife', 'Core Power protein shake chocolate');
  assert.ok(m);
  assert.equal(Math.round(m.perServing), 26);
});

test('flavour breaks ties when several flavours come back', () => {
  const m = bestMatch([corePowerBanana, corePowerChoc], 'Fairlife', 'Core Power protein shake chocolate');
  assert.equal(m.food.description, corePowerChoc.description);
});

test('non-fat vs nonfat and plain-as-flavour match Chobani', () => {
  const m = bestMatch([chobani], 'Chobani', 'Greek yogurt plain nonfat');
  assert.ok(m);
  assert.equal(Math.round(m.perServing), 16);
});

test('plural description matches singular product (Kirkland)', () => {
  assert.ok(bestMatch([kirkland], 'Kirkland Signature', 'chicken breast'));
});

test('MLT serving unit and brand words inside product (Premier Protein)', () => {
  const m = bestMatch([premier], 'Premier Protein', 'protein shake chocolate');
  assert.ok(m);
  assert.equal(Math.round(m.perServing), 30);
});

test('another brand with the same product never matches', () => {
  assert.equal(bestMatch([otherBrandShake], 'Premier Protein', 'protein shake chocolate'), null);
  assert.equal(bestMatch([otherBrandShake], 'Fairlife', 'Core Power protein shake'), null);
});

test('wrong product from the right brand does not match', () => {
  const bar = food({ description: 'PROTEIN BAR, CHOCOLATE CHIP', brandOwner: 'Chobani Global Holdings, LLC', brandName: 'CHOBANI', servingSize: 60, servingSizeUnit: 'g', per100: 20 });
  assert.equal(bestMatch([bar], 'Chobani', 'Greek yogurt plain nonfat'), null);
});

test('record without a usable serving is rejected', () => {
  const noServing = { ...corePowerChoc, servingSizeUnit: 'oz' };
  assert.equal(bestMatch([noServing], 'Fairlife', 'Core Power protein shake'), null);
});

function mockFetch(foods, { ok = true, throws = false } = {}) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (throws) throw new Error('network');
    return { ok, status: ok ? 200 : 500, json: async () => ({ foods }) };
  };
  return () => calls;
}

test('applyLabelLookups overwrites protein and tags source: label', async () => {
  mockFetch([corePowerChoc]);
  const items = [{ name: 'Core Power', protein: 42, brand: 'Fairlife', product: 'Core Power Elite shake chocolate mk1', servings: 1 }];
  // "elite" and "mk1" are not in the description: 1 of 3 required words -> rejected.
  await applyLabelLookups(items, 'k');
  assert.equal(items[0].source, 'estimate');
  assert.equal(items[0].protein, 42);

  const items2 = [{ name: 'Core Power', protein: 42, brand: 'Fairlife', product: 'Core Power protein shake chocolate (t2)', servings: 2 }];
  await applyLabelLookups(items2, 'k');
  assert.equal(items2[0].source, 'label');
  assert.equal(items2[0].protein, 52);
  assert.equal(items2[0].label_serving, '11.5 OZA');
});

test('no key, unbranded, clarification and user-stated items are left alone', async () => {
  const calls = mockFetch([corePowerChoc]);
  const items = [
    { name: 'eggs', protein: 12 },
    { name: 'bacon', needs_clarification: true, brand: 'Oscar Mayer', product: 'bacon' },
    { name: 'shake', protein: 30, user_stated_protein: true, brand: 'Fairlife', product: 'Core Power shake' },
  ];
  await applyLabelLookups(items, 'k');
  assert.deepEqual(items.map((i) => i.source), ['estimate', 'estimate', 'estimate']);
  const noKey = [{ name: 'x', protein: 10, brand: 'Fairlife', product: 'Core Power shake (nokey)' }];
  await applyLabelLookups(noKey, undefined);
  assert.equal(noKey[0].protein, 10);
  assert.equal(calls(), 0);
});

test('FDC errors fall back to the estimate', async () => {
  mockFetch([], { ok: false });
  const a = [{ name: 'x', protein: 20, brand: 'Chobani', product: 'Greek yogurt (err1)' }];
  await applyLabelLookups(a, 'k');
  assert.equal(a[0].protein, 20);
  mockFetch([], { throws: true });
  const b = [{ name: 'x', protein: 20, brand: 'Chobani', product: 'Greek yogurt (err2)' }];
  await applyLabelLookups(b, 'k');
  assert.equal(b[0].source, 'estimate');
});
