#!/usr/bin/env node
// End-to-end check of the Table 2B builder in public/index.html.
//
//   node tools/verify-table2b.js
//
// Runs the shipped page code over a synthetic /all-data payload built to exercise every
// rule that was a real correction: declined recommendations, the recommendation fold,
// COOL/HEAT merging, per-unit deemed savings, climate-zone selection, non-measure costs,
// and the unsupported-zone refusal. No SnuggPro request is made and no customer data is
// involved, so this is safe to run anywhere.

const fs = require('fs');
const path = require('path');

const REF = path.join(__dirname, '..', 'public', 'reference');
const readRef = n => JSON.parse(fs.readFileSync(path.join(REF, n + '.json'), 'utf8'));

function loadPage() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('no inline <script> block in public/index.html');
  const stubEl = { style: {}, textContent: '', innerHTML: '', value: '', classList: { add() {}, remove() {} }, dataset: {}, addEventListener() {} };
  const document = { querySelectorAll: () => [], getElementById: () => stubEl, addEventListener() {} };
  const exported = ['buildTable2B', 'classifyHvac', 'climateZoneFor', 'flattenMeasures', 'pathLabel'];
  const factory = new Function('document', 'window', 'fetch', 'alert', 'navigator', 'JSZip',
    m[1] + '\nreturn {' + exported.join(',') +
    ', setReference: r => { reference = r; }' +
    ', setOptions: o => { t2bIncludeNonMeasure = o.includeNonMeasure; t2bCompletedOnly = o.completedOnly; }};');
  return factory(document, { addEventListener() {} },
    async () => { throw new Error('no network in this harness'); }, () => {}, {}, null);
}

// --- synthetic job ------------------------------------------------------------

// Twelve months of billing. Same series shape flattenUsage() reads from /all-data.
function utilities(kwhPerMonth, thermsPerMonth) {
  const u = { electricBillUnits: 'kWh', fuelBillUnits: 'Therms', startElectricDate1: '2025-01-01', startFuelDate1: '2025-01-01' };
  for (let i = 1; i <= 12; i++) {
    const date = i === 12 ? '2026-01-01' : '2025-' + String(i + 1).padStart(2, '0') + '-01';
    u['endElectricDate' + i] = date; u['endElectricBill' + i] = kwhPerMonth;
    u['endFuelDate' + i] = date; u['endFuelBill' + i] = thermsPerMonth;
  }
  return u;
}

