import { access, readFile } from "node:fs/promises";

const required = [
  "README.md",
  "AGENTS.md",
  "ROADMAP.md",
  "PORTING_PROVENANCE.md",
  "docs/product/PRODUCT_REQUIREMENTS.md",
  "docs/architecture/00-principles-scope.md",
  "docs/architecture/01-system-architecture.md",
  "docs/implementation/v0.1/README.md",
  "docs/implementation/v0.1/plan.json",
  "docs/implementation/v0.1/POLICIES.json",
  "docs/implementation/v0.1/REQUIREMENT_OWNERSHIP.json",
  "docs/implementation/v0.1/ACCEPTANCE_MATRIX.md",
  "docs/implementation/v0.1/SPEC_TRACEABILITY.md",
  "docs/implementation/v0.1/DEFINITION_OF_DONE.md",
  "docs/agents/TASK_CLAIM.schema.json",
  "docs/agents/HANDOFF_TEMPLATE.md",
  "docs/agents/PHASE_REPORT_TEMPLATE.md",
  "docs/prompts/CI_DESIGN_PROMPT.md",
  "native/routerd.py",
  "native/sanitize_configs.py",
  "native/persona-mullvad-router.service.in"
];

const architectureFiles = {
  "00":"principles-scope","01":"system-architecture","02":"domain-data-storage",
  "03":"persona-browser-runtime","04":"routing-network-safety",
  "05":"browser-automation-provider-adapter","06":"module-system",
  "07":"module-package-lifecycle","08":"operation-coordination-recovery",
  "09":"scheduler-queue-batch","10":"security-secrets-human-tasks",
  "11":"backup-restore-portability","12":"ui-api-cli-agent-interfaces",
  "13":"installation-distribution","14":"testing-observability",
  "15":"ci-release-engineering","16":"porting-proven-work",
  "17":"module-domain-boundaries","18":"non-goals-deferred"
};
for (const [prefix,name] of Object.entries(architectureFiles)) {
  required.push(`docs/architecture/${prefix}-${name}.md`);
}
for (const path of required) await access(path);

const parse = async (path) => JSON.parse(await readFile(path, "utf8"));
const plan = await parse("docs/implementation/v0.1/plan.json");
const policies = await parse("docs/implementation/v0.1/POLICIES.json");
const ownership = await parse("docs/implementation/v0.1/REQUIREMENT_OWNERSHIP.json");
const taskClaimSchema = await parse("docs/agents/TASK_CLAIM.schema.json");
const roadmap = await readFile("ROADMAP.md", "utf8");
const acceptance = await readFile("docs/implementation/v0.1/ACCEPTANCE_MATRIX.md", "utf8");
const status = await readFile("docs/progress/STATUS.md", "utf8");
const agents = await readFile("AGENTS.md", "utf8");

if (plan.authority !== "docs/implementation/v0.1/plan.json") throw new Error("plan authority mismatch");
if (plan.humanExecutionView !== "ROADMAP.md") throw new Error("roadmap authority link missing");
if (plan.productAuthority !== "docs/product/PRODUCT_REQUIREMENTS.md") throw new Error("product authority mismatch");
if (plan.phases?.length !== 50) throw new Error(`expected exactly 50 phases, found ${plan.phases?.length}`);
if (plan.milestones?.length !== 13) throw new Error(`expected 13 milestones, found ${plan.milestones?.length}`);
if (plan.executionModel?.normalMaxTasks !== 3 || plan.executionModel?.normalMaxAcceptanceIds !== 5) {
  throw new Error("session-size structural limits changed without verifier update");
}
if (plan.executionModel?.exactlyOneActivePhase !== true || plan.executionModel?.sequentialExecution !== true) {
  throw new Error("one-phase sequential execution invariant missing");
}

if (policies.ci?.budget !== "UNLIMITED") throw new Error("CI budget policy must remain UNLIMITED");
if (policies.ci?.localStillRequired !== false) throw new Error("connector-only agents must not require local execution");
if (policies.routing?.protectedFallback !== "BLOCK; never Direct") throw new Error("protected routing fallback invariant missing");
if (policies.testing?.strategy !== "CI_FIRST_LIVE_LAST") throw new Error("testing strategy must remain CI_FIRST_LIVE_LAST");
if (policies.testing?.developmentPhaseRange !== "P001-P047") throw new Error("development phase range mismatch");
if (policies.testing?.livePhaseRange !== "P048-P049") throw new Error("live phase range mismatch");
if (policies.execution?.phaseParallelism !== 1 || policies.execution?.exactlyOneActivePhase !== true) {
  throw new Error("policy must enforce phase parallelism=1");
}

const allowedStatuses = new Set(["BLOCKED","READY","IN_PROGRESS","COMPLETE"]);
const phaseMap = new Map();
const acceptanceOwners = new Map();

