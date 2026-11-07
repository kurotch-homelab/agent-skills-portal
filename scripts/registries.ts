import { z } from "zod";
import { checkedUrl, packageName } from "../packages/core/src/index.ts";

export type PackageRegistries = Record<
  string,
  { registry: string; token?: string }
>;
const registryConfig = z
  .object({
    packages: z.record(
      packageName,
      z
        .object({
          registry: z.string(),
          tokenEnv: z
            .string()
            .regex(/^[A-Z_][A-Z0-9_]*$/)
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

/** Credentials remain in memory and are never included in the public site config. */
export function loadPackageRegistries(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): PackageRegistries {
  return Object.fromEntries(
    Object.entries(registryConfig.parse(input).packages).map(
      ([name, source]) => {
        const url = checkedUrl(source.registry);
        if (url.search)
          throw new Error("Registry URL must not contain a query");
        if (!url.pathname.endsWith("/")) url.pathname += "/";
        const token = source.tokenEnv ? env[source.tokenEnv] : undefined;
        if (source.tokenEnv && !token)
          throw new Error(
            `Missing registry credential environment variable: ${source.tokenEnv}`,
          );
        return [name, { registry: url.href, token }];
      },
    ),
  );
}