function job(overrides) {
  return Object.assign({
    job: { id: 900001, zip: '91701', stageId: 6 },   // 91701 is climate zone 10
    house: { typeOfHome: 'Single Family' },
    // Furnace / Central AC on natural gas classifies as rDXGF.
    hvacs: [{ hvacSystemEquipmentType: 'Furnace / Central AC', hvacHeatingEnergySource: 'Natural Gas' }],
    utilities: utilities(700, 15),
    totals: { totalSavings: 300 },
    rebatesIncentives: [{
      code: 'deemedAndModeledKwhSavings',
      metadataJSON: JSON.stringify([{ key: 'combinedTotalEnergySavings', value: 12 }])
    }],
    recommendations: [
      { status: '1', title: 'Insulate Attic', savedKwh: 900, savedTherms: 18, savedMbtu: 4.9, cost: 3450, sir: 1.2,
        detailedCosts: [{ name: 'Attic Insulation - Add R-30', code: 'SWBE006-02-R-30', quantity: 1500, unit: 'sq. ft', costPerUnit: 2.3 }] },

      // One recommendation total spread over two cost lines: the fold must count 600 kWh
      // once and split it 2:1 by cost, not report 1200.
      { status: '1', title: 'Seal Duct Work', savedKwh: 600, savedTherms: 6, savedMbtu: 2.5, cost: 900,
        detailedCosts: [
          { name: 'Duct Seal - 120 Minutes', code: 'DS0003', quantity: 1, unit: 'each', costPerUnit: 600 },
          { name: 'Duct Seal - 90 Minutes', code: 'DS0002', quantity: 1, unit: 'each', costPerUnit: 300 }
        ] },

      // Declined. Its savings must not reach the report at all.
      { status: '3', title: 'Declined Measure', savedKwh: 99999, savedTherms: 9999, cost: 50000,
        detailedCosts: [{ name: 'Should Not Appear', code: 'SWHC030-02-W-E', quantity: 1, unit: 'each', costPerUnit: 50000 }] },

      // A split system: two halves, one system, half the cost each.
      { status: '1', title: 'Upgrade Cooling System', savedKwh: 2000, savedTherms: 10, savedMbtu: 7.8, cost: 9350,
        detailedCosts: [
          { name: 'Replace Split AC and Gas FAU (COOL), 15.2+ SEER2, 3.5 Tons', code: 'SWHC049-03-SAC-FAU-15.2-S2-3.5T-COOL', quantity: 1, unit: 'each', costPerUnit: 4675 },
          { name: 'Replace Split AC and Gas FAU (HEAT), 15.2+ SEER2, 3.5 Tons', code: 'SWHC049-03-SAC-FAU-15.2-S2-3.5T-HEAT', quantity: 1, unit: 'each', costPerUnit: 4675 }
        ] }
    ],
    directInstalls: [{
      lineItems: [
        // Deemed savings on a direct install are PER UNIT; quantity 2 must double them.
        { name: 'Faucet Aerator Lavatory - 1.2 GPM, Gas DHW, AOE, CZ10', code: 'SWWH001-03-L-G-CZ10',
          quantity: 2, unit: 'each', costPerUnit: 5, deemedAnnualKwhSavings: 3.44, deemedThermsSavings: 2.77 },
        { name: 'Energy Audit', code: '', quantity: 1, unit: 'each', costPerUnit: 337 },
        { name: 'Building Department Permit', code: '', quantity: 1, unit: 'each', costPerUnit: 225 }
      ]
    }]
  }, overrides || {});
}

// --- checks -------------------------------------------------------------------

let failures = 0;
function check(label, actual, expected, tol) {
  const ok = typeof expected === 'number' && typeof tol === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected;
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(56) +
    (ok ? String(actual) : 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)));
}

