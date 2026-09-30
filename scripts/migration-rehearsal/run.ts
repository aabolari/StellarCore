import "dotenv/config";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CORE_UTILS } from "./lib/core.ts";
import { verifyApplicationCompatibility } from "./lib/compatibility.ts";
import { createScenario1 } from "./scenarios/scenario1.ts";
import { createScenario2 } from "./scenarios/scenario2.ts";
import { createScenario3 } from "./scenarios/scenario3.ts";
import type {
  RehearsalConfig,
  RehearsalReport,
  RehearsalScenario,
} from "./lib/core.ts";

const { assertNotProduction, getMigrationHistory, createOutputDir, writeJson, REPO_ROOT } =
  CORE_UTILS;

async function runScenario(
  scenario: RehearsalScenario,
  config: RehearsalConfig,
): Promise<RehearsalReport> {
  const outputDir = createOutputDir(config.outputDir, scenario.id);

  console.log(`\n=== ${scenario.name} ===`);
  console.log(`Description: ${scenario.description}`);
  console.log(`Failure point: ${scenario.failurePoint}`);
  console.log(`Database: ${config.databaseUrl.replace(/:[^:]+@/, ":****@")}`);
  console.log(`Output dir: ${outputDir}`);

  if (config.dryRun) {
    console.log("DRY RUN - skipping actual execution");
    return Object.freeze({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      timestamp: new Date().toISOString(),
      databaseUrl: config.databaseUrl,
      initialState: [],
      failureState: [],
      verification: { ok: true, checks: [], summary: "DRY RUN" },
      recovery: { strategy: "rollback", success: true, steps: [], warnings: [] },
      finalState: [],
      compatibility: { ok: true, checks: [] },
    });
  }

  assertNotProduction(config.databaseUrl);

  console.log("\n[1/5] Capturing initial migration state...");
  const initialState = await getMigrationHistory(config.databaseUrl);

  console.log("\n[2/5] Setting up failure scenario...");
  await scenario.setup(config.databaseUrl);

  console.log("\n[3/5] Capturing failure state...");
  const failureState = await getMigrationHistory(config.databaseUrl);

  console.log("\n[4/5] Verifying intermediate state...");
  const verification = await scenario.verify(config.databaseUrl);
  console.log(`   Verification: ${verification.ok ? "PASS" : "FAIL"}`);
  for (const check of verification.checks) {
    console.log(`   - ${check.name}: ${check.ok ? "✓" : "✗"} ${check.details}`);
  }

  console.log("\n[5/5] Executing recovery...");
  const recovery = await scenario.recovery(config.databaseUrl);
  console.log(`   Recovery: ${recovery.success ? "SUCCESS" : "FAILED"} (${recovery.strategy})`);
  for (const step of recovery.steps) {
    console.log(`   - ${step}`);
  }
  for (const warning of recovery.warnings) {
    console.log(`   ⚠ ${warning}`);
  }

  console.log("\n[6/6] Verifying application compatibility...");
  const compatibility = await verifyApplicationCompatibility(config.databaseUrl);
  console.log(`   Compatibility: ${compatibility.ok ? "PASS" : "FAIL"}`);
  for (const check of compatibility.checks) {
    if (!check.ok) {
      console.log(`   - ${check.name}: ${check.ok ? "✓" : "✗"} ${check.details}`);
    }
  }

  const finalState = await getMigrationHistory(config.databaseUrl);

  const report: RehearsalReport = Object.freeze({
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    timestamp: new Date().toISOString(),
    databaseUrl: config.databaseUrl,
    initialState: Object.freeze(initialState),
    failureState: Object.freeze(failureState),
    verification,
    recovery,
    finalState: Object.freeze(finalState),
    compatibility,
  });

  const reportFile = join(outputDir, "report.json");
  writeJson(reportFile, report);
  console.log(`\nReport written to: ${reportFile}`);

  const summaryFile = join(outputDir, "SUMMARY.md");
  writeFileSync(summaryFile, generateSummary(report), "utf-8");
  console.log(`Summary written to: ${summaryFile}`);

  return report;
}

