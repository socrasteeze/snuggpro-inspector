#!/usr/bin/env node
// Regenerates public/reference/*.json from the ESA source workbooks.
//
//   node tools/build-reference.js [sourceDir]
//
// sourceDir defaults to ../report-tool and must contain:
//   ESA_WHP_Consolidated_Measure_List_*.xlsx   deemed savings by climate zone
//   ESA-Whole-Home-Monthly-*.xlsx              the Table 2B skeleton (row order + units)
//   Fee-Schedule_*.xlsx                        NTE per measure, for the cost variance check
//   ZIPCode_ClimateZone.csv                    ZIP -> CA climate zone
//
// Run this whenever one of those files is revised, then commit the regenerated JSON.
// The browser only ever reads the JSON; it never parses a workbook.

const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('./xlsx-read.js');

const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'report-tool');
const OUT = path.join(__dirname, '..', 'public', 'reference');

// --- text helpers ------------------------------------------------------------

const s = v => (v == null ? '' : String(v).trim());

// Written as codepoints, not literals: an invisible U+FFFD or U+FEFF in this source
// is the kind of character an editor silently rewrites. The monthly workbook carries
// stray replacement characters in label text, and the ZIP CSV starts with a BOM.
const MOJIBAKE = new RegExp(String.fromCharCode(0xFFFD), 'g');
const BOM = new RegExp('^' + String.fromCharCode(0xFEFF));

