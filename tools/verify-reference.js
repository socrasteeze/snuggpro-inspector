#!/usr/bin/env node
// Checks the generated reference data against a real SnuggPro export.
//
//   node tools/verify-reference.js [exportFile]
//
// exportFile defaults to the newest export_*.xlsx in ../report-tool. The repo has no
// test runner and this does not add one -- run it by hand after regenerating the
// reference JSON, or after changing codeStem / the crosswalk, and read the gates.
//
// Gates:
//   1  join coverage      -- coded line items and dollars that reach the measure list
//   2  Table 2B mapping   -- line items that reach a 2B row
//   3  recommendation fold-- how much double counting the fold removes
//   4  HEAT/COOL pairing  -- split systems that pair up, and whether halves are equal

const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('./xlsx-read.js');

const REF = path.join(__dirname, '..', 'public', 'reference');
const measureList = JSON.parse(fs.readFileSync(path.join(REF, 'measure-list.json'), 'utf8'));
const crosswalk = JSON.parse(fs.readFileSync(path.join(REF, 'measure-crosswalk.json'), 'utf8'));
const feeSchedule = JSON.parse(fs.readFileSync(path.join(REF, 'fee-schedule.json'), 'utf8'));
const zipZones = JSON.parse(fs.readFileSync(path.join(REF, 'zip-climate-zone.json'), 'utf8'));

const s = v => (v == null ? '' : String(v).trim());
// Separator for composite Map keys. Explicit so a job id or measure name that
// happens to contain a space cannot split one key into two.
const KEY_SEP = '::';
const n = v => (typeof v === 'number' ? v : 0);
// SnuggPro line-item names arrive HTML-escaped in the export sheet.
const unesc = v => s(v).replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

function codeStem(code) {
  const up = s(code).toUpperCase().replace(/\s+/g, '');
  return up.replace(/-CZ\d\d$/, '').replace(/^([A-Z0-9]+?)-\d\d-/, '$1-');
}

const nameRules = crosswalk.byName.map(r => ({ re: new RegExp(r.match, 'i'), row: r.row, group: r.group }));

// Mirrors what the browser does: code first, then the curated code map, then the
// free-text name rules. Returns { row, group, via } -- row null means "no 2B row".
function resolveLineItem(code, name) {
  const raw = s(code);
  const mapped = crosswalk.byCode[raw];
  if (mapped) {
    if (mapped.row) return { row: mapped.row, via: 'code-map' };
    const target = mapped.stem || mapped.pairsWith;
    const entry = target && measureList.byStem[codeStem(target)];
    if (entry && entry.row2b) return { row: entry.row2b, via: 'code-map/' + (mapped.stem ? 'stem' : 'pair') };
  }
  const entry = measureList.byStem[codeStem(raw)];
  if (entry && entry.row2b) return { row: entry.row2b, via: 'measure-list' };
  if (entry && (entry.defer || entry.group)) return { row: null, group: entry.group, defer: entry.defer, via: 'measure-list' };

  for (const rule of nameRules) {
    if (rule.re.test(unesc(name))) return { row: rule.row, group: rule.group, via: 'name-rule' };
  }
  return { row: null, via: 'unmapped' };
}

// Split systems arrive as two line items -- one carrying the cooling savings, one the
// heating savings, each carrying half the system cost. The heat half sometimes uses a
// different code family (C0-PKG-AC-FAU-* against SWHC049-PKG-AC-FAU-*), so pair on the
// system type and tonnage rather than on the code stem.
function systemHalf(code, name) {
  const src = s(code) || unesc(name);
  const half = /\(?\b(COOL|HEAT)\b\)?/i.exec(src);
  if (!half) return null;
  const tons = /(\d+(?:\.\d+)?)\s*(?:T\b|Tons?\b)/i.exec(src);
  if (!tons) return null;
  const up = src.toUpperCase();
  const family =
    up.includes('PKG-AC-FAU') || up.includes('PACKAGED AC') ? 'PKG-AC-FAU'
    : up.includes('SAC-FAU') || up.includes('SPLIT AC AND GAS FAU') ? 'SAC-FAU'
    : up.includes('SHP') || up.includes('SPLIT HEAT PUMP') ? 'SHP'
    : up.includes('PHP') || up.includes('PACKAGED HEAT PUMP') ? 'PHP'
    : 'OTHER';
  return { family, tons: tons[1], half: half[1].toUpperCase() };
}

