import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import {
  DeployerTargetMappingError,
  DeployerTargetResolver
} from "../../dist/deployer/target-mapping.js";
import { GeneratorRepository } from "../../dist/generators/generator-repository.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T16:20:00.000Z")
  });
  const accounts = new AccountRepository({ database });
  const bindings = new PersonaBindingService({ database });
  const generators = new GeneratorRepository({ database });
  const personaUid = "persona_deployer_mapping";
  database.prepare(`
    INSERT INTO personas (
      persona_uid, lifecycle_status, profile_state, browser_backend,
      profile_relative_path, profile_delete_state, profile_deleted_at,
      profile_backup_decision, created_at, updated_at, retired_at, revision
    ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, 'PRESENT',
      NULL, NULL, ?, ?, NULL, 0)
  `).run(
    personaUid,
    `personas/${personaUid}/chromium`,
    "2026-10-03T16:20:00.000Z",
    "2026-10-03T16:20:00.000Z"
  );
  accounts.create({
    accountId: "account_deployer",
    displayName: "Deployment account"
  });
  bindings.bind({
    accountId: "account_deployer",
    personaUid,
    expectedRevision: 0,
    reason: "P031 deployment fixture"
  });
  return { root, database, generators, personaUid };
}

function provider(evidence) {
  return {
    async probeGeneratorIdentity() {
      return evidence;
    }
  };
}

function verified(generatorLocalId, providerStableId, slug) {
  return {
    generatorLocalId,
    sessionStatus: "EXPECTED",
    identityStatus: "VERIFIED",
    slugStatus: "CURRENT",
    expectedProviderStableId: providerStableId,
    expectedSlug: slug,
    observedProviderStableId: providerStableId,
    observedSlug: slug,
    reasonCode: "GENERATOR_VERIFIED",
    observedAt: "2026-10-03T16:21:00.000Z"
  };
}

test("P031 repository slug resolves to stable Account/GeneratorRef then revalidates provider identity", async () => {
  const f = await fixture("pcms-deployer-target-");
  try {
    f.generators.create({
      generatorLocalId: "generator_stable",
      accountId: "account_deployer",
      providerStableId: "public-stable-31",
      currentSlug: "repository-generator"
    });
    const resolver = new DeployerTargetResolver({
      database: f.database,
      provider: provider(
        verified(
          "generator_stable",
          "public-stable-31",
          "repository-generator"
        )
      )
    });

    const resolved = await resolver.resolve({
      page: {},
      accountId: "account_deployer",
      repositorySlug: "repository-generator",
      expectedProviderIdentity: "owner@example.test"
    });

    assert.equal(resolved.account.accountId, "account_deployer");
    assert.equal(resolved.personaUid, f.personaUid);
    assert.equal(resolved.generator.generatorLocalId, "generator_stable");
    assert.equal(resolved.generator.providerStableId, "public-stable-31");
    assert.equal(resolved.identityEvidence.identityStatus, "VERIFIED");
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P031 slug-only or ambiguous mapping cannot become a mutation target", async () => {
  const f = await fixture("pcms-deployer-target-guards-");
  try {
    f.generators.create({
      generatorLocalId: "generator_without_stable",
      accountId: "account_deployer",
      currentSlug: "slug-only"
    });
    let resolver = new DeployerTargetResolver({
      database: f.database,
      provider: provider(
        verified("generator_without_stable", "unused", "slug-only")
      )
    });
    await assert.rejects(
      () => resolver.resolve({
        page: {},
        accountId: "account_deployer",
        repositorySlug: "slug-only",
        expectedProviderIdentity: "owner@example.test"
      }),
      (error) =>
        error instanceof DeployerTargetMappingError &&
        error.code === "DEPLOYER_TARGET_STABLE_ID_REQUIRED"
    );

    f.generators.create({
      generatorLocalId: "generator_ambiguous_one",
      accountId: "account_deployer",
      providerStableId: "public-ambiguous-one",
      currentSlug: "ambiguous"
    });
    f.generators.create({
      generatorLocalId: "generator_ambiguous_two",
      accountId: "account_deployer",
      providerStableId: "public-ambiguous-two",
      currentSlug: "ambiguous"
    });
    resolver = new DeployerTargetResolver({
      database: f.database,
      provider: provider(
        verified(
          "generator_ambiguous_one",
          "public-ambiguous-one",
          "ambiguous"
        )
      )
    });
    await assert.rejects(
      () => resolver.resolve({
        page: {},
        accountId: "account_deployer",
        repositorySlug: "ambiguous",
        expectedProviderIdentity: "owner@example.test"
      }),
      (error) =>
        error instanceof DeployerTargetMappingError &&
        error.code === "DEPLOYER_TARGET_AMBIGUOUS"
    );
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P031 fresh provider stable-ID or slug mismatch fails closed", async () => {
  const f = await fixture("pcms-deployer-target-mismatch-");
  try {
    f.generators.create({
      generatorLocalId: "generator_guarded",
      accountId: "account_deployer",
      providerStableId: "public-guarded",
      currentSlug: "guarded"
    });

    let resolver = new DeployerTargetResolver({
      database: f.database,
      provider: provider({
        ...verified("generator_guarded", "public-other", "guarded"),
        expectedProviderStableId: "public-guarded",
        identityStatus: "MISMATCH",
        observedProviderStableId: "public-other",
        reasonCode: "GENERATOR_STABLE_ID_MISMATCH"
      })
    });
    await assert.rejects(
      () => resolver.resolve({
        page: {},
        accountId: "account_deployer",
        repositorySlug: "guarded",
        expectedProviderIdentity: "owner@example.test"
      }),
      (error) =>
        error instanceof DeployerTargetMappingError &&
        error.code === "DEPLOYER_TARGET_IDENTITY_UNVERIFIED"
    );

    resolver = new DeployerTargetResolver({
      database: f.database,
      provider: provider({
        ...verified("generator_guarded", "public-guarded", "guarded"),
        slugStatus: "CHANGED",
        observedSlug: "renamed",
        reasonCode: "GENERATOR_SLUG_CHANGED"
      })
    });
    await assert.rejects(
      () => resolver.resolve({
        page: {},
        accountId: "account_deployer",
        repositorySlug: "guarded",
        expectedProviderIdentity: "owner@example.test"
      }),
      (error) =>
        error instanceof DeployerTargetMappingError &&
        error.code === "DEPLOYER_TARGET_SLUG_CHANGED"
    );
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