// Measure names are compared across four documents that disagree on punctuation,
// case, and how they write half-tons. Fold the fraction BEFORE stripping symbols --
// otherwise "2 1/2 Ton" becomes "2 1 2 ton" and never meets "2.5 Ton".
function normName(t) {
  return s(t)
    .replace(MOJIBAKE, '')
    .replace(/&amp;/g, '&')
    .replace(/(\d)\s*1\/2/g, '$1.5')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// SnuggPro and the measure list write the same measure with different code shapes.
// Three steps, in order:
//   1. drop the trailing climate-zone suffix -- SnuggPro hard-codes -CZ10 on codes
//      whose savings it then reads from the CZ10 row, whatever the home's zone is;
//   2. drop the workpaper version segment (SWWH003-02-T-G vs SWWH003-T-G);
//   3. strip internal whitespace -- the source list contains "SWBE006-02- R-49".
// Together these lift the join from 82.5% to 91.1% of line items / 96.2% of dollars.
function codeStem(code) {
  const up = s(code).toUpperCase().replace(/\s+/g, '');
  return up.replace(/-CZ\d\d$/, '').replace(/^([A-Z0-9]+?)-\d\d-/, '$1-');
}

// --- curated crosswalk -------------------------------------------------------
// Everything below is a judgement call that the source data cannot make for us.
// estimated:true marks a mapping that is a reasonable reading rather than a documented
// one; the UI lists those separately so they get confirmed against a real report.

// Keyed by normalized MAROMA Variant or Report Measure Name. row:null keeps the line
// item's cost out of the measure table (it lands in the reconciliation panel).
// defer:true means the measure carries savings but no row of its own -- its cost lives
// on sibling line items in the same recommendation, so its savings follow them.
const ROW_OVERRIDES = {
  // Duct sealing and air sealing are container measures: the savings sit on the
  // recommendation, the cost sits on DS000x / AS000x siblings that name the 2B row.
  'cost will be the sum of cost from duct sealing cost only measures': { row: null, defer: true },
  'duct seal to 10 leakage':     { row: null, defer: true },
  'duct seal to 10 leakage.':    { row: null, defer: true },

  // AIRSEAL is not a container: it arrives as its own line item with a linear-foot
  // quantity, its own cost and its own modeled savings, and never has a sibling that
  // names a 2B row. Treating it as deferred stranded 108 line items and $21.5k across
  // the July job set. Confirmed against the filed report: this mapping produces 6,226
  // feet at $36,917 where the filed Weather-stripping row is 6,494 at $38,035.
  'air sealing':                 { row: 'Weather-stripping' },

  // The 2B sheet spells these with a typo ("Energy Start") the measure list does not.
  'replace room ac with energy star qualified rac 10k btu':   { row: 'Replace Room AC with Energy Start Qualified RAC - 10k BTU' },
  'replace room ac with energy star qualified rac 12k btu':   { row: 'Replace Room AC with Energy Start Qualified RAC - 12k BTU' },
  'replace room ac with energy star qualified rac 15k btu':   { row: 'Replace Room AC with Energy Start Qualified RAC - 15k BTU' },
  'replace room ac with energy star qualified rac 6 8k btu':  { row: 'Replace Room AC with Energy Start Qualified RAC - 6-8k BTU' },

  'tier 2 smart power strip': { row: 'Tier 2 Smart Power Strips' },
  'window film':              { row: 'Window Film (Tint)' },

  // 2B carries only 40w- and 60w-equivalent lamp rows. A-lamps are the general-service
  // 60w replacement; PAR (reflector) lamps are the lower-output row. Confirm against a
  // filed report before trusting the split.
  'led a lamps':   { row: 'LED Lamps - 60w Equivalent', estimated: true },
  'led par lamps': { row: 'LED Lamps - 40w Equivalent', estimated: true },

  // Mitigation / health-and-safety work. Real dollars, no 2B measure row.
  'build new platform':                            { row: null, group: 'Mitigation' },
  'install additional attic vents gable mushroom': { row: null, group: 'Mitigation' },
  'install additional attic vents vent dormer':    { row: null, group: 'Mitigation' },
  'install additional attic vents vent eave':      { row: null, group: 'Mitigation' },
  'install additional attic vents vent screen':    { row: null, group: 'Mitigation' },
  'install pressure regulator':                    { row: null, group: 'Mitigation' },
  'licensed electrician grounds outlet':           { row: null, group: 'Mitigation' },
  'repair replace faucet.':                        { row: null, group: 'Mitigation' },
  'repair replace shower fixtures.':               { row: null, group: 'Mitigation' },
  'repair replace window frame':                   { row: null, group: 'Mitigation' },
  'repair mounting wall frame':                    { row: null, group: 'Mitigation' },
  'roof repair':                                   { row: null, group: 'Mitigation' },
  'upgrade the panel or wiring.':                  { row: null, group: 'Mitigation' },
  'upgrade electric panel or wiring':              { row: null, group: 'Mitigation' }
};

// SnuggPro codes with no measure-list entry at all. stem borrows another entry's
// deemed savings; row names the 2B row directly for cost-only items; pairsWith marks
// the half of a two-line system whose savings live on the other half.
const CODE_MAP = {
  // Duct sealing cost tiers -- cost only; the paired recommendation carries the savings.
  DS0001: { row: 'Duct Sealing - 60 Minutes' },
  DS0002: { row: 'Duct Sealing - 90 Minutes' },
  DS0003: { row: 'Duct Sealing - 120 Minutes' },

  // Air sealing cost tiers.
  AS0001: { row: 'Caulking' },
  AS0002: { row: 'Cover Plate Gaskets' },
  AS0006: { row: 'Weather-stripping' },
  DoorSealing: { row: 'Weather-stripping', estimated: true },
  WHP142: { row: 'Attic Cover Replacement' },

  // SnuggPro transposes the DHW insulation codes relative to the measure list.
  DHWPI01: { stem: 'DWHPI01' },
  DHWTI01: { stem: 'DWHTI01' },

  // Packaged and split heat-pump HEAT halves have no catalog row of their own; the
  // COOL half carries the deemed savings and both halves carry half the cost.
  'C0-PKG-AC-FAU-2T-HEAT':   { pairsWith: 'SWHC049-PKG-AC-FAU-15.2-S2-2T-COOL' },
  'C0-PKG-AC-FAU-2.5T-HEAT': { pairsWith: 'SWHC049-PKG-AC-FAU-15.2-S2-2.5T-COOL' },
  'C0-PKG-AC-FAU-3T-HEAT':   { pairsWith: 'SWHC049-PKG-AC-FAU-15.2-S2-3T-COOL' },
  'C0-PKG-AC-FAU-3.5T-HEAT': { pairsWith: 'SWHC049-PKG-AC-FAU-15.2-S2-3.5T-COOL' },
  'C0-PKG-AC-FAU-4T-HEAT':   { pairsWith: 'SWHC049-PKG-AC-FAU-15.2-S2-4T-COOL' },
  'SWHC049-03-SHP-15.2-S2-4T-HEAT': { pairsWith: 'SWHC049-SHP-15.2-S2-4T-COOL' },

  // Appliance size buckets SnuggPro splits more finely than the measure list does.
  'SWAP001-05-Ref-15-17':  { stem: 'SWAP001-REF-15-19', estimated: true },
  'SWAP001-05-Ref-17-20':  { stem: 'SWAP001-REF-15-19', estimated: true },
  'SWAP001-05-CF-16-19':   { stem: 'SWAP001-CF-16', estimated: true },
  'SWAP001-05-CF-19':      { stem: 'SWAP001-CF-16', estimated: true },
  'SWAP001-05-UF-19':      { stem: 'SWAP001-UF-16', estimated: true },
  'SWAP001-05-UF-10-13':   { stem: 'SWAP001-UF-13', estimated: true }
};

// One SnuggPro line item that Table 2B reports on two rows. Keyed by code stem.
// The component named here is a measure the list also publishes on its own, so the
// split comes from the catalog instead of being apportioned by hand: the component row
// takes its own published value and the main row takes the remainder.
const COMPONENT_SPLITS = {
  // "Thermostatic Shower Valve and 1.25 GPM Showerhead" is one deemed product, but the
  // report has a row for each half -- which is why the filed Deep block shows 403
  // valves against 407 showerheads. SWWH002 is the standalone showerhead: 12.3 of the
  // combined 14 kWh at CZ10, and 87.9% in every zone, leaving 1.70 kWh for the valve.
  'SWWH003-T-G': { componentStem: 'SWWH002-H-G', componentRow: 'Low-Flow Showerhead - Handheld' },
  'SWWH003-T-E': { componentStem: 'SWWH002-H-E', componentRow: 'Low-Flow Showerhead - Handheld' },
  'SWWH003-F-G': { componentStem: 'SWWH002-F-G', componentRow: 'Low-Flow Showerhead - Regular' },
  'SWWH003-F-E': { componentStem: 'SWWH002-F-E', componentRow: 'Low-Flow Showerhead - Regular' }
};

// Line items that carry no code at all -- 139 free-text spellings of about fifteen real
// things across 336 jobs, so these are ordered patterns rather than literals. First
// match wins, so the specific ones come first: "Duct Test - with Energy Audit" must not
// be read as an Energy Audit.
const NAME_RULES = [
  // --- reported measures ---
  ['duct\\s*test|duct\\s*testing',                              'Duct Test - Title 24 or to perform duct sealing'],
  ['(building\\s*(department\\s*)?)?permit',                    'Permits'],
  ['out?r?e?ach.*(enroll|educat)|enrollment.*educat',           'ESA WH Outreach & Assessment'],
  ['comprehensive home health',                                 'Comprehensive Home Health and Safety Check-up'],
  ['furnace clean',                                             'Furnace Clean and Tune'],
  ['co\\s*[/&-]\\s*smoke alarm|smoke\\s*[/&]\\s*co',            'CO/Smoke Alarm Combo'],
  ['smoke alarm',                                               'Smoke Alarm'],
  ['duct\\s*seal.*120|120\\s*min',                              'Duct Sealing - 120 Minutes'],
  ['duct\\s*seal.*90|90\\s*min',                                'Duct Sealing - 90 Minutes'],
  ['duct\\s*seal.*60|60\\s*min',                                'Duct Sealing - 60 Minutes'],
  ['weather.?strip|door\\s*(sweep|shoe)|door\\s*sealing',       'Weather-stripping'],
  ['caulk',                                                     'Caulking'],
  ['(cover.?plate|switch\\s*[/&-]?\\s*outlet).*(gasket|cover)|gasket.*cover|utility gasket', 'Cover Plate Gaskets'],
  ['attic\\s*(access\\s*)?cover|attic access new',              'Attic Cover Replacement'],
  ['kitchen exhaust damper',                                    'Kitchen Exhaust Dampers'],
  ['room ac.*cover|evaporative cooler cover',                   'Room AC/Evaporative Cooler Cover'],
  ['smart\\s*thermostat|ecobee|nest thermostat',                'Smart Thermostat'],
  ['home energy monitor|copper home|energy monitor',            'Home Energy Monitor'],
  ['security light',                                            'Exterior LED Security Light (photocell and motion sensor)'],
  ['water heater pipe insulation',                              'Water Heater Pipe Insulation'],
  ['water heater (tank insulation|blanket)',                    'Water Heater Blanket'],
  ['water heater.*repair.*leak',                                'Water Heater - Repair water leak - NTE $300'],
  ['dishwasher',                                                'Energy Star Qualified Dishwashers'],
  ['hvac tune',                                                 'HVAC Tune-up'],
  ['duct repair',                                               'Duct Repair'],
  ['minor home.*repair|envelop(e)?\\s*repair',                  'Minor Home / Envelop Repairs - NTE $600'],

  // --- real spend with no 2B measure row ---
  ['blower\\s*door',                            null, 'Testing & Audit'],
  ['energy audit',                              null, 'Testing & Audit'],
  ['natural gas appliance|^ngat$',              null, 'Testing & Audit'],
  ['promotional marketing',                     null, 'Outreach & Marketing'],
  ['mitigation|furnace part|remove contaminated|relocate condensing|add circuit|dryer vent|door gasket|install .*oven|build new platform|pressure regulator|roof repair|repair.?replace (faucet|shower|window)|panel or wiring|grounds outlet',
                                                null, 'Mitigation']
];

// --- readers -----------------------------------------------------------------

function findSource(pattern) {
  const hit = fs.readdirSync(SRC).filter(f => pattern.test(f)).sort().pop();
  if (!hit) throw new Error('no file matching ' + pattern + ' in ' + SRC);
  return path.join(SRC, hit);
}

function sheetObjects(rows) {
  const header = (rows[0] || []).map(s);
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { if (h) o[h] = r[i]; });
    return o;
  });
}

