import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { checkedUrl } from "../../core/src/index.ts";

export function configPath(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  return join(
    platform === "win32"
      ? env.APPDATA || join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || join(home, ".config"),
    "agent-skills",
    "config.json",
  );
}
export function loadPortal(
  explicit?: string,
  env = process.env,
  file = configPath(env),
): string {
  let value = explicit || env.SV_SKILLS_PORTAL;
  if (!value) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (typeof data.portal === "string") value = data.portal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`CLI 設定を読み込めません: ${file}`);
    }
  }
  if (!value)
    throw new Error(
      "接続先が未設定です: sv-skills config set portal https://your-portal.example/",
    );
  return checkedUrl(value.endsWith("/") ? value : value + "/").href;
}
export function savePortal(value?: string, file = configPath()) {
  const data =
    value === undefined ? {} : { portal: loadPortal(value, {}, file) };
  mkdirSync(dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
