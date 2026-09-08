import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  open,
} from "node:fs/promises";
import { resolve, join, dirname, parse } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import {
  safePath,
  sha256,
  skillName,
  packageName,
  agent,
} from "../../core/src/index.ts";

const recordSchema = z.object({
  name: packageName,
  version: z.string(),
  selector: z.string(),
  pinned: z.boolean(),
  slug: skillName,
  agent,
  portal: z.string().url(),
  hashes: z.record(z.string(), z.string()),
  integrity: z.string(),
});
export type Installed = z.infer<typeof recordSchema>;
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  transaction: z.string().optional(),
  installed: z.array(recordSchema),
});
type State = z.infer<typeof stateSchema>;
const journalSchema = z.object({
  id: z.string().uuid(),
  slug: skillName,
  hadPrevious: z.boolean(),
});

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function assertNoLinks(path: string) {
  let current = resolve(path);
  while (current !== parse(current).root) {
    if (await exists(current)) {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`リンク先への書き込みはできません: ${current}`);
    }
    current = dirname(current);
  }
}
async function atomicJson(path: string, data: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

export class Store {
  readonly root: string;
  readonly meta: string;
  constructor(root: string) {
    this.root = resolve(root);
    this.meta = join(this.root, ".sv-skills");
  }
  async state(): Promise<State> {
    await assertNoLinks(this.meta);
    const path = join(this.meta, "state.json");
    await assertNoLinks(path);
    if (!(await exists(path))) return { schemaVersion: 1, installed: [] };
    const state = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    for (const record of state.installed)
      for (const path of Object.keys(record.hashes)) safePath(path);
    if (
      new Set(state.installed.map((r) => r.name)).size !==
        state.installed.length ||
      new Set(state.installed.map((r) => r.slug.toLowerCase())).size !==
        state.installed.length
    )
      throw new Error("管理台帳が重複しています");
    return state;
  }
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    await assertNoLinks(this.meta);
    await mkdir(this.meta, { recursive: true });
    const lock = join(this.meta, "lock");
    // A dead local process can leave a recoverable journal. Live or foreign locks stay closed.
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, host: hostname() }),
      );
      await handle.close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await assertNoLinks(lock);
      const owner = JSON.parse(await readFile(lock, "utf8"));
      if (
        owner.host !== hostname() ||
        !Number.isInteger(owner.pid) ||
        owner.pid < 1
      )
        throw new Error("別の操作がロックを保持しています");
      try {
        process.kill(owner.pid, 0);
        throw new Error("別の sv-skills が操作中です");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      // Do not race to remove stale locks; an operator explicitly recovers the dead lock.
      throw new Error(
        `前回のプロセスが終了しています。実行中の CLI がないことを確認し ${lock} を削除して再実行してください`,
      );
    }
    try {
      await this.recover();
      return await fn();
    } finally {
      await rm(lock);
    }
  }
  async recover() {
    const path = join(this.meta, "transaction.json");
    await assertNoLinks(path);
    if (!(await exists(path))) return;
    const journal = journalSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    const directory = join(this.meta, journal.id);
    const destination = join(this.root, journal.slug);
    const backup = join(directory, "backup");
    const stage = join(directory, "stage");
    for (const p of [directory, destination, backup, stage])
      await assertNoLinks(p);
    if ((await this.state()).transaction !== journal.id) {
      if (await exists(backup)) {
        await rm(destination, { recursive: true, force: true });
        await rename(backup, destination);
      } else if (!journal.hadPrevious && !(await exists(stage)))
        await rm(destination, { recursive: true, force: true });
    }
    await rm(directory, { recursive: true, force: true });
    await rm(path);
  }
  async hashes(slug: string): Promise<Record<string, string>> {
    skillName.parse(slug);
    const base = join(this.root, slug);
    await assertNoLinks(base);
    const hashes: Record<string, string> = Object.create(null);
    async function walk(dir: string, prefix: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = safePath(prefix + entry.name);
        if (entry.isSymbolicLink())
          throw new Error("管理対象にリンクが追加されています");
        if (entry.isDirectory())
          await walk(join(dir, entry.name), `${relative}/`);
        else if (entry.isFile())
          hashes[relative] = sha256(await readFile(join(dir, entry.name)));
        else throw new Error("管理対象に特殊ファイルがあります");
      }
    }
    await walk(base, "");
    return hashes;
  }
  async assertUnmodified(record: Installed) {
    const actual = await this.hashes(record.slug);
    if (
      Object.keys(actual).length !== Object.keys(record.hashes).length ||
      Object.entries(actual).some(([p, h]) => record.hashes[p] !== h)
    )
      throw new Error(
        `${record.name}: 手動変更を検出しました。変更を退避して元に戻してください`,
      );
  }
  async replace(record: Installed, files: Map<string, Buffer> | null) {
    const state = await this.state();
    const old = state.installed.find((r) => r.name === record.name);
    if (old && old.slug !== record.slug)
      throw new Error(
        "skill name の変更はアンインストール後に導入してください",
      );
    const destination = join(this.root, skillName.parse(record.slug));
    await assertNoLinks(destination);
    if (old) await this.assertUnmodified(old);
    else if (await exists(destination))
      throw new Error(`${record.slug}: 同名の既存 skill があります`);
    const id = randomUUID();
    const directory = join(this.meta, id);
    const stage = join(directory, "stage");
    await mkdir(stage, { recursive: true });
    try {
      if (files)
        for (const [path, bytes] of files) {
          const full = join(stage, safePath(path));
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, bytes, {
            flag: "wx",
            mode: /\.(sh|py)$/.test(path) ? 0o700 : 0o600,
          });
        }
      await atomicJson(join(this.meta, "transaction.json"), {
        id,
        slug: record.slug,
        hadPrevious: !!old,
      });
      if (old) await rename(destination, join(directory, "backup"));
      if (files) await rename(stage, destination);
      await atomicJson(join(this.meta, "state.json"), {
        schemaVersion: 1,
        transaction: id,
        installed: [
          ...state.installed.filter((r) => r.name !== record.name),
          ...(files ? [record] : []),
        ],
      });
      await this.recover();
    } catch (error) {
      await this.recover();
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async pin(name: string, pinned: boolean) {
    const state = await this.state();
    const record = state.installed.find((r) => r.name === name);
    if (!record) throw new Error(`${name} はインストールされていません`);
    record.pinned = pinned;
    if (!pinned && /^\d+\./.test(record.selector)) record.selector = "latest";
    await atomicJson(join(this.meta, "state.json"), state);
  }
}