// --- 1. Table 2B skeleton ----------------------------------------------------

const CATEGORIES = new Set([
  'appliances', 'cooling measures', 'domestic hot water', 'enclosure', 'hvac',
  'maintenance', 'lighting', 'miscellaneous', 'permitting fees', 'customer enrollment'
]);

function buildTable2bRows() {
  const file = findSource(/^ESA-Whole-Home-Monthly.*\.xlsx$/i);
  const grid = readWorkbook(file).sheet('ESA Table 2B-PP PD');
  const out = [];
  let category = null;
  // Rows 8..144 hold the measure block; the totals and cost tables sit below it.
  for (let i = 7; i < 144; i++) {
    const label = s((grid[i] || [])[0]);
    if (!label) continue;
    if (CATEGORIES.has(normName(label))) { category = label; continue; }
    out.push({ label, category, unit: s((grid[i] || [])[1]), sheetRow: i + 1 });
  }
  return { source: path.basename(file), rows: out };
}

// --- 2. ZIP -> climate zone --------------------------------------------------

// Quoted-field aware, so a city or county containing a comma cannot shift the columns
// and silently hand back another zone's savings. Newline and carriage return are built
// from codepoints to keep this source free of escape sequences.
function parseCsv(text) {
  const NEWLINE = String.fromCharCode(10), RETURN = String.fromCharCode(13);
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === NEWLINE) { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== RETURN) cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// The zone a home sits in decides which deemed savings it earns, so every row is
// validated rather than trusted. A malformed ZIP or an out-of-range zone fails the
// build: a wrong zone here is invisible downstream and silently misreports a job.
function buildZipClimateZones() {
  const file = path.join(SRC, 'ZIPCode_ClimateZone.csv');
  const grid = parseCsv(fs.readFileSync(file, 'utf8').replace(BOM, ''));
  const header = (grid[0] || []).map(s);
  const zi = header.indexOf('ZIPCode');
  const ci = header.indexOf('Climate Zone');
  if (zi < 0 || ci < 0) throw new Error('ZIPCode_ClimateZone.csv is missing ZIPCode / Climate Zone');

  const zones = {};
  const problems = [];
  grid.slice(1).forEach((cells, i) => {
    if (!cells.length || !s(cells[zi])) return;
    const line = i + 2;
    const zip = s(cells[zi]);
    const cz = Number(s(cells[ci]));
    if (!/^[0-9]{5}$/.test(zip)) { problems.push('line ' + line + ': ZIP ' + JSON.stringify(zip) + ' is not five digits'); return; }
    if (!Number.isInteger(cz) || cz < 1 || cz > 16) { problems.push('line ' + line + ': ZIP ' + zip + ' has climate zone ' + JSON.stringify(s(cells[ci]))); return; }
    // Two rows disagreeing about one ZIP would make the answer depend on row order.
    if (zones[zip] !== undefined && zones[zip] !== cz) {
      problems.push('line ' + line + ': ZIP ' + zip + ' is zone ' + cz + ' here and ' + zones[zip] + ' earlier');
      return;
    }
    zones[zip] = cz;
  });
  if (problems.length) {
    throw new Error('ZIPCode_ClimateZone.csv has ' + problems.length + ' bad row(s):' + String.fromCharCode(10) + problems.slice(0, 20).join(String.fromCharCode(10)));
  }
  return { source: path.basename(file), zones };
}

