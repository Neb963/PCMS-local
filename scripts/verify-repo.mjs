import { access, readFile } from "node:fs/promises";

const required = [
  "README.md",
  "AGENTS.md",
  "PORTING_PROVENANCE.md",
  "docs/product/PRODUCT_REQUIREMENTS.md",
  "docs/architecture/00-principles-scope.md",
  "docs/architecture/01-system-architecture.md",
  "docs/implementation/v0.1/plan.json",
  "docs/implementation/v0.1/POLICIES.json",
  "docs/implementation/v0.1/REQUIREMENT_OWNERSHIP.json",
  "docs/implementation/v0.1/ACCEPTANCE_MATRIX.md",
  "docs/implementation/v0.1/SPEC_TRACEABILITY.md",
  "docs/implementation/v0.1/DEFINITION_OF_DONE.md",
  "docs/agents/TASK_CLAIM.schema.json",
  "docs/prompts/CI_DESIGN_PROMPT.md",
  "native/routerd.py",
  "native/sanitize_configs.py",
  "native/persona-mullvad-router.service.in"
];

for (let i = 0; i <= 18; i += 1) {
  const prefix = String(i).padStart(2, "0");
  const known = {
    "00": "principles-scope",
    "01": "system-architecture",
    "02": "domain-data-storage",
    "03": "persona-browser-runtime",
    "04": "routing-network-safety",
    "05": "browser-automation-provider-adapter",
    "06": "module-system",
    "07": "module-package-lifecycle",
    "08": "operation-coordination-recovery",
    "09": "scheduler-queue-batch",
    "10": "security-secrets-human-tasks",
    "11": "backup-restore-portability",
    "12": "ui-api-cli-agent-interfaces",
    "13": "installation-distribution",
    "14": "testing-observability",
    "15": "ci-release-engineering",
    "16": "porting-proven-work",
    "17": "module-domain-boundaries",
    "18": "non-goals-deferred"
  };
  required.push(`docs/architecture/${prefix}-${known[prefix]}.md`);
}

for (const path of required) await access(path);

const parse = async (path) => JSON.parse(await readFile(path, "utf8"));
const plan = await parse("docs/implementation/v0.1/plan.json");
const policies = await parse("docs/implementation/v0.1/POLICIES.json");
const ownership = await parse("docs/implementation/v0.1/REQUIREMENT_OWNERSHIP.json");
await parse("docs/agents/TASK_CLAIM.schema.json");

if (plan.authority !== "docs/implementation/v0.1/plan.json") throw new Error("plan authority mismatch");
if (plan.productAuthority !== "docs/product/PRODUCT_REQUIREMENTS.md") throw new Error("product authority mismatch");
if (policies.ci?.budget !== "UNLIMITED") throw new Error("CI budget policy must remain UNLIMITED");
if (policies.routing?.protectedFallback !== "BLOCK; never Direct") throw new Error("protected routing fallback invariant missing");

const ids = new Set();
const phaseMap = new Map();
for (const phase of plan.phases ?? []) {
  if (!/^P\d{2}$/.test(phase.id)) throw new Error(`invalid phase id ${phase.id}`);
  if (ids.has(phase.id)) throw new Error(`duplicate phase ${phase.id}`);
  ids.add(phase.id);
  phaseMap.set(phase.id, phase);
  if (!["BLOCKED","READY","IN_PROGRESS","COMPLETE"].includes(phase.status)) throw new Error(`invalid status for ${phase.id}`);
  if (!Array.isArray(phase.acceptanceIds) || phase.acceptanceIds.length === 0) throw new Error(`missing acceptance IDs for ${phase.id}`);
  const taskIds = new Set();
  for (const task of phase.tasks ?? []) {
    if (taskIds.has(task.id)) throw new Error(`duplicate task ${task.id}`);
    taskIds.add(task.id);
  }
}
for (const phase of phaseMap.values()) {
  for (const dep of phase.dependsOn ?? []) {
    if (!phaseMap.has(dep)) throw new Error(`${phase.id} depends on missing ${dep}`);
    if (dep >= phase.id) throw new Error(`${phase.id} has non-earlier dependency ${dep}`);
  }
}

const acceptance = await readFile("docs/implementation/v0.1/ACCEPTANCE_MATRIX.md", "utf8");
for (const phase of phaseMap.values()) {
  for (const id of phase.acceptanceIds) {
    if (!acceptance.includes(`| ${id} |`)) throw new Error(`acceptance matrix missing ${id}`);
  }
}

if (!Array.isArray(ownership.rules) || ownership.rules.length < 10) throw new Error("requirement ownership ledger unexpectedly small");

const prd = await readFile("docs/product/PRODUCT_REQUIREMENTS.md", "utf8");
for (const phrase of [
  "A Persona is a persistent and isolated browser identity",
  "one active Account ↔ one dedicated Persona",
  "Unknown external state fails safely",
  "# 19. Agent and development usability",
  "Reliable agent operation is a product requirement",
  "# 27. Implementation freedom",
  "# 29. Requirement hierarchy",
  "Architecture should serve the product, not define it."
]) {
  if (!prd.includes(phrase)) throw new Error(`product requirements missing authority marker: ${phrase}`);
}

if (prd.split("\n").length < 1470) throw new Error("product requirements appear truncated");

const agents = await readFile("AGENTS.md", "utf8");
for (const phrase of ["GitHub is the source of truth", "Actions usage is **not budget-constrained**", "Uncertain external mutation"]) {
  if (!agents.includes(phrase)) throw new Error(`AGENTS missing invariant: ${phrase}`);
}

console.log(`repository verification passed: ${phaseMap.size} phases, ${ownership.rules.length} ownership rules`);
