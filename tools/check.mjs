// Offline checks for public synthetic fixtures only. No model calls or private input loading.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const load = relative => JSON.parse(read(relative));
const ids = ['experience_specificity', 'logic_connection', 'expression_readability', 'question_fulfillment', 'job_relevance'];
const weights = [25, 20, 15, 25, 15];
const schema = load('schemas/evaluation.schema.json');
const inputs = load('examples/synthetic-inputs.json');
const records = load('examples/synthetic-evaluations.json');
const allowed = ['.gitignore', 'README.md', 'CHANGELOG.md', 'prompts/write.md', 'prompts/review.md', 'rubrics/scoring-v0.1.md', 'schemas/evaluation.schema.json', 'examples/README.md', 'examples/synthetic-inputs.json', 'examples/synthetic-evaluations.json', 'tools/check.mjs'];

let validateSchemaRecord = null;
if (process.argv.length > 2) {
  assert.equal(process.argv[2], '--ajv2020');
  assert.equal(process.argv.length, 4, 'Provide one local Ajv 2020 module path');
  const require = createRequire(import.meta.url);
  const imported = require(path.resolve(process.argv[3]));
  const Ajv2020 = imported.default ?? imported;
  // Date-time is checked below without an additional package.
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  assert(ajv.validateSchema(schema), 'Invalid JSON Schema');
  validateSchemaRecord = ajv.compile(schema);
}

function verify(record, input) {
  if (validateSchemaRecord) assert(validateSchemaRecord(record), JSON.stringify(validateSchemaRecord.errors));
  assert.equal(input.synthetic, true);
  assert.equal(record.record_kind, 'synthetic-contract');
  assert.equal(record.case_id, input.case_id);
  assert.equal(record.source_id, input.source_id);
  assert.equal(record.schema_version, '0.1');
  assert.equal(record.metadata.rubric_version, '0.1');
  assert.equal(record.metadata.prompt_id, 'review');
  assert.equal(record.metadata.prompt_version, '0.1.0');
  assert.equal(record.metadata.model, null);
  assert(record.metadata.model_unknown_reason?.length > 0);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(record.metadata.evaluated_at));
  assert(Number.isFinite(Date.parse(record.metadata.evaluated_at)));
  assert.equal(record.metadata.original_sha256, crypto.createHash('sha256').update(input.original, 'utf8').digest('hex'));
  assert.equal(record.sources.question_id, input.question?.id ?? null);
  assert.equal(record.sources.posting_id, input.posting?.id ?? null);
  assert.equal(record.sources.role_title, input.role_title);
  assert.deepEqual(record.sources.fact_ids, input.facts?.map(f => f.id) ?? null);
  assert.equal(record.sources.constraints_available, input.constraints !== null);
  const sourceIds = new Set([input.source_id, input.question?.id, input.posting?.id, ...(input.facts?.map(f => f.id) ?? [])].filter(Boolean));
  assert.deepEqual(Object.keys(record.criteria), ids);
  for (const [i, id] of ids.entries()) {
    const c = record.criteria[id];
    assert.equal(c.weight, weights[i]);
    if (c.score === null) {
      assert.equal(c.weighted_score, null);
      assert.equal(c.evidence_quote, null);
      assert(c.reason?.length > 0);
      assert.deepEqual(c.evidence_source_ids, []);
    } else {
      assert(Number.isInteger(c.score) && c.score >= 0 && c.score <= 5);
      assert.equal(c.weighted_score, c.score / 5 * c.weight);
      assert.equal(c.reason, null);
      assert(c.evidence_quote?.length > 0 && input.original.includes(c.evidence_quote));
      assert(c.evidence_source_ids.includes(input.source_id));
      for (const source of c.evidence_source_ids) assert(sourceIds.has(source));
    }
    assert(c.rationale?.length > 0);
    assert(c.minimum_improvement?.length > 0);
  }
  if (!input.question) assert.equal(record.criteria.question_fulfillment.score, null);
  if (!input.posting) assert.equal(record.criteria.job_relevance.score, null);
  if (!input.facts?.length) assert(['needs_confirmation', 'not_assessed'].includes(record.gates.facts.status));
  if (!input.constraints) assert.notEqual(record.gates.format_length.status, 'pass');
  for (const [name, gate] of Object.entries(record.gates)) {
    const statuses = name === 'facts' ? ['clear', 'contradiction', 'needs_confirmation', 'not_assessed'] : ['pass', 'violation', 'needs_confirmation', 'not_assessed'];
    assert(statuses.includes(gate.status));
    assert(gate.reason?.length > 0);
    if (['violation', 'contradiction', 'needs_confirmation'].includes(gate.status)) assert(gate.findings.length > 0);
    for (const finding of gate.findings) {
      if (finding.quote !== null) assert(input.original.includes(finding.quote));
      for (const source of finding.source_ids) assert(sourceIds.has(source));
    }
  }
  if (record.gates.format_length.status === 'pass') {
    // These fixtures deliberately use one fully specified counting policy.
    assert.equal(input.constraints.unit, 'code-point');
    assert.equal(input.constraints.spaces, 'include');
    assert.equal(input.constraints.title, 'exclude');
    assert.equal(input.constraints.line_breaks, 'include');
    assert.equal(input.constraints.crlf, 'two-characters');
    const count = Array.from(input.original).length;
    assert(count >= input.constraints.min && count <= input.constraints.max);
    assert(!input.original.includes(String.fromCodePoint(0x00b7)));
  }
  const subtotal = group => group.every(id => record.criteria[id].score !== null) ? group.reduce((sum, id) => sum + record.criteria[id].weighted_score, 0) : null;
  assert.equal(record.summary.quality_score, subtotal(ids.slice(0, 3)));
  assert.equal(record.summary.suitability_score, subtotal(ids.slice(3)));
  assert.equal(record.summary.total_score, subtotal(ids));
  assert.equal(record.summary.assessed_points, ids.reduce((sum, id) => sum + (record.criteria[id].weighted_score ?? 0), 0));
  assert.equal(record.summary.assessed_max, ids.reduce((sum, id) => sum + (record.criteria[id].score === null ? 0 : record.criteria[id].weight), 0));
  assert.deepEqual(record.summary.assessed_criteria, ids.filter(id => record.criteria[id].score !== null));
  assert.deepEqual(record.summary.unassessed_criteria, ids.filter(id => record.criteria[id].score === null));
}