// --- read the export ---------------------------------------------------------

function newestExport() {
  const dir = path.join(__dirname, '..', '..', 'report-tool');
  const hit = fs.readdirSync(dir).filter(f => /^export_.*\.xlsx$/i.test(f)).sort().pop();
  if (!hit) throw new Error('no export_*.xlsx in ' + dir);
  return path.join(dir, hit);
}

// Two layouts exist in the wild. The current exportXlsx() writes columns that match
// sheet2's header row; exports written before that fix put Src in column C. Detect by
// where the Src token lands rather than trusting the header.
const LAYOUTS = {
  current: { measure: 1, code: 2, qty: 3, unit: 4, cost: 9, name: 10, src: 11, cpu: 12, savedKwh: 13, savedTh: 14, deemedKwh: 16, deemedTh: 17 },
  legacy:  { measure: 1, src: 2, name: 3, code: 4, qty: 5, unit: 6, cpu: 7, cost: 8, savedKwh: 9, savedTh: 10, deemedKwh: 12, deemedTh: 13 }
};

function readExport(file) {
  const rows = readWorkbook(file).sheet('MeasureSavings').slice(1).filter(r => r[0] != null);
  const isSrc = v => /^(rec|DI)$/.test(s(v));
  const sample = rows.find(r => isSrc(r[2]) || isSrc(r[11]));
  if (!sample) throw new Error('cannot tell which column holds Src -- unrecognised export layout');
  const L = isSrc(sample[2]) ? LAYOUTS.legacy : LAYOUTS.current;
  return {
    layout: isSrc(sample[2]) ? 'legacy' : 'current',
    items: rows.map(r => ({
      jobId: s(r[0]), measure: unesc(r[L.measure]), src: s(r[L.src]), name: unesc(r[L.name]),
      code: s(r[L.code]), qty: n(r[L.qty]), cost: n(r[L.cost]),
      savedKwh: n(r[L.savedKwh]), savedTh: n(r[L.savedTh]),
      deemedKwh: n(r[L.deemedKwh]), deemedTh: n(r[L.deemedTh])
    }))
  };
}

// --- gates -------------------------------------------------------------------

let failures = 0;
function gate(ok, label, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  -- ' + detail : ''));
}
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const money = v => '$' + Math.round(v).toLocaleString('en-US');