// --- 3. Fee schedule ---------------------------------------------------------

function buildFeeSchedule() {
  const file = findSource(/^Fee-Schedule.*\.xlsx$/i);
  const rows = sheetObjects(readWorkbook(file).sheet('Sheet1'));
  const measures = {};
  for (const r of rows) {
    const measure = s(r['Measure']);
    if (!measure) continue;
    // Several NTEs are prose ("Cost + 10% plus labor"); keep only the numeric ones.
    const nte = typeof r['2025 Msr NTE'] === 'number' ? r['2025 Msr NTE'] : null;
    measures[normName(measure)] = {
      msrId: s(r['MSR ID']),
      measure,
      unit: s(r['Unit']),
      nte,
      eligible: /^eligible$/i.test(s(r['Bulk Purch.']))
    };
  }
  return { source: path.basename(file), measures };
}

// --- 4. Measure list ---------------------------------------------------------

function num(v) { return typeof v === 'number' ? v : null; }

// MAROMA Variant is the closest thing the list has to a 2B row name, but it is not
// authoritative: it is blank on container measures, prefixed "Half of" on the two
// halves of a split system, and occasionally spelled differently from the sheet.
// Order: explicit override -> MAROMA -> "Half of" MAROMA -> Report Measure Name.
function resolveRow(maroma, rmn, t2bIndex, report) {
  for (const key of [normName(maroma), normName(rmn)]) {
    if (key && Object.prototype.hasOwnProperty.call(ROW_OVERRIDES, key)) {
      const o = ROW_OVERRIDES[key];
      if (o.row && !t2bIndex.has(normName(o.row))) {
        throw new Error('ROW_OVERRIDES points at a row Table 2B does not have: ' + o.row);
      }
      return { row: o.row, defer: o.defer, estimated: o.estimated, group: o.group, half: false };
    }
  }
  const direct = t2bIndex.get(normName(maroma));
  if (direct) return { row: direct.label, half: false };

  const halfOf = /^half of\s+/i.test(maroma) ? maroma.replace(/^half of\s+/i, '') : null;
  if (halfOf) {
    const hit = t2bIndex.get(normName(halfOf));
    if (hit) return { row: hit.label, half: true };
  }
  const viaRmn = t2bIndex.get(normName(rmn));
  if (viaRmn) return { row: viaRmn.label, half: false };

  if (maroma || rmn) report.unresolvedMeasures.add(maroma || rmn);
  return { row: null, half: false };
}