function generateSummary(report: RehearsalReport): string {
  const lines = [
    `# Migration Recovery Rehearsal Report`,
    ``,
    `**Scenario:** ${report.scenarioName}`,
    `**ID:** ${report.scenarioId}`,
    `**Timestamp:** ${report.timestamp}`,
    `**Database:** ${report.databaseUrl.replace(/:[^:]+@/, ":****@")}`,
    ``,
    `## Initial State`,
    ``,
    `| Migration | Status | Finished | Steps Applied |`,
    `|-----------|--------|----------|---------------|`,
    ...report.initialState.map(
      (m) =>
        `| ${m.migrationName} | ${m.finishedAt ? "applied" : "pending"} | ${m.finishedAt?.toISOString() ?? "N/A"} | ${m.appliedStepsCount} |`,
    ),
    ``,
    `## Failure State`,
    ``,
    `| Migration | Status | Finished | Steps Applied |`,
    `|-----------|--------|----------|---------------|`,
    ...report.failureState.map(
      (m) =>
        `| ${m.migrationName} | ${m.finishedAt ? "applied" : "pending"} | ${m.finishedAt?.toISOString() ?? "N/A"} | ${m.appliedStepsCount} |`,
    ),
    ``,
    `## Verification`,
    ``,
    `**Overall:** ${report.verification.ok ? "✅ PASS" : "❌ FAIL"}`,
    ``,
    report.verification.summary,
    ``,
    `| Check | Result | Details |`,
    `|-------|--------|---------|`,
    ...report.verification.checks.map(
      (c) => `| ${c.name} | ${c.ok ? "✅" : "❌"} | ${c.details} |`,
    ),
    ``,
    `## Recovery`,
    ``,
    `**Strategy:** ${report.recovery.strategy}`,
    `**Success:** ${report.recovery.success ? "✅ YES" : "❌ NO"}`,
    ``,
    `### Steps`,
    ``,
    ...report.recovery.steps.map((s) => `- ${s}`),
    ``,
    report.recovery.warnings.length > 0
      ? `### Warnings\n\n${report.recovery.warnings.map((w) => `- ⚠ ${w}`).join("\n")}\n`
      : "",
    `## Final State`,
    ``,
    `| Migration | Status | Finished | Steps Applied |`,
    `|-----------|--------|----------|---------------|`,
    ...report.finalState.map(
      (m) =>
        `| ${m.migrationName} | ${m.finishedAt ? "applied" : "pending"} | ${m.finishedAt?.toISOString() ?? "N/A"} | ${m.appliedStepsCount} |`,
    ),
    ``,
    `## Application Compatibility`,
    ``,
    `**Overall:** ${report.compatibility.ok ? "✅ PASS" : "❌ FAIL"}`,
    ``,
    `| Check | Result | Details |`,
    `|-------|--------|---------|`,
    ...report.compatibility.checks.map(
      (c) => `| ${c.name} | ${c.ok ? "✅" : "❌"} | ${c.details} |`,
    ),
    ``,
    `---`,
    `*Generated by migration-rehearsal framework*`,
  ];

  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const scenarioFilter = args.find((a) => a.startsWith("--scenario="))?.split("=")[1];

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required");
    console.error("Usage: DATABASE_URL=postgresql://... tsx scripts/migration-rehearsal/run.ts [--dry-run] [--scenario=<id>]");
    process.exit(1);
  }

  const outputDir = join(REPO_ROOT, "migration-rehearsal-reports");
  const config: RehearsalConfig = {
    databaseUrl,
    outputDir,
    dryRun,
  };

  console.log("Migration Recovery Rehearsal Framework");
  console.log("=======================================");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Output: ${outputDir}`);

  const scenarios: RehearsalScenario[] = [
    await createScenario1(),
    await createScenario2(),
    await createScenario3(),
  ];

  const filteredScenarios = scenarioFilter
    ? scenarios.filter((s) => s.id === scenarioFilter)
    : scenarios;

  if (filteredScenarios.length === 0) {
    console.error(`No scenario found matching: ${scenarioFilter}`);
    process.exit(1);
  }

  const reports: RehearsalReport[] = [];

  for (const scenario of filteredScenarios) {
    try {
      const report = await runScenario(scenario, config);
      reports.push(report);
    } catch (e) {
      console.error(`\n❌ Scenario ${scenario.id} failed:`, e);
      const errorReport: RehearsalReport = Object.freeze({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        timestamp: new Date().toISOString(),
        databaseUrl: config.databaseUrl,
        initialState: [],
        failureState: [],
        verification: { ok: false, checks: [], summary: `Scenario setup failed: ${e}` },
        recovery: { strategy: "manual", success: false, steps: [], warnings: [String(e)] },
        finalState: [],
        compatibility: { ok: false, checks: [] },
      });
      reports.push(errorReport);
    }
  }

  const summaryFile = join(config.outputDir, `summary-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeJson(summaryFile, Object.freeze({ reports }));
  console.log(`\nOverall summary written to: ${summaryFile}`);

  const failed = reports.filter((r) => !r.verification.ok || !r.recovery.success || !r.compatibility.ok);
  if (failed.length > 0) {
    console.log(`\n⚠ ${failed.length} scenario(s) had issues:`);
    for (const r of failed) {
      console.log(`  - ${r.scenarioId}: verification=${r.verification.ok} recovery=${r.recovery.success} compatibility=${r.compatibility.ok}`);
    }
    process.exit(1);
  }

  console.log("\n✅ All scenarios completed successfully");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}