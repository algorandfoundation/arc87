/**
 * Write a Tealer-friendly copy of the approval program with template variables substituted.
 *
 * Tealer refuses to analyze TEAL that still contains `TMPL_*` placeholders, so `audit-teal`
 * substitutes the values the demo deploys with (`DELETABLE=1`, `UPDATABLE=0`) into
 * `smart_contracts/artifacts/audit/ARC87.approval.teal` before running the analysis.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(PROJECT, "smart_contracts", "artifacts");
const TEMPLATE_VARS: Record<string, string> = {
  TMPL_DELETABLE: "1",
  TMPL_UPDATABLE: "0",
};

const source = join(ARTIFACTS, "ARC87.approval.teal");
if (!existsSync(source)) {
  console.error(`${source} not found - run \`npm run build\` first`);
  process.exit(1);
}
let teal = readFileSync(source, "utf-8");
for (const [name, value] of Object.entries(TEMPLATE_VARS)) {
  teal = teal.replaceAll(name, value);
}
const target = join(ARTIFACTS, "audit", "ARC87.approval.teal");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, teal);
console.log(`wrote ${relative(PROJECT, target)}`);