function buildMeasureList(t2bIndex, report) {
  const file = findSource(/^ESA_WHP_Consolidated_Measure_List.*\.xlsx$/i);
  const rows = sheetObjects(readWorkbook(file).sheet('Sheet1'));
  const byStem = {};

  for (const r of rows) {
    const spc = s(r['Snugg Pro Code']);
    // The sheet repeats its own header partway down; skip that row, not real data.
    if (!spc || s(r['Status']) === 'Status') continue;

    const stem = codeStem(spc);
    const resolved = resolveRow(s(r['MAROMA Variant']), s(r['Report Measure Name']), t2bIndex, report);

    if (!byStem[stem]) {
      byStem[stem] = {
        row2b: resolved.row,
        category: s(r['Report Measure Category']),
        half: resolved.half,
        defer: resolved.defer || undefined,
        estimated: resolved.estimated || undefined,
        group: resolved.group || undefined,
        variants: []
      };
    }
    byStem[stem].variants.push({
      cz: s(r['CZ']),
      hvac: s(r['HVAC TYPE']),
      name: s(r['Snugg Pro Name']),
      rc: s(r['Reporting Code']),
      kwh: num(r['Deemed kWh Savings']),
      kw: num(r['Deemed kW Savings']),
      th: num(r['Deemed Therms Savings']),
      unit: s(r['Savings Unit'])
    });
  }
  return { source: path.basename(file), byStem };
}

// --- 5. Crosswalk ------------------------------------------------------------

