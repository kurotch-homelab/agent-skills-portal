import { Command } from "commander";
import { Client, targetRoot } from "./client.ts";
import { Store } from "./store.ts";
import {
  agent as agentSchema,
  packageName,
  resolveVersion,
  type Agent,
} from "../../core/src/index.ts";
import manifest from "../package.json";
import { loadPortal, savePortal } from "./config.ts";

const program = new Command()
  .name("sv-skills")
  .description("Agent Skills を管理します")
  .version(manifest.version)
  .option("--portal <url>", "配布ポータル URL")
  .option("--agent <agent>", "codex / claude / all")
  .option(
    "--project <path>",
    "プロジェクト単位の配置先（省略時はユーザー単位）",
  )
  .option("--json", "JSON 形式で出力");
function client() {
  return new Client(loadPortal(program.opts().portal));
}
function agents(required = false): Agent[] {
  const value = program.opts().agent;
  if (required && !value)
    throw new Error("install には --agent codex / claude / all が必要です");
  return !value || value === "all"
    ? ["codex", "claude"]
    : [agentSchema.parse(value)];
}
function stores(required = false) {
  return agents(required).map((agent) => ({
    agent,
    store: new Store(targetRoot(agent, program.opts().project)),
  }));
}
function output(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

program
  .command("search [query]")
  .description("公開 skill を検索")
  .action(async (query = "") => {
    const catalog = await client().catalog();
    const results = catalog.packages
      .filter(
        (p) =>
          !p.withdrawn &&
          `${p.name} ${p.keywords.join(" ")} ${Object.values(p.versions)
            .map((v) => v.description)
            .join(" ")}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
      .map((p) => ({
        name: p.name,
        tags: p.distTags,
        description: p.versions[p.distTags.latest]?.description ?? "",
      }));
    if (program.opts().json) output(results);
    else
      for (const item of results)
        console.log(
          `${item.name}\n  ${item.description}\n  ${JSON.stringify(item.tags)}`,
        );
  });
program
  .command("info <name>")
  .description("バージョン・必要な設定を表示")
  .action(async (name) => {
    packageName.parse(name);
    const pkg = (await client().catalog()).packages.find(
      (p) => p.name === name,
    );
    if (!pkg) throw new Error("パッケージが見つかりません");
    output(pkg);
  });
program
  .command("install <spec>")
  .description("skill を導入（正確なバージョン指定で固定）")
  .action(async (spec) => {
    const targets = stores(true);
    const api = client();
    const catalog = await api.catalog();
    for (const { agent, store } of targets) {
      const record = await api.install(spec, agent, store, catalog);
      if (program.opts().json) output(record);
      else
        console.log(
          `${agent}: ${record.name}@${record.version} を導入しました${record.pinned ? "（固定）" : ""}`,
        );
    }
  });
program
  .command("list")
  .description("導入済み skill を表示")
  .action(async () => {
    const results = [];
    for (const { agent, store } of stores())
      results.push(
        ...(await store.state()).installed.map((r) => ({
          agent,
          name: r.name,
          version: r.version,
          selector: r.selector,
          pinned: r.pinned,
          directory: store.root,
        })),
      );
    output(results);
  });
program
  .command("outdated")
  .description("更新候補を表示")
  .action(async () => {
    const api = client();
    const catalog = await api.catalog();
    const results = [];
    for (const { agent, store } of stores())
      for (const r of (await store.state()).installed) {
        let latest: string | undefined;
        let error: string | undefined;
        try {
          if (r.portal !== api.portal.href)
            throw new Error("配布元が異なります");
          const pkg = catalog.packages.find((p) => p.name === r.name);
          if (!pkg) throw new Error("配布されていません");
          latest = resolveVersion(pkg, r.selector).version;
        } catch (e) {
          error = (e as Error).message;
        }
        if (latest !== r.version || error)
          results.push({
            agent,
            name: r.name,
            installed: r.version,
            available: latest,
            pinned: r.pinned,
            error,
          });
      }
    output(results);
  });
program
  .command("update [name]")
  .description("追跡タグに更新")
  .option("--all", "全 skill を更新")
  .action(async (name, options) => {
    if ((!name && !options.all) || (name && options.all))
      throw new Error("パッケージ名または --all の一方を指定してください");
    if (name) packageName.parse(name);
    let count = 0;
    const api = client();
    const catalog = await api.catalog();
    for (const { agent, store } of stores())
      for (const record of (await store.state()).installed.filter(
        (r) => !name || r.name === name,
      )) {
        const result = await api.update(record.name, store, catalog);
        count++;
        if (program.opts().json) output(result);
        else
          console.log(
            `${agent}: ${result.name}@${result.version}${result.skipped ? "（変更なし／固定）" : " に更新しました"}`,
          );
      }
    if (name && !count) throw new Error("インストールされていません");
  });
for (const command of ["pin", "unpin", "uninstall"] as const)
  program
    .command(`${command} <name>`)
    .description(
      {
        pin: "現在の版を固定",
        unpin: "固定を解除",
        uninstall: "管理対象 skill を削除",
      }[command],
    )
    .action(async (name) => {
      packageName.parse(name);
      let count = 0;
      for (const { agent, store } of stores()) {
        if (!(await store.state()).installed.some((r) => r.name === name))
          continue;
        await store.locked(async () => {
          const record = (await store.state()).installed.find(
            (r) => r.name === name,
          )!;
          if (!record) throw new Error("管理状態が変更されました");
          if (command === "uninstall") await store.replace(record, null);
          else await store.pin(name, command === "pin");
        });
        count++;
        console.log(`${agent}: ${command} ${name}`);
      }
      if (!count) throw new Error("インストールされていません");
    });
const config = program.command("config").description("CLI の接続先設定");
config.command("set <key> <value>").action((key, value) => {
  if (key !== "portal") throw new Error("設定項目は portal です");
  savePortal(value);
});
config.command("get <key>").action((key) => {
  if (key !== "portal") throw new Error("設定項目は portal です");
  console.log(loadPortal());
});
config.command("unset <key>").action((key) => {
  if (key !== "portal") throw new Error("設定項目は portal です");
  savePortal(undefined);
});
program.parseAsync().catch((error) => {
  console.error(`エラー: ${error.message}`);
  process.exitCode = 1;
});
