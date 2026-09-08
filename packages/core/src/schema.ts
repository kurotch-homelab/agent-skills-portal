import { z } from "zod";

export const packageName = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
export const skillName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
// Tags are used in copied shell commands: accept a shell-safe subset of npm tag names.
export const distTag = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]*$/);
export const agent = z.enum(["codex", "claude"]);
export type Agent = z.infer<typeof agent>;
export const metadataSchema = z.object({
  compatibleAgents: z.array(agent).min(1),
  dataMode: z.enum(["bundled", "runtime", "hybrid"]),
  requirements: z
    .object({
      environment: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
            description: z.string(),
          }),
        )
        .default([]),
      commands: z.array(z.string()).default([]),
      endpoints: z.array(z.string().url()).default([]),
    })
    .default({ environment: [], commands: [], endpoints: [] }),
  snapshot: z.string().optional(),
});
export const relativeArtifact = z
  .string()
  .regex(/^artifacts\/[a-f0-9]{64}\.tgz$/);
export const versionSchema = z.object({
  version: z.string(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  artifact: relativeArtifact,
  skillName,
  description: z.string(),
  markdown: z.string(),
  metadata: metadataSchema,
  publishedAt: z.string(),
  withdrawn: z.boolean().default(false),
});
export const catalogPackageSchema = z.object({
  name: packageName,
  repository: z.string().url(),
  keywords: z.array(z.string()),
  distTags: z.record(distTag, z.string()),
  versions: z.record(z.string(), versionSchema),
  withdrawn: z.boolean().default(false),
});
export const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  packages: z.array(catalogPackageSchema),
});
export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogPackage = z.infer<typeof catalogPackageSchema>;
export type SkillVersion = z.infer<typeof versionSchema>;
export const emptyCatalog = (): Catalog => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  packages: [],
});
