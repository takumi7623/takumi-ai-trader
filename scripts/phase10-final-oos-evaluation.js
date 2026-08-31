const fs = require("node:fs");
const path = require("node:path");

const core = require(path.join(process.cwd(), ".test-dist", "lib", "phase10", "nestedCandidateEvaluation.js"));

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const specPath = argumentValue("--frozen-spec");
const inputPath = argumentValue("--final-oos-input");
if (!specPath || !inputPath) {
  throw new Error("Usage: node scripts/phase10-final-oos-evaluation.js --frozen-spec <spec.json> --final-oos-input <rows.json>");
}

const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), "utf8"));
const rows = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
const result = core.evaluateFrozenSpecOnFinalOos(spec, rows, (_row, increment) => increment);

console.log(JSON.stringify(result, null, 2));