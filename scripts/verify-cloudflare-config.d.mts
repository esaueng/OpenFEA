export function parseJsonc(source: string, label?: string): unknown;
export const backupQuotaBinding: { name: string; class_name: string };
export const backupQuotaMigration: { tag: string; new_sqlite_classes: string[] };
export const productionMigrations: Array<{ tag: string; new_sqlite_classes?: string[]; deleted_classes?: string[] }>;
export function readCloudflareConfigs(baseDir?: string): {
  defaultConfig: unknown;
  retiredDoCleanupConfig: unknown;
  staticConfig: unknown;
  packageJson: unknown;
};
export function validateCloudflareConfigs(configs: {
  defaultConfig?: unknown;
  retiredDoCleanupConfig?: unknown;
  staticConfig?: unknown;
  packageJson?: unknown;
}): void;