assert.equal(records.length, 3);
assert.equal(inputs.length, records.length);
assert.equal(new Set(inputs.map(x => x.case_id)).size, inputs.length);
assert.equal(new Set(inputs.map(x => x.source_id)).size, inputs.length);
for (const input of inputs) verify(records.find(r => r.case_id === input.case_id), input);
assert.deepEqual(records.map(r => [r.summary.assessed_points, r.summary.assessed_max, r.summary.total_score]), [[80, 100, 80], [48, 60, null], [63, 85, null]]);

let rejectionCount = 0;
function rejects(index, change) {
  const invalid = structuredClone(records[index]);
  change(invalid);
  assert.throws(() => verify(invalid, inputs[index]));
  rejectionCount++;
}
rejects(0, r => { r.criteria.experience_specificity.score = 6; });
rejects(0, r => { r.criteria.logic_connection.weighted_score = 19; });
rejects(1, r => { r.criteria.question_fulfillment = structuredClone(records[0].criteria.question_fulfillment); });
rejects(1, r => { r.criteria.question_fulfillment.reason = null; });
rejects(1, r => { r.summary.total_score = 80; });
rejects(2, r => { r.summary.suitability_score = 20; });
rejects(2, r => { r.criteria.job_relevance = structuredClone(records[0].criteria.job_relevance); });
rejects(0, r => { r.metadata.model_unknown_reason = null; });
rejects(0, r => { r.metadata.original_sha256 = '0'.repeat(64); });
rejects(0, r => { r.source_id = 'another-source'; });
rejects(0, r => { r.criteria.logic_connection.evidence_quote = 'invented quotation'; });
rejects(0, r => { r.criteria.experience_specificity.evidence_source_ids = ['another-fact']; });
rejects(1, r => { r.gates.facts.status = 'clear'; });
rejects(1, r => { r.gates.format_length.status = 'pass'; });
rejects(0, r => { r.summary.assessed_max = 60; });

// Quality scores cannot erase a separate violation or fact contradiction.
for (const [name, status] of [['format_length', 'violation'], ['facts', 'contradiction']]) {
  const separateStatus = structuredClone(records[0]);
  separateStatus.gates[name] = {
    status, reason: 'Synthetic status-separation check only.',
    findings: [{ code: 'SYNTHETIC_STATE_CHECK', quote: null, source_ids: [], rationale: 'Contract check only; not a factual claim about the example.', minimum_action: 'Keep this state separate from quality scores.' }]
  };
  verify(separateStatus, inputs[0]);
  assert.equal(separateStatus.summary.total_score, records[0].summary.total_score);
}

// Exercise every 0..5 anchor and each weight, including a real zero, not null.
for (let score = 0; score <= 5; score++) {
  const anchorRecord = structuredClone(records[0]);
  for (const id of ids) {
    anchorRecord.criteria[id].score = score;
    anchorRecord.criteria[id].weighted_score = score / 5 * anchorRecord.criteria[id].weight;
  }
  anchorRecord.summary.quality_score = score / 5 * 60;
  anchorRecord.summary.suitability_score = score / 5 * 40;
  anchorRecord.summary.total_score = score / 5 * 100;
  anchorRecord.summary.assessed_points = anchorRecord.summary.total_score;
  verify(anchorRecord, inputs[0]);
}

// No dependencies, personal files, credentials, hidden data or extra deliverables.
function inventory(dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '.git') return [];
    const full = path.join(dir, entry.name);
    assert(!entry.isSymbolicLink());
    return entry.isDirectory() ? inventory(full) : [path.relative(root, full).replaceAll('\\', '/')];
  });
}
assert.deepEqual(inventory().sort(), [...allowed].sort());
let links = 0;
for (const relative of allowed) {
  const content = read(relative);
  assert(!content.includes(String.fromCodePoint(0x00b7)), `${relative}: forbidden middle dot`);
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]+|\bAKIA[A-Z0-9]{16}\b/.test(content), `${relative}: credential pattern`);
  assert(!/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b01[016789][ -]?\d{3,4}[ -]?\d{4}\b/.test(content), `${relative}: contact pattern`);
  if (relative.endsWith('.md')) {
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      const resolved = path.resolve(root, path.dirname(relative), target);
      assert(resolved.startsWith(root + path.sep));
      assert(fs.existsSync(resolved), `Broken link ${relative}: ${target}`);
      links++;
    }
  }
}
console.log(JSON.stringify({ synthetic_records: records.length, negative_cases_rejected: rejectionCount, markdown_links: links, safe_files: allowed.length, json_schema: validateSchemaRecord ? 'Ajv 2020 validated' : 'not run; pass --ajv2020 for full validation', limits: 'Contract checks only; no AI quality validation or preference calibration.' }, null, 2));
