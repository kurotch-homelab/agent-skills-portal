import { z } from "zod";
const url = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
    );
  }, "HTTP(S) URL without credentials required");
export const siteSchema = z
  .object({
    title: z.string().min(1).default("Skill Library"),
    description: z
      .string()
      .default("プロジェクトで育った skills を、必要なものだけ手元へ。"),
    networkLabel: z.string().default("Agent Skills"),
    portalUrl: url,
    registryUrl: url,
    installCommand: z
      .string()
      .min(1)
      .default("npm install -g @kurotch-homelab/agent-skills-cli"),
    registryHelp: z
      .string()
      .default(
        "CLI の配布元 registry に従って npm の取得先と認証を設定してください。",
      ),
    docsUrl: url.default(
      "https://github.com/kurotch-homelab/agent-skills-portal",
    ),
    footer: z.string().default("Powered by Agent Skills Portal"),
  })
  .strict();
export type SiteConfig = z.infer<typeof siteSchema>;
