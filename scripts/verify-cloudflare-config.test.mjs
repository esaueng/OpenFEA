import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  backupQuotaBinding,
  backupQuotaMigration,
  parseJsonc,
  productionMigrations,
  readCloudflareConfigs,
  validateCloudflareConfigs
} from "./verify-cloudflare-config.mjs";

const rootDir = resolve(import.meta.dirname, "..");

function readConfig(path) {
  return parseJsonc(readFileSync(resolve(rootDir, path), "utf8"), path);
}

function clone(value) {
  return structuredClone(value);
}

describe("Cloudflare deployment config guard (post cloud retirement)", () => {
  test("passes with static assets and the isolated encrypted backup binding", () => {
    const { defaultConfig, retiredDoCleanupConfig, staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const readme = readFileSync(resolve(rootDir, "README.md"), "utf8");

    expect(defaultConfig.name).toBe("openfea");
    expect(staticConfig.name).toBe("openfea-static");
    expect(defaultConfig.containers).toBeUndefined();
    expect(defaultConfig.durable_objects).toEqual({ bindings: [{ name: "PROJECT_BACKUP_DAILY_QUOTA", class_name: "ProjectBackupDailyQuota" }] });
    expect(staticConfig.durable_objects).toBeUndefined();
    expect(retiredDoCleanupConfig.durable_objects).toBeUndefined();
    expect(defaultConfig.r2_buckets).toEqual([{ binding: "PROJECT_BACKUPS", bucket_name: "opencae-project-backups" }]);
    expect(defaultConfig.triggers?.crons).toEqual(["17 3 * * *"]);
    expect(readme).toContain("Deploy command: npx wrangler deploy");
    expect(readme).toContain("Do not use `npx wrangler versions upload` for the production Worker");
    expect(retiredDoCleanupConfig.migrations).toEqual([
      { tag: "v3-opencae-core-cloud-container", new_sqlite_classes: ["OpenCaeCoreCloudContainer"] },
      { tag: "v4-retire-opencae-core-cloud-container", deleted_classes: ["OpenCaeCoreCloudContainer"] }
    ]);
    expect(() => validateCloudflareConfigs({ defaultConfig, retiredDoCleanupConfig, staticConfig, packageJson })).not.toThrow();
  });

  test("Wrangler accepts isolated Preview bindings while production retains its resources", async () => {
    const { unstable_readConfig } = await import("wrangler");
    const normalized = unstable_readConfig({ config: resolve(rootDir, "wrangler.jsonc") });
    expect(normalized.previews).toMatchObject({
      vars: { GLIMPSE_BASIC_ENABLED: "false", GLIMPSE_USAGE_ENABLED: "false" },
      services: [], r2_buckets: [], ratelimits: []
    });
    expect(normalized.r2_buckets[0].bucket_name).toBe("opencae-project-backups");
    expect(normalized.previews.durable_objects).toEqual({ bindings: [] });
    expect(normalized.durable_objects.bindings).toEqual([{ name: "PROJECT_BACKUP_DAILY_QUOTA", class_name: "ProjectBackupDailyQuota" }]);
    expect(normalized.migrations.map((migration) => migration.tag)).toEqual(productionMigrations.map((migration) => migration.tag));
  });

  test.each(["services", "r2_buckets", "ratelimits"])("rejects production %s in a Preview", (binding) => {
    const configs = readCloudflareConfigs(rootDir);
    configs.defaultConfig.previews[binding] = structuredClone(configs.defaultConfig[binding]);
    expect(() => validateCloudflareConfigs(configs)).toThrow(/Preview must not bind production/);
  });

  test("rejects missing Preview settings or enabled preview analytics", () => {
    const configs = readCloudflareConfigs(rootDir);
    delete configs.defaultConfig.previews;
    expect(() => validateCloudflareConfigs(configs)).toThrow(/Preview settings/);
    configs.defaultConfig = clone(readConfig("wrangler.jsonc"));
    configs.defaultConfig.previews.vars.GLIMPSE_USAGE_ENABLED = "true";
    expect(() => validateCloudflareConfigs(configs)).toThrow(/analytics disabled/);
  });

  test("retired container and local-first wrangler variants stay deleted", () => {
    expect(existsSync(resolve(rootDir, "wrangler.containers.jsonc"))).toBe(false);
    expect(existsSync(resolve(rootDir, "wrangler.local-first.jsonc"))).toBe(false);
    expect(existsSync(resolve(rootDir, "services/opencae-core-cloud"))).toBe(false);
    expect(existsSync(resolve(rootDir, "services/openfea-core-cloud"))).toBe(false);
    expect(existsSync(resolve(rootDir, "scripts/verify-runner-version.mjs"))).toBe(false);
  });

  test("OpenFEA Core packages are in-repo and sibling bootstrap files stay deleted", () => {
    for (const packageDir of ["core", "examples", "solver-cpu", "solver-webgpu"]) {
      expect(existsSync(resolve(rootDir, "packages", packageDir, "package.json")), packageDir).toBe(true);
    }
    for (const retiredPath of [
      "OPENCAE_CORE_REF",
      "OPENFEA_CORE_REF",
      "scripts/ensure-opencae-core.mjs",
      "scripts/ensure-openfea-core.mjs",
      "scripts/verify-core-ref-reachable.mjs"
    ]) {
      expect(existsSync(resolve(rootDir, retiredPath)), retiredPath).toBe(false);
    }
    const workspace = readFileSync(resolve(rootDir, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toContain("../openfea-core");
    expect(workspace).not.toContain("../opencae-core");
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    expect(packageJson.scripts).not.toHaveProperty("ensure:core");
    expect(packageJson.scripts).not.toHaveProperty("verify:core-ref");
    expect(packageJson.scripts["build:core"]).not.toContain("install");
  });

  test("requires the append-only migration history ending in the backup quota class", () => {
    const { defaultConfig, retiredDoCleanupConfig } = readCloudflareConfigs(rootDir);

    expect(defaultConfig.migrations).toEqual(productionMigrations);
    expect(defaultConfig.migrations.slice(0, -1)).toEqual(retiredDoCleanupConfig.migrations);
    expect(defaultConfig.migrations.at(-1)).toEqual(backupQuotaMigration);
    expect(backupQuotaMigration).toEqual({ tag: "v5-project-backup-daily-quota", new_sqlite_classes: ["ProjectBackupDailyQuota"] });
  });

  test.each([
    ["missing", (migrations) => migrations.slice(0, -1)],
    ["no history at all", () => undefined],
    ["only the new tag", (migrations) => migrations.slice(-1)],
    ["a rewritten recorded tag", (migrations) => migrations.map((migration, index) => index === 0 ? { ...migration, tag: "v3-renamed" } : migration)],
    ["a reused tag for the quota class", (migrations) => [...migrations.slice(0, -1), { tag: "v4-retire-opencae-core-cloud-container", new_sqlite_classes: ["ProjectBackupDailyQuota"] }]],
    ["reordered tags", (migrations) => [migrations[1], migrations[0], migrations[2]]],
    ["an extra unreviewed tag", (migrations) => [...migrations, { tag: "v6-unexpected", deleted_classes: ["ProjectBackupDailyQuota"] }]],
    ["a non-SQLite quota class", (migrations) => [...migrations.slice(0, -1), { tag: "v5-project-backup-daily-quota", new_classes: ["ProjectBackupDailyQuota"] }]]
  ])("rejects a production migration list with %s", (_label, mutate) => {
    const configs = readCloudflareConfigs(rootDir);
    configs.defaultConfig.migrations = mutate(clone(configs.defaultConfig.migrations));
    expect(() => validateCloudflareConfigs(configs)).toThrow(/append-only; never rewrite a tag/);
  });

  test("requires the production backup quota Durable Object binding", () => {
    const configs = readCloudflareConfigs(rootDir);
    expect(configs.defaultConfig.durable_objects).toEqual({ bindings: [backupQuotaBinding] });
    delete configs.defaultConfig.durable_objects;
    expect(() => validateCloudflareConfigs(configs)).toThrow(/must bind only PROJECT_BACKUP_DAILY_QUOTA/);
  });

  test("rejects extra or renamed Durable Object bindings next to the quota ledger", () => {
    const configs = readCloudflareConfigs(rootDir);
    configs.defaultConfig.durable_objects.bindings.push({ name: "EXTRA", class_name: "ProjectBackupDailyQuota" });
    expect(() => validateCloudflareConfigs(configs)).toThrow(/must bind only PROJECT_BACKUP_DAILY_QUOTA/);
    configs.defaultConfig = clone(readConfig("wrangler.jsonc"));
    configs.defaultConfig.durable_objects.bindings[0].class_name = "SomethingElse";
    expect(() => validateCloudflareConfigs(configs)).toThrow(/must not bind Durable Objects other than the production backup quota ledger/);
  });

  test("Previews must not bind the quota ledger", () => {
    const configs = readCloudflareConfigs(rootDir);
    configs.defaultConfig.previews.durable_objects = clone(configs.defaultConfig.durable_objects);
    expect(() => validateCloudflareConfigs(configs)).toThrow(/Preview must not bind production durable_objects/);
    delete configs.defaultConfig.previews.durable_objects;
    expect(() => validateCloudflareConfigs(configs)).toThrow(/Preview must not bind production durable_objects/);
  });

  test.each([undefined, "", "0", "-1", "10GiB", "1e10", "99999999999999999999", 10737418240])(
    "rejects a missing or malformed daily cap var (%j)",
    (value) => {
      const configs = readCloudflareConfigs(rootDir);
      if (value === undefined) delete configs.defaultConfig.vars.PROJECT_BACKUP_DAILY_CAP_BYTES;
      else configs.defaultConfig.vars.PROJECT_BACKUP_DAILY_CAP_BYTES = value;
      expect(() => validateCloudflareConfigs(configs)).toThrow(/PROJECT_BACKUP_DAILY_CAP_BYTES must be a positive integer byte count/);
    }
  );

  test("defaults the production daily cap to 10 GiB", () => {
    const { defaultConfig } = readCloudflareConfigs(rootDir);
    expect(defaultConfig.vars.PROJECT_BACKUP_DAILY_CAP_BYTES).toBe(String(10 * 1024 ** 3));
  });

  test.each(["static", "retired DO cleanup"])("the %s config may not bind the quota ledger", (label) => {
    const configs = readCloudflareConfigs(rootDir);
    const key = label === "static" ? "staticConfig" : "retiredDoCleanupConfig";
    configs[key].durable_objects = { bindings: [clone(backupQuotaBinding)] };
    expect(() => validateCloudflareConfigs(configs)).toThrow(new RegExp(`${label} config must not bind Durable Objects`));
  });

  test("requires the retired Durable Object cleanup config to target production narrowly", () => {
    const { defaultConfig, staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const retiredDoCleanupConfig = clone(readConfig("wrangler.retired-do-cleanup.jsonc"));
    retiredDoCleanupConfig.migrations = [
      { tag: "v4-retire-opencae-core-cloud-container", deleted_classes: ["OpenCaeCoreCloudContainer"] },
      { tag: "v5-unexpected", deleted_classes: ["SomeOtherClass"] }
    ];

    expect(() => validateCloudflareConfigs({ defaultConfig, retiredDoCleanupConfig, staticConfig, packageJson })).toThrow(
      /recorded creation tag and the v4 delete-class migration/
    );
  });

  test("fails if a container binding sneaks back into the production config", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.containers = [{ name: "opencae-core-cloud-0.1.1", class_name: "OpenCaeCoreCloudContainer" }];

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /must not define containers/
    );
  });

  test("fails if a Durable Object binding sneaks back into the production config", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.durable_objects = { bindings: [{ name: "CORE_CLOUD_CONTAINER", class_name: "OpenCaeCoreCloudContainer" }] };

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /must not bind Durable Objects other than the production backup quota ledger/
    );
    // Even alongside the legitimate quota ledger.
    defaultConfig.durable_objects = { bindings: [
      { name: "PROJECT_BACKUP_DAILY_QUOTA", class_name: "ProjectBackupDailyQuota" },
      { name: "CORE_CLOUD_CONTAINER", class_name: "OpenCaeCoreCloudContainer" }
    ] };
    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /must not bind Durable Objects other than the production backup quota ledger/
    );
  });

  test("fails if an R2 artifact binding sneaks back into the production config", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.r2_buckets = [{ binding: "CORE_CLOUD_ARTIFACTS", bucket_name: "opencae-core-cloud-artifacts" }];

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /must bind only PROJECT_BACKUPS/
    );
  });

  test("fails if the scheduled backup retention cleanup is removed", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    delete defaultConfig.triggers;

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /must schedule the daily encrypted-backup retention cleanup/
    );
  });

  test("fails if retired container scripts return to package.json", () => {
    const { defaultConfig, staticConfig } = readCloudflareConfigs(rootDir);
    const packageJson = clone(JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")));
    packageJson.scripts["containers:build:core-cloud"] = "wrangler containers build services/openfea-core-cloud";

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /containers:build:core-cloud was retired/
    );
  });

  test("fails if the @cloudflare/containers dependency returns", () => {
    const { defaultConfig, staticConfig } = readCloudflareConfigs(rootDir);
    const packageJson = clone(JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")));
    packageJson.dependencies = { ...(packageJson.dependencies ?? {}), "@cloudflare/containers": "^0.3.3" };

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /@cloudflare\/containers must stay removed/
    );
  });

  test("fails when static and production configs share a Worker name", () => {
    const { defaultConfig, packageJson } = readCloudflareConfigs(rootDir);
    const staticConfig = clone(readConfig("wrangler.static.jsonc"));
    staticConfig.name = defaultConfig.name;

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /static config must not share the production Worker name/
    );
  });

  test.each(["fea.esau.app"])("fails when the production config loses %s", (productionDomain) => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.routes = defaultConfig.routes.filter((route) => route.pattern !== productionDomain);

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      new RegExp(`default config must route ${productionDomain.replaceAll(".", "\\.")} as a custom domain`)
    );
  });

  test("fails when the production config drops the SPA asset wiring", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.assets.run_worker_first = ["/health"];

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /run_worker_first must include/
    );
  });
});
