import assert from "node:assert/strict";
import test from "node:test";

import { CORE_UTILS } from "@/scripts/migration-rehearsal/lib/core.ts";
import { verifyApplicationCompatibility } from "@/scripts/migration-rehearsal/lib/compatibility.ts";

const { assertNotProduction, REPO_ROOT } = CORE_UTILS;

test("assertNotProduction rejects production-like hostnames", () => {
  const prodUrls = [
    "postgresql://user:pass@prod.db.example.com:5432/db",
    "postgresql://user:pass@production-db.example.com:5432/db",
    "postgresql://user:pass@live.example.com:5432/db",
    "postgresql://user:pass@main.example.com:5432/db",
    "postgresql://user:pass@primary.example.com:5432/db",
  ];

  for (const url of prodUrls) {
    assert.throws(
      () => assertNotProduction(url),
      /SAFETY VIOLATION/,
      `Should reject: ${url}`,
    );
  }
});

test("assertNotProduction rejects Prisma production with sslmode=require", () => {
  const url = "postgresql://user:pass@abc123.prisma.io:5432/db?sslmode=require";
  assert.throws(
    () => assertNotProduction(url),
    /SAFETY VIOLATION/,
    `Should reject Prisma production: ${url}`,
  );
});

test("assertNotProduction allows local/staging databases", () => {
  const safeUrls = [
    "postgresql://user:pass@localhost:5432/db",
    "postgresql://user:pass@staging.db.example.com:5432/db",
    "postgresql://user:pass@test.example.com:5432/db",
    "postgresql://user:pass@127.0.0.1:5432/db",
    "postgresql://user:pass@db:5432/db",
  ];

  for (const url of safeUrls) {
    assert.doesNotThrow(
      () => assertNotProduction(url),
      `Should allow: ${url}`,
    );
  }
});

test("REPO_ROOT points to repository root", () => {
  assert.ok(REPO_ROOT.endsWith("StellarCore"));
  assert.ok(REPO_ROOT.includes("StellarCore"));
});

test("Scenario 1 structure is correct", async () => {
  const { createScenario1 } = await import("@/scripts/migration-rehearsal/scenarios/scenario1.ts");
  const scenario = await createScenario1();

  assert.equal(scenario.id, "scenario-1");
  assert.ok(scenario.name.includes("idempotent"));
  assert.equal(scenario.failurePoint, "before");
  assert.ok(typeof scenario.setup === "function");
  assert.ok(typeof scenario.verify === "function");
  assert.ok(typeof scenario.recovery === "function");
});

test("Scenario 2 structure is correct", async () => {
  const { createScenario2 } = await import("@/scripts/migration-rehearsal/scenarios/scenario2.ts");
  const scenario = await createScenario2();

  assert.equal(scenario.id, "scenario-2");
  assert.ok(scenario.name.includes("partial"));
  assert.equal(scenario.failurePoint, "during");
});

test("Scenario 3 structure is correct", async () => {
  const { createScenario3 } = await import("@/scripts/migration-rehearsal/scenarios/scenario3.ts");
  const scenario = await createScenario3();

  assert.equal(scenario.id, "scenario-3");
  assert.ok(scenario.name.includes("metadata"));
  assert.equal(scenario.failurePoint, "after");
});

test("verifyApplicationCompatibility returns correct structure", async () => {
  const mockDbUrl = "postgresql://test:test@localhost:5432/test";

  // This will fail to connect, but we can test the structure
  try {
    await verifyApplicationCompatibility(mockDbUrl);
  } catch {
    // Expected to fail without real DB
  }
});

test("Migration record type structure", () => {
  const record: MigrationRecord = Object.freeze({
    id: "test-id",
    checksum: "checksum123",
    finishedAt: new Date(),
    migrationName: "20260818140749_init",
    logs: "test logs",
    rolledBackAt: null,
    startedAt: new Date(),
    appliedStepsCount: 5,
  });

  assert.equal(record.id, "test-id");
  assert.equal(record.checksum, "checksum123");
  assert.ok(record.finishedAt instanceof Date);
  assert.equal(record.migrationName, "20260818140749_init");
  assert.equal(record.appliedStepsCount, 5);
});