function buildCrosswalk(t2bIndex, byStem) {
  for (const [code, entry] of Object.entries(CODE_MAP)) {
    if (entry.row && !t2bIndex.has(normName(entry.row))) {
      throw new Error('CODE_MAP[' + code + '] points at a row Table 2B does not have: ' + entry.row);
    }
  }
  // A split that names a missing component or row would silently report nothing, so
  // both ends are checked here rather than at run time in the browser.
  const splits = {};
  for (const [stem, split] of Object.entries(COMPONENT_SPLITS)) {
    if (!byStem[stem]) { console.log('  note: COMPONENT_SPLITS skips ' + stem + ' (not in the measure list)'); continue; }
    if (!byStem[split.componentStem]) {
      throw new Error('COMPONENT_SPLITS[' + stem + '] names a component the measure list does not have: ' + split.componentStem);
    }
    if (!t2bIndex.has(normName(split.componentRow))) {
      throw new Error('COMPONENT_SPLITS[' + stem + '] points at a row Table 2B does not have: ' + split.componentRow);
    }
    splits[stem] = split;
  }
  const byName = NAME_RULES.map(rule => {
    const match = rule[0], row = rule[1], group = rule[2];
    if (row && !t2bIndex.has(normName(row))) {
      throw new Error('NAME_RULES /' + match + '/ points at a row Table 2B does not have: ' + row);
    }
    return group ? { match, row, group } : { match, row };
  });
  return { byCode: CODE_MAP, componentSplits: splits, byName };
}

// --- write -------------------------------------------------------------------

// One line per top-level key so a regenerated file diffs by measure, not as one blob.
function stringifyByKey(obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return '{}';
  return '{\n' + keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(obj[k])).join(',\n') + '\n}';
}

function write(name, text) {
  fs.writeFileSync(path.join(OUT, name), text + '\n');
  const kb = (Buffer.byteLength(text) / 1024).toFixed(1);
  console.log('  ' + name.padEnd(26) + kb.padStart(7) + ' KB');
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { unresolvedMeasures: new Set() };

  const t2b = buildTable2bRows();
  const t2bIndex = new Map(t2b.rows.map(r => [normName(r.label), r]));
  if (t2bIndex.size !== t2b.rows.length) {
    throw new Error('Table 2B has two rows with the same normalized label -- the index would drop one');
  }

  const zips = buildZipClimateZones();
  const fees = buildFeeSchedule();
  const measures = buildMeasureList(t2bIndex, report);
  const crosswalk = buildCrosswalk(t2bIndex, measures.byStem);

  const stems = Object.keys(measures.byStem);
  const mapped = stems.filter(k => measures.byStem[k].row2b).length;
  const czs = new Set();
  stems.forEach(k => measures.byStem[k].variants.forEach(v => { if (v.cz) czs.add(v.cz); }));

  console.log('Sources: ' + SRC);
  write('table2b-rows.json', JSON.stringify(t2b, null, 2));
  write('zip-climate-zone.json', JSON.stringify(zips));
  write('fee-schedule.json', JSON.stringify(fees, null, 1));
  write('measure-crosswalk.json', JSON.stringify(crosswalk, null, 2));
  const supportedZones = [...czs].filter(z => /^CZ[0-9]{2}$/.test(z))
    .map(z => Number(z.slice(2))).sort((a, b) => a - b);
  write('measure-list.json',
    '{"source":' + JSON.stringify(measures.source) +
    ',"supportedZones":' + JSON.stringify(supportedZones) +
    ',"byStem":' + stringifyByKey(measures.byStem) + '}');


  console.log('');
  console.log('Table 2B rows      : ' + t2b.rows.length);
  console.log('ZIP codes          : ' + Object.keys(zips.zones).length);
  console.log('Fee schedule rows  : ' + Object.keys(fees.measures).length);
  console.log('Measure stems      : ' + stems.length + '  (' + mapped + ' land on a 2B row)');
  console.log('Climate zones      : ' + [...czs].sort().join(', '));
  if (report.unresolvedMeasures.size) {
    console.log('');
    console.log('Measures with no 2B row (' + report.unresolvedMeasures.size + ') -- these reach the');
    console.log('Unmapped panel unless a line-item name rule catches them:');
    [...report.unresolvedMeasures].sort().forEach(m => console.log('  - ' + m));
  }
}

main();