function main() {
  const file = process.argv[2] || newestExport();
  const { layout, items } = readExport(file);
  console.log('Export : ' + path.basename(file) + '  (' + layout + ' column layout, ' + items.length + ' line items)');
  console.log('');

  // --- gate 1: measure-list join on coded line items ---
  const coded = items.filter(i => i.code);
  const joined = coded.filter(i => measureList.byStem[codeStem(i.code)] || crosswalk.byCode[i.code]);
  const codedCost = coded.reduce((a, i) => a + i.cost, 0);
  const joinedCost = joined.reduce((a, i) => a + i.cost, 0);
  const itemPct = pct(joined.length, coded.length);
  const costPct = pct(joinedCost, codedCost);
  console.log('Gate 1  measure-list join');
  gate(itemPct >= 91, 'coded line items resolve', itemPct.toFixed(1) + '% (' + joined.length + '/' + coded.length + '), floor 91%');
  gate(costPct >= 96, 'coded dollars resolve', costPct.toFixed(1) + '% (' + money(joinedCost) + '/' + money(codedCost) + '), floor 96%');
  const stillMissing = [...new Set(coded.filter(i => !joined.includes(i)).map(i => i.code))];
  if (stillMissing.length) console.log('        codes with no entry: ' + stillMissing.join(', '));

  // --- gate 2: every line item reaches a 2B row, a named group, or Unmapped ---
  console.log('');
  console.log('Gate 2  Table 2B mapping');
  const buckets = { row: [], group: [], unmapped: [] };
  const viaCount = {};
  for (const i of items) {
    const r = resolveLineItem(i.code, i.name || i.measure);
    viaCount[r.via] = (viaCount[r.via] || 0) + 1;
    if (r.row) buckets.row.push(i);
    else if (r.group || r.defer) buckets.group.push(i);
    else buckets.unmapped.push(i);
  }
  const totalCost = items.reduce((a, i) => a + i.cost, 0);
  const unmappedCost = buckets.unmapped.reduce((a, i) => a + i.cost, 0);
  gate(pct(buckets.unmapped.length, items.length) < 2,
    'line items with no destination', buckets.unmapped.length + '/' + items.length +
    ' (' + pct(buckets.unmapped.length, items.length).toFixed(1) + '%), ceiling 2%');
  gate(pct(unmappedCost, totalCost) < 1,
    'dollars with no destination', money(unmappedCost) + '/' + money(totalCost) +
    ' (' + pct(unmappedCost, totalCost).toFixed(2) + '%), ceiling 1%');
  console.log('        resolved via: ' + Object.entries(viaCount).map(([k, v]) => k + ' ' + v).join(', '));
  if (buckets.unmapped.length) {
    const top = {};
    buckets.unmapped.forEach(i => {
      const k = (i.code || i.name || i.measure);
      top[k] = (top[k] || { n: 0, cost: 0 });
      top[k].n++; top[k].cost += i.cost;
    });
    console.log('        largest unmapped:');
    Object.entries(top).sort((a, b) => b[1].cost - a[1].cost).slice(0, 8)
      .forEach(([k, v]) => console.log('          ' + money(v.cost).padStart(10) + '  x' + String(v.n).padEnd(4) + ' ' + k));
  }

  // --- gate 3: recommendation fold ---
  // flattenMeasures() copies a recommendation's savings onto every one of its cost
  // line items, so the raw row sum counts a multi-line recommendation several times.
  console.log('');
  console.log('Gate 3  recommendation fold');
  const groups = new Map();
  for (const i of items) {
    if (i.src !== 'rec') continue;
    const key = i.jobId + KEY_SEP + i.measure;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  let naive = 0, folded = 0;
  for (const rows of groups.values()) {
    naive += rows.reduce((a, r) => a + r.savedKwh, 0);
    // One value per recommendation. Distinct values inside a group mean SnuggPro
    // really did vary them per line, so keep the max rather than inventing a sum.
    folded += Math.max(...rows.map(r => r.savedKwh));
  }
  const removed = naive - folded;
  const kwh = v => v.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' kWh';
  gate(removed > 0, 'fold removes double-counted modeled kWh',
    kwh(removed) + ' of ' + kwh(naive) + ' (' + pct(removed, naive).toFixed(1) + '%)');
  const multi = [...groups.values()].filter(g => g.length > 1).length;
  console.log('        ' + groups.size + ' recommendations, ' + multi + ' with more than one cost line');

  // --- gate 4: HEAT/COOL pairing ---
  console.log('');
  console.log('Gate 4  split-system HEAT/COOL pairing');
  const pairs = new Map();
  for (const i of items) {
    const h = systemHalf(i.code, i.name);
    if (!h) continue;
    const key = [i.jobId, h.family, h.tons].join(KEY_SEP);
    if (!pairs.has(key)) pairs.set(key, {});
    pairs.get(key)[h.half] = i;
  }
  const complete = [...pairs.values()].filter(p => p.COOL && p.HEAT);
  const equalQty = complete.filter(p => p.COOL.qty === p.HEAT.qty).length;
  const equalCost = complete.filter(p => Math.abs(p.COOL.cost - p.HEAT.cost) < 1).length;
  // An orphan half is a data condition at the source, not a pairing failure. Two
  // different things produce one: a half nobody entered (understates the system), or
  // a whole system billed on one line (right total, wrong shape). Both belong in the
  // exception panel, so the gate only fails if pairing itself stops working.
  const orphanPct = pct(pairs.size - complete.length, pairs.size);
  gate(orphanPct <= 5,
    'halves pair up', complete.length + '/' + pairs.size + ' groups complete, ' +
    orphanPct.toFixed(1) + '% orphaned, ceiling 5%');
  gate(equalQty === complete.length,
    'paired halves carry the same quantity', equalQty + '/' + complete.length);
  console.log('        halves with equal cost: ' + equalCost + '/' + complete.length +
    ' (unequal halves are a real pricing split, not a pairing error)');

  const nteHits = complete.filter(p => {
    const combined = p.COOL.cost + p.HEAT.cost;
    return Object.values(feeSchedule.measures).some(m => m.nte && Math.abs(m.nte - combined) < 1);
  }).length;
  console.log('        combined cost equals a fee-schedule NTE exactly: ' + nteHits + '/' + complete.length);
  if (pairs.size !== complete.length) {
    console.log('        orphaned halves (each needs a look at the job):');
    [...pairs.entries()].filter(([, p]) => !(p.COOL && p.HEAT)).slice(0, 10).forEach(([k, p]) => {
      const parts = k.split(KEY_SEP);
      const side = Object.keys(p)[0];
      console.log('          job ' + parts[0] + '  ' + parts[1] + ' ' + parts[2] + 'T  ' +
        side + ' only, ' + money(p[side].cost));
    });
  }

  // --- gate 5: ZIP -> climate zone ---
  // The zone decides which deemed savings a home earns, and a wrong one is invisible
  // downstream, so every row of the source is re-read here and compared against the
  // generated map. Not a sample: all of them.
  console.log('');
  console.log('Gate 5  ZIP to climate zone');
  const csvPath = path.join(__dirname, '..', '..', 'report-tool', 'ZIPCode_ClimateZone.csv');
  const NEWLINE = String.fromCharCode(10), RETURN = String.fromCharCode(13);
  const csv = fs.readFileSync(csvPath, 'utf8').replace(new RegExp('^' + String.fromCharCode(0xFEFF)), '');
  const lines = csv.split(NEWLINE).map(l => l.split(RETURN).join('')).filter(l => l.trim());
  const head = lines[0].split(',').map(s);
  const zi = head.indexOf('ZIPCode'), ci = head.indexOf('Climate Zone');
  let checked = 0, wrong = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const zip = s(cells[zi]);
    const cz = Number(s(cells[ci]));
    if (!/^[0-9]{5}$/.test(zip)) continue;
    checked++;
    if (zipZones.zones[zip] !== cz) wrong.push(zip + ': source ' + cz + ', generated ' + zipZones.zones[zip]);
  }
  gate(wrong.length === 0, 'every source ZIP resolves to its source zone',
    checked + ' checked, ' + wrong.length + ' wrong');
  wrong.slice(0, 8).forEach(w => console.log('        ' + w));
  gate(Object.keys(zipZones.zones).length === checked,
    'no extra ZIPs in the generated map',
    Object.keys(zipZones.zones).length + ' generated vs ' + checked + ' in source');

  // The page turns a ZIP into a CZnn key and decides whether the measure list covers
  // it. Exercise that path, not just the raw table.
  const supported = measureList.supportedZones || [];
  gate(supported.length > 0, 'measure list publishes a zone set', 'zones ' + supported.join(', '));
  const zoneOf = zip => {
    const cz = zipZones.zones[zip];
    return cz == null ? null : { key: 'CZ' + String(cz).padStart(2, '0'), supported: supported.indexOf(cz) >= 0 };
  };
  const spot = [['92544', 'CZ10', true], ['92234', 'CZ15', true], ['92256', 'CZ14', true],
                ['90713', 'CZ08', true], ['92404', 'CZ16', true], ['93901', 'CZ03', false]];
  const badSpot = spot.filter(([zip, key, sup]) => {
    const z = zoneOf(zip);
    return !z || z.key !== key || z.supported !== sup;
  });
  gate(badSpot.length === 0, 'ZIP to CZnn key and coverage flag',
    spot.length + ' spot checks, ' + badSpot.length + ' wrong');
  badSpot.forEach(([zip]) => console.log('        ' + zip + ' -> ' + JSON.stringify(zoneOf(zip))));

  console.log('');
  console.log(failures ? failures + ' gate(s) failed.' : 'All gates passed.');
  process.exit(failures ? 1 : 0);
}

main();