for (let i=0; i<plan.phases.length; i+=1) {
  const phase=plan.phases[i];
  if (!/^P\d{3}$/.test(phase.id)) throw new Error(`invalid phase id ${phase.id}`);
  if (phase.id !== `P${String(i).padStart(3,"0")}`) throw new Error(`phase sequence gap/order error at ${phase.id}`);
  if (phaseMap.has(phase.id)) throw new Error(`duplicate phase ${phase.id}`);
  phaseMap.set(phase.id,phase);
  if (!allowedStatuses.has(phase.status)) throw new Error(`invalid status for ${phase.id}`);
  if (!/^M\d{2}$/.test(phase.milestone)) throw new Error(`invalid milestone on ${phase.id}`);
  if (!phase.objective || !Array.isArray(phase.nonGoals) || phase.nonGoals.length===0) throw new Error(`missing objective/nonGoals for ${phase.id}`);
  if (!Array.isArray(phase.tasks) || phase.tasks.length===0) throw new Error(`missing tasks for ${phase.id}`);
  if (!Array.isArray(phase.acceptanceIds) || phase.acceptanceIds.length===0) throw new Error(`missing acceptance for ${phase.id}`);
  if (!phase.sizeException && phase.tasks.length > 3) throw new Error(`${phase.id} exceeds 3-task session budget`);
  if (!phase.sizeException && phase.acceptanceIds.length > 5) throw new Error(`${phase.id} exceeds 5-acceptance session budget`);
  const expectedDep=i===0 ? [] : [plan.phases[i-1].id];
  if (JSON.stringify(phase.dependsOn ?? []) !== JSON.stringify(expectedDep)) throw new Error(`${phase.id} must depend only on immediate predecessor`);
  const taskIds=new Set();
  for (let t=0; t<phase.tasks.length; t+=1) {
    const task=phase.tasks[t];
    const expected=`T${phase.id.slice(1)}.${t+1}`;
    if (task.id !== expected) throw new Error(`${phase.id} task sequence expected ${expected}, got ${task.id}`);
    if (taskIds.has(task.id)) throw new Error(`duplicate task ${task.id}`);
    taskIds.add(task.id);
  }
  for (const aid of phase.acceptanceIds) {
    if (!/^A\d{2}-\d{2}$/.test(aid)) throw new Error(`invalid acceptance id ${aid}`);
    if (acceptanceOwners.has(aid)) throw new Error(`acceptance ${aid} owned by multiple phases`);
    acceptanceOwners.set(aid,phase.id);
  }
}

const active=plan.phases.filter(p=>p.status==="READY" || p.status==="IN_PROGRESS");
if (active.length !== 1) throw new Error(`exactly one active phase required, found ${active.length}`);
const activePhase=active[0];
const activeIndex=plan.phases.findIndex(p=>p.id===activePhase.id);
for (let i=0; i<plan.phases.length; i+=1) {
  const p=plan.phases[i];
  if (i<activeIndex && p.status!=="COMPLETE") throw new Error(`${p.id} before active phase is not COMPLETE`);
  if (i>activeIndex && p.status!=="BLOCKED") throw new Error(`${p.id} after active phase must remain BLOCKED`);
}

const milestoneMap=new Map();
const flattened=[];
for (const m of plan.milestones) {
  if (!/^M\d{2}$/.test(m.id)) throw new Error(`invalid milestone id ${m.id}`);
  if (milestoneMap.has(m.id)) throw new Error(`duplicate milestone ${m.id}`);
  milestoneMap.set(m.id,m);
  if (!allowedStatuses.has(m.status)) throw new Error(`invalid milestone status ${m.id}`);
  for (const pid of m.phaseIds ?? []) flattened.push(pid);
}
if (JSON.stringify(flattened) !== JSON.stringify(plan.phases.map(p=>p.id))) throw new Error("milestone phase ordering/coverage mismatch");
for (const m of plan.milestones) {
  const memberPhases=m.phaseIds.map(pid=>phaseMap.get(pid));
  if (memberPhases.some(p=>!p)) throw new Error(`milestone ${m.id} references missing phase`);
  const completeCount=memberPhases.filter(p=>p.status==="COMPLETE").length;
  const hasActive=memberPhases.some(p=>p.status==="READY" || p.status==="IN_PROGRESS");
  let expected;
  if (completeCount===memberPhases.length) expected="COMPLETE";
  else if (hasActive) expected=completeCount===0 ? "READY" : "IN_PROGRESS";
  else expected="BLOCKED";
  if (m.status!==expected) throw new Error(`milestone ${m.id} status ${m.status}, expected ${expected}`);
}
for (const p of plan.phases) {
  if (!milestoneMap.get(p.milestone)?.phaseIds.includes(p.id)) throw new Error(`${p.id} missing from declared milestone`);
}

