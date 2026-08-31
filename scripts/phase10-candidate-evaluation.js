const fs = require("node:fs");
const path = require("node:path");

const core = require(path.join(process.cwd(), ".test-dist", "lib", "phase10", "nestedCandidateEvaluation.js"));

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const inputPath = argumentValue("--pre-oos-input");
if (!inputPath) {
  throw new Error("Usage: node scripts/phase10-candidate-evaluation.js --pre-oos-input <rows.json>");
}

const rows = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
core.assertPreOosRows(rows);
const split = core.splitOuterTrain(rows);
const fit = core.fitCandidateOnInnerTrain(split.innerTrain);

console.log(JSON.stringify({
  dates: core.PHASE10_DATES,
  candidateCount: core.ROUND1_CANDIDATES.length,
  coefficientOptionCount: core.COEFFICIENT_OPTIONS.length,
  innerTrainRows: split.innerTrain.length,
  innerValidationRows: split.innerValidation.length,
  fit,
}, null, 2));