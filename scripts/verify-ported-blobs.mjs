import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const expected = new Map([
  ["native/sanitize_configs.py", "297e06bd909ca9dd02d31bd3a4b1550c8b9bd825"],
  ["native/persona-mullvad-router.service.in", "55bb2af323c578d02ef661029664531e7fde8dc3"],
  ["native/routerctl.py", "f873d588e1b625899ab76b8afd9c25ded37f8e47"],
  ["tests/test_native.py", "c6dc70ca38b4ee893fafb457e1ea12a9b1096402"],
  ["tests/test_forwarder_auth.py", "54e963e54e105e81202bfa13a225126662dcb331"],
  ["tests/test_native_service_hardening.py", "dfe934e451f829088195feb066268077f820d64c"],
  ["LICENSE", "14fac913ccf80234b1848540089a3bbcb6e5283d"]
]);

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

for (const [path, sha] of expected) {
  const bytes = await readFile(path);
  const actual = gitBlobSha(bytes);
  if (actual !== sha) throw new Error(`${path}: expected upstream blob ${sha}, got ${actual}`);
}
const provenance = await readFile("PORTING_PROVENANCE.md", "utf8");
if (!provenance.includes("P017 adaptation") || !provenance.includes("345911a056c4a01db86e6a805d49b7d44233e7a1")) {
  throw new Error("adapted routerd.py must retain its upstream provenance record");
}
console.log(`ported-source verification passed: ${expected.size} exact upstream blobs; routerd.py tracked as adapted`);