// ROADMAP: phase headings/status/order plus tasks/acceptance IDs.
const roadmapHeadings=[...roadmap.matchAll(/^### (P\d{3}) — /gm)].map(m=>m[1]);
if (JSON.stringify(roadmapHeadings) !== JSON.stringify(plan.phases.map(p=>p.id))) throw new Error("ROADMAP phase order/coverage mismatch");
for (let i=0; i<plan.phases.length; i+=1) {
  const p=plan.phases[i];
  const start=roadmap.indexOf(`### ${p.id} — ${p.name}`);
  const end=i+1<plan.phases.length ? roadmap.indexOf(`### ${plan.phases[i+1].id} —`) : roadmap.length;
  if (start<0 || end<start) throw new Error(`ROADMAP block missing for ${p.id}`);
  const block=roadmap.slice(start,end);
  if (!block.includes(`Status: **${p.status}**`)) throw new Error(`ROADMAP status mismatch for ${p.id}`);
  for (const task of p.tasks) if (!block.includes(`${task.id} — ${task.name}`)) throw new Error(`ROADMAP missing ${task.id}`);
  for (const aid of p.acceptanceIds) if (!block.includes(aid)) throw new Error(`ROADMAP missing ${aid} under ${p.id}`);
  if (p.status==="COMPLETE") {
    for (const task of p.tasks) if (!block.includes(`- [x] ${task.id}`)) throw new Error(`COMPLETE ${p.id} has unchecked task ${task.id}`);
    await access(`reports/phases/${p.id}.md`);
  }
  if (p.status==="BLOCKED" && block.includes("- [~]")) throw new Error(`BLOCKED ${p.id} has IN PROGRESS task`);
  if (p.status==="IN_PROGRESS") {
    const inProgress=(block.match(/^- \[~\] /gm) ?? []).length;
    if (inProgress !== 1) throw new Error(`IN_PROGRESS ${p.id} must have exactly one [~] task`);
  }
}
if (!status.includes(`Current phase: **${activePhase.id} — ${activePhase.status}**`)) throw new Error("STATUS current phase mismatch");

// Acceptance matrix exact ownership.
const acceptanceRows=acceptance.split("\n").flatMap((line)=>{
  const m=line.match(/^\| (A\d{2}-\d{2}) \| (M\d{2}) \| (P\d{3}) \| ([^|]+) \|/);
  return m ? [{id:m[1],milestone:m[2],phase:m[3],evidence:m[4].trim()}] : [];
});
if (acceptanceRows.length !== acceptanceOwners.size) throw new Error("acceptance matrix row count mismatch");
const seenAcceptance=new Set();
for (const row of acceptanceRows) {
  if (seenAcceptance.has(row.id)) throw new Error(`duplicate acceptance row ${row.id}`);
  seenAcceptance.add(row.id);
  const p=phaseMap.get(row.phase);
  if (!p) throw new Error(`acceptance ${row.id} points to missing ${row.phase}`);
  if (acceptanceOwners.get(row.id)!==row.phase) throw new Error(`acceptance owner mismatch for ${row.id}`);
  if (p.milestone!==row.milestone) throw new Error(`acceptance milestone mismatch for ${row.id}`);
  const live=row.phase==="P048" || row.phase==="P049";
  if (!live && /(^|\/)(L|P|R|A)(\/|$)/.test(row.evidence)) throw new Error(`${row.id} uses live evidence before P048`);
  if (live && row.evidence!=="L") throw new Error(`${row.id} final live acceptance must use L evidence`);
}

// Requirement ownership may only reference real session phases.
if (!Array.isArray(ownership.rules) || ownership.rules.length < 10) throw new Error("requirement ownership ledger unexpectedly small");
for (const [idx,rule] of ownership.rules.entries()) {
  for (const pid of rule.phases ?? []) if (!phaseMap.has(pid)) throw new Error(`ownership rule ${idx} references missing phase ${pid}`);
}

// Task claim schema must use three-digit session IDs.
if (taskClaimSchema.properties?.phase?.pattern !== "^P\\d{3}$") throw new Error("task claim phase pattern mismatch");
if (taskClaimSchema.properties?.taskId?.pattern !== "^T\\d{3}\\.\\d+$") throw new Error("task claim task pattern mismatch");

const prd=await readFile("docs/product/PRODUCT_REQUIREMENTS.md","utf8");
for (const phrase of [
  "A Persona is a persistent and isolated browser identity",
  "one active Account ↔ one dedicated Persona",
  "Unknown external state fails safely",
  "# 19. Agent and development usability",
  "Reliable agent operation is a product requirement",
  "# 27. Implementation freedom",
  "# 29. Requirement hierarchy",
  "Architecture should serve the product, not define it."
]) if (!prd.includes(phrase)) throw new Error(`product requirements missing authority marker: ${phrase}`);
if (prd.split("\n").length < 1470) throw new Error("product requirements appear truncated");

for (const phrase of [
  "GitHub is the source of truth",
  "Exactly one phase globally may be `READY` or `IN_PROGRESS`",
  "Do not implement even the first task of the new READY phase in the same session.",
  "P001–P047 MUST be closable without MCP",
  "Actions usage is **not budget-constrained**",
  "Uncertain external mutation"
]) if (!agents.includes(phrase)) throw new Error(`AGENTS missing invariant: ${phrase}`);

console.log(`repository verification passed: ${plan.phases.length} session phases, ${plan.milestones.length} milestones, active=${activePhase.id}, ${ownership.rules.length} ownership rules`);