function main() {
  const page = loadPage();
  const rows = readRef('table2b-rows');
  const crosswalk = readRef('measure-crosswalk');
  const measures = readRef('measure-list');
  page.setReference({
    byStem: measures.byStem,
    rows: rows.rows,
    byCode: crosswalk.byCode,
    componentSplits: crosswalk.componentSplits || {},
    supportedZones: new Set(measures.supportedZones || []),
    nameRules: crosswalk.byName.map(r => ({ re: new RegExp(r.match, 'i'), row: r.row, group: r.group })),
    zones: readRef('zip-climate-zone').zones
  });
  page.setOptions({ includeNonMeasure: false, completedOnly: true });

  const data = job();
  console.log('Synthetic job: ZIP ' + data.job.zip + ', HVAC ' + page.classifyHvac(data) +
    ', SnuggPro says 12% (Plus band)');
  console.log('');

  console.log('Setup');
  check('climate zone from ZIP', page.climateZoneFor(data).key, 'CZ10');
  check('HVAC classification', page.classifyHvac(data), 'rDXGF');
  check('declined recommendation dropped',
    page.flattenMeasures(data).some(r => r.measure === 'Declined Measure'), false);

  const out = page.buildTable2B([{ jobId: '900001', data }]);
  const cmp = out.comparison[0];
  const block = out.blocks[cmp.path];
  const row = label => block.rows.get(label);

  console.log('');
  console.log('Path');
  check('SnuggPro band', page.pathLabel(cmp.snuggPath), 'Pilot Plus');
  check('a zone-corrected percentage was computed', cmp.recalcPct != null, true);
  // The recalculated percentage corrects the savings; it does not move the job. The two
  // figures measure different things -- SnuggPro's is modeled plus deemed, the
  // calculator's is deemed alone -- so banding on the latter demoted real Plus jobs.
  check('block assignment stays with SnuggPro', page.pathLabel(cmp.path), 'Pilot Plus');
  check('path basis says so', cmp.basis, 'SnuggPro band, corrected savings');

  console.log('');
  console.log('Recommendation fold (600 kWh over two cost lines, split 2:1 by cost)');
  const d120 = row('Duct Sealing - 120 Minutes'), d90 = row('Duct Sealing - 90 Minutes');
  check('Duct Sealing - 120 Minutes exists', !!d120, true);
  check('Duct Sealing - 90 Minutes exists', !!d90, true);
  if (d120 && d90) {
    check('120 + 90 minute expenses', d120.cost + d90.cost, 900, 0.01);
    // Deep would report the modeled split; this job reports Plus, so the modeled figures
    // only surface where the catalog has nothing. Either way the two must not sum to 1200.
    check('modeled kWh not double counted', d120.kwh + d90.kwh <= 600.001, true);
  }

  console.log('');
  console.log('Two recommendations sharing a title stay separate (Deep path, modeled basis)');
  // A home really can carry two of the same measure. Folding on the title merged them
  // and halved the report; folding on the recommendation uuid keeps them apart, while
  // still collapsing the several cost lines of a single recommendation.
  const twins = job({
    rebatesIncentives: [{ code: 'deemedAndModeledKwhSavings',
      metadataJSON: JSON.stringify([{ key: 'combinedTotalEnergySavings', value: 26 }]) }],
    recommendations: [
      { status: '1', uuid: 'rec-a', title: 'Refrigerator', savedKwh: 500, savedTherms: 4, cost: 1563,
        detailedCosts: [{ name: 'ENERGY STAR Refrigerator - Large', code: 'SWAP001-05-Ref-20', quantity: 1, unit: 'each', costPerUnit: 1563 }] },
      { status: '1', uuid: 'rec-b', title: 'Refrigerator', savedKwh: 500, savedTherms: 4, cost: 1563,
        detailedCosts: [{ name: 'ENERGY STAR Refrigerator - Large', code: 'SWAP001-05-Ref-20', quantity: 1, unit: 'each', costPerUnit: 1563 }] }
    ],
    directInstalls: []
  });
  const twinOut = page.buildTable2B([{ jobId: '900006', data: twins }]);
  const twinBlock = twinOut.blocks[twinOut.comparison[0].path];
  const fridge = twinBlock.rows.get('Energy Star Qualified Refrigerators - Large 20+ cf');
  check('two units, not one', fridge ? fridge.qty : 0, 2, 0);
  check('both recommendations counted', fridge ? fridge.kwh : 0, 1000, 0.01);
  check('both costs counted', fridge ? fridge.cost : 0, 3126, 0.01);

  // The opposite case: one recommendation, two cost lines, savings counted once.
  const oneRec = job({
    rebatesIncentives: [{ code: 'deemedAndModeledKwhSavings',
      metadataJSON: JSON.stringify([{ key: 'combinedTotalEnergySavings', value: 26 }]) }],
    recommendations: [
      { status: '1', uuid: 'rec-c', title: 'Refrigerator', savedKwh: 500, savedTherms: 4, cost: 3126,
        detailedCosts: [
          { name: 'ENERGY STAR Refrigerator - Large', code: 'SWAP001-05-Ref-20', quantity: 1, unit: 'each', costPerUnit: 1563 },
          { name: 'ENERGY STAR Refrigerator - Large', code: 'SWAP001-05-Ref-20', quantity: 1, unit: 'each', costPerUnit: 1563 }
        ] }
    ],
    directInstalls: []
  });
  const oneOut = page.buildTable2B([{ jobId: '900007', data: oneRec }]);
  const oneBlock = oneOut.blocks[oneOut.comparison[0].path];
  const fridge1 = oneBlock.rows.get('Energy Star Qualified Refrigerators - Large 20+ cf');
  check('one recommendation over two lines: savings counted once', fridge1 ? fridge1.kwh : 0, 500, 0.01);
  check('but both costs still counted', fridge1 ? fridge1.cost : 0, 3126, 0.01);

  console.log('');
  console.log('Split system COOL + HEAT merged into one row');
  const sys = row('Replace Split System with 16+ SEER/95%+ AFUE - 3 1/2 Ton');
  check('system row exists', !!sys, true);
  if (sys) {
    check('quantity is one system, not two halves', sys.qty, 1, 0);
    check('expenses are both halves', sys.cost, 9350, 0.01);
  }

  console.log('');
  console.log('Direct install, deemed savings per unit');
  const aer = row('Faucet Aerator');
  check('Faucet Aerator row exists', !!aer, true);
  if (aer) {
    check('quantity', aer.qty, 2, 0);
    check('expenses', aer.cost, 10, 0.01);
    // Catalog CZ10 for SWWH001-L-G is 3.44 kWh / 2.77 therms per unit.
    check('kWh is per-unit x quantity', aer.kwh, 6.88, 0.001);
    check('therms is per-unit x quantity', aer.therms, 5.54, 0.001);
  }

  console.log('');
  console.log('Costs with no Table 2B row');
  check('Permits row exists', !!row('Permits'), true);
  check('Permits expenses', row('Permits') ? row('Permits').cost : 0, 225, 0.01);
  const audit = out.nonMeasure.find(u => /Testing/.test(u.group || ''));
  check('Energy Audit held out of the measure rows', !!audit, true);
  check('Energy Audit cost tracked separately', audit ? audit.cost : 0, 337, 0.01);
  check('nothing left unmapped', out.unmapped.length, 0, 0);

  console.log('');
  console.log('Declined measure never reaches the report');
  check('Whole House Fan row absent', !!row('Whole House Fan'), false);
  check('block expenses exclude the declined $50,000', block.cost < 20000, true);

  console.log('');
  console.log('Unsupported climate zone refuses rather than guessing');
  const outside = page.buildTable2B([{ jobId: '900002', data: job({ job: { id: 900002, zip: '93901', stageId: 6 } }) }]);
  const zoneEx = outside.exceptions.find(e => e.kind === 'Climate zone');
  check('flagged as an exception', !!zoneEx, true);
  if (zoneEx) console.log('        ' + zoneEx.detail);
  // It must still be reported. Dropping it into a third bucket would take its costs
  // off the page entirely, which is worse than reporting SnuggPro's own figure.
  const oc = outside.comparison[0];
  check('still reported in SnuggPro\'s own block', oc.path, 'plus');
  check('marked as not corrected', !!outside.exceptions.find(e => e.kind === 'Reported uncorrected'), true);
  check('its costs are still in a block total', outside.blocks.plus.cost > 0, true);
  // With no zone to correct against, the direct install must still report SnuggPro's
  // own deemed figure. A zero here would silently understate the measure.
  const oa = outside.blocks.plus.rows.get('Faucet Aerator');
  check('direct install falls back to SnuggPro deemed kWh', oa ? oa.kwh : 0, 6.88, 0.001);
  check('direct install falls back to SnuggPro deemed therms', oa ? oa.therms : 0, 5.54, 0.001);
  check('delta against SnuggPro is nil for an uncorrected job', Math.abs(oc.deltaKwh) < 0.001, true);

  console.log('');
  console.log('Non-measure costs, toggled on');
  page.setOptions({ includeNonMeasure: true, completedOnly: true });
  const withNon = page.buildTable2B([{ jobId: '900001', data: job() }]);
  const nb = withNon.blocks[withNon.comparison[0].path];
  const outreach = nb.rows.get('ESA WH Outreach & Assessment');
  check('rolled into ESA WH Outreach & Assessment', !!outreach, true);
  check('carries the audit cost', outreach ? outreach.cost : 0, 337, 0.01);
  check('block total grows by the same amount', nb.cost - block.cost, 337, 0.01);

  console.log('');
  console.log(failures ? failures + ' check(s) failed.' : 'All checks passed.');
  process.exit(failures ? 1 : 0);
}

main();
