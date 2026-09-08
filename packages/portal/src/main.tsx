import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import {
  catalogSchema,
  type Catalog,
  type CatalogPackage,
  type SkillVersion,
} from "../../core/src/schema.ts";
import "./style.css";
import { siteSchema, type SiteConfig } from "../../core/src/site.ts";
let site: SiteConfig;

const labels = {
  bundled: "データ同梱",
  runtime: "実行時に取得",
  hybrid: "同梱＋実行時取得",
};
function latest(pkg: CatalogPackage) {
  return (
    pkg.versions[pkg.distTags.latest] ?? Object.values(pkg.versions).at(-1)
  );
}
function Copy({ value }: { value: string }) {
  const [message, setMessage] = useState("コピー");
  useEffect(() => setMessage("コピー"), [value]);
  return (
    <div className="command">
      <code>{value}</code>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setMessage("コピーしました");
          } catch {
            setMessage("選択してコピーしてください");
          }
        }}
        aria-live="polite"
      >
        {message}
      </button>
    </div>
  );
}
function Detail({ pkg }: { pkg: CatalogPackage }) {
  const [selector, setSelector] = useState(
    pkg.distTags.latest ? "latest" : (Object.keys(pkg.versions).at(-1) ?? ""),
  );
  const [agent, setAgent] = useState("codex");
  const version: SkillVersion | undefined =
    pkg.versions[pkg.distTags[selector] ?? selector];
  if (!version) return <p>配布可能なバージョンがありません。</p>;
  const compatible = version.metadata.compatibleAgents;
  const target =
    agent === "all" && compatible.length > 1
      ? "all"
      : compatible.includes(agent as "codex" | "claude")
        ? agent
        : compatible[0];
  const disabled = pkg.withdrawn || version.withdrawn;
  const markdown = version.markdown.replace(
    /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    "",
  );
  return (
    <section className="detail" aria-label="skill 詳細">
      <a className="back" href="#">
        ← ライブラリに戻る
      </a>
      <div className="eyebrow">SKILL / {labels[version.metadata.dataMode]}</div>
      <h1>{version.skillName}</h1>
      <p className="package-name">{pkg.name}</p>
      <p className="lead">{version.description}</p>
      <div className="detail-grid">
        <article className="markdown">
          <Markdown skipHtml>{markdown}</Markdown>
        </article>
        <aside>
          <div className="install-box">
            <h2>エージェントに追加</h2>
            <label>
              バージョン
              <select
                value={selector}
                onChange={(e) => setSelector(e.target.value)}
              >
                {Object.entries(pkg.distTags).map(([tag, v]) => (
                  <option key={`tag-${tag}`} value={tag}>
                    {tag} · {v}
                  </option>
                ))}
                {Object.keys(pkg.versions)
                  .reverse()
                  .map((v) => (
                    <option key={v} value={v}>
                      {v}（固定）
                    </option>
                  ))}
              </select>
            </label>
            <label>
              エージェント
              <select value={target} onChange={(e) => setAgent(e.target.value)}>
                {compatible.map((a) => (
                  <option key={a} value={a}>
                    {a === "codex" ? "Codex" : "Claude Code"}
                  </option>
                ))}
                {compatible.length > 1 && <option value="all">両方</option>}
              </select>
            </label>
            {disabled ? (
              <p role="status">このパッケージ／バージョンは配布停止中です。</p>
            ) : (
              <Copy
                value={`sv-skills install ${pkg.name}@${selector} --agent ${agent === "all" && compatible.length > 1 ? "all" : target}`}
              />
            )}
            <a href="#guide">CLI の導入手順 ↗</a>
          </div>
          <div className="requirements">
            <h2>利用前に</h2>
            <p>{labels[version.metadata.dataMode]}</p>
            {version.metadata.snapshot && (
              <p>同梱データ: {version.metadata.snapshot}</p>
            )}
            {version.metadata.requirements.environment.map((env) => (
              <p key={env.name}>
                <code>{env.name}</code>
                <br />
                {env.description}
              </p>
            ))}
            {version.metadata.requirements.commands.length > 0 && (
              <p>
                必要なコマンド:{" "}
                {version.metadata.requirements.commands.join(", ")}
              </p>
            )}
            {version.metadata.requirements.endpoints.map((url) => (
              <p key={url}>
                <a href={url} rel="noreferrer" target="_blank">
                  {url}
                </a>
              </p>
            ))}
            <p>認証情報は利用する環境で設定してください。</p>
            <a href={pkg.repository} target="_blank" rel="noreferrer">
              ソースリポジトリ ↗
            </a>
            <p className="muted">
              公開: {new Date(version.publishedAt).toLocaleDateString("ja-JP")}
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
function Guide() {
  return (
    <section className="guide">
      <a className="back" href="#">
        ← ライブラリに戻る
      </a>
      <h1>エージェントに skill を追加する</h1>
      <div className="guide-step">
        <span>01</span>
        <div>
          <h2>CLI をインストール</h2>
          <p>{site.registryHelp}</p>
          <Copy value={site.installCommand} />
        </div>
      </div>
      <div className="guide-step">
        <span>02</span>
        <div>
          <h2>ポータルを設定</h2>
          <Copy value={"sv-skills config set portal " + site.portalUrl} />
          <p>接続先はユーザー設定に保存されます。</p>
        </div>
      </div>
      <div className="guide-step">
        <span>03</span>
        <div>
          <h2>skill を探して追加</h2>
          <Copy value="sv-skills search" />
          <p>詳細画面のコマンドをコピーし、--agent で配置先を選びます。</p>
          <Copy value="sv-skills update --all" />
        </div>
      </div>
      <div className="guide-step">
        <span>04</span>
        <div>
          <h2>skill を公開</h2>
          <p>
            npm パッケージを公開し、ポータルの依存と lockfile
            に登録します。新しい版は更新 PR のマージ後に掲載されます。
          </p>
          <a href={site.docsUrl}>公開手順 ↗</a>
        </div>
      </div>
    </section>
  );
}
function App() {
  const searchRef = useRef<HTMLInputElement>(null);
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [repository, setRepository] = useState("all");
  const [tag, setTag] = useState("all");
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        searchRef.current
      ) {
        event.preventDefault();
        searchRef.current.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    const handler = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    fetch("/catalog.json", { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error("カタログを取得できません");
        return r.json();
      })
      .then((data) => setCatalog(catalogSchema.parse(data)))
      .catch(() =>
        setError(
          "カタログを読み込めませんでした。接続先を確認して再読み込みしてください。",
        ),
      );
  }, []);
  const active = catalog?.packages.filter((p) => !p.withdrawn) ?? [];
  const results = active.filter((p) => {
    const v = latest(p);
    return (
      v &&
      !v.withdrawn &&
      (filter === "all" ||
        v.metadata.compatibleAgents.includes(filter as "codex" | "claude")) &&
      (repository === "all" || p.repository === repository) &&
      (tag === "all" || p.keywords.includes(tag)) &&
      `${p.name} ${v.description} ${p.keywords.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  });
  let selected: CatalogPackage | undefined;
  try {
    if (hash.startsWith("#skill/"))
      selected = catalog?.packages.find(
        (p) => p.name === decodeURIComponent(hash.slice(7)),
      );
  } catch {
    /* Show not found for malformed links. */
  }
  return (
    <>
      <header>
        <a href="#" className="brand">
          <span className="brand-mark">s/</span> {site.title}{" "}
          <span className="brand-label">{site.networkLabel}</span>
        </a>
        <nav>
          <a href="#">ライブラリ</a>
          <a href="#guide">
            使い方 <span>↗</span>
          </a>
          <span className="network">
            <i /> {site.networkLabel}
          </span>
        </nav>
      </header>
      <main>
        {hash === "#guide" ? (
          <Guide />
        ) : selected ? (
          <Detail key={selected.name} pkg={selected} />
        ) : hash.startsWith("#skill/") && catalog ? (
          <section className="empty">
            <h1>skill が見つかりません</h1>
            <a href="#">ライブラリへ戻る</a>
          </section>
        ) : (
          <>
            <section className="hero">
              <div>
                <div className="eyebrow">
                  <span /> SHARED KNOWLEDGE, READY TO USE
                </div>
                <h1>
                  知識と道具を、
                  <br />
                  あなたの<span className="accent">エージェント</span>に。
                </h1>
                <p>
                  {site.description}
                  <br />
                  リポジトリを clone せず、必要なものだけ手元へ。
                </p>
                <a className="primary-link" href="#guide">
                  CLI をセットアップ <span>↗</span>
                </a>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="art-center">
                  s<span>kill</span>
                  <small>KNOWLEDGE PACKAGE</small>
                </div>
                <span className="art-chip chip-one">SKILL.md</span>
                <span className="art-chip chip-two">references/</span>
                <span className="art-chip chip-three">npm publish ↗</span>
                <span className="art-dot" />
              </div>
            </section>
            <section className="library">
              <div className="section-heading">
                <h2>
                  ライブラリ{" "}
                  <span>{active.length.toString().padStart(2, "0")}</span>
                </h2>
                <p>見つける。追加する。すぐに使う。</p>
              </div>
              <div className="filters">
                <label className="search">
                  <span>⌕</span>
                  <input
                    ref={searchRef}
                    aria-label="skill を検索"
                    placeholder="名前、キーワード、用途で検索…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <kbd>/</kbd>
                </label>
                <select
                  aria-label="エージェントで絞り込み"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">すべてのエージェント</option>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude Code</option>
                </select>
                <select
                  aria-label="配布元で絞り込み"
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                >
                  <option value="all">すべての配布元</option>
                  {[...new Set(active.map((p) => p.repository))].map((repo) => (
                    <option key={repo} value={repo}>
                      {repo.split("/").at(-1)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="タグで絞り込み"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                >
                  <option value="all">すべてのタグ</option>
                  {[...new Set(active.flatMap((p) => p.keywords))]
                    .sort()
                    .map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                </select>
              </div>
              {error ? (
                <div className="empty" role="alert">
                  <h3>接続を確認してください</h3>
                  <p>{error}</p>
                  <button onClick={() => location.reload()}>再読み込み</button>
                </div>
              ) : !catalog ? (
                <div className="empty" role="status">
                  カタログを読み込んでいます…
                </div>
              ) : results.length ? (
                <div className="cards">
                  {results.map((pkg) => {
                    const v = latest(pkg)!;
                    return (
                      <a
                        className="card"
                        key={pkg.name}
                        href={`#skill/${encodeURIComponent(pkg.name)}`}
                      >
                        <div className="card-top">
                          <span className="skill-icon">↗</span>
                          <span className="version">v{v.version}</span>
                        </div>
                        <div className="card-title">{v.skillName}</div>
                        <div className="package-name">{pkg.name}</div>
                        <p>{v.description}</p>
                        <div className="badges">
                          {v.metadata.compatibleAgents.map((a) => (
                            <span key={a}>
                              {a === "codex" ? "Codex" : "Claude Code"}
                            </span>
                          ))}
                          <span>{labels[v.metadata.dataMode]}</span>
                        </div>
                      </a>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">
                  <div className="empty-icon">＋</div>
                  <h3>
                    {active.length
                      ? "条件に合う skill がありません"
                      : "最初の skill を迎える準備ができました"}
                  </h3>
                  <p>
                    {active.length
                      ? "キーワードや絞り込み条件を変えてみてください。"
                      : "npm パッケージを登録すると、公開された skills がここに並びます。"}
                  </p>
                  <a
                    href={active.length ? "#" : "#guide"}
                    onClick={
                      active.length
                        ? () => {
                            setQuery("");
                            setFilter("all");
                            setRepository("all");
                            setTag("all");
                          }
                        : undefined
                    }
                  >
                    {active.length
                      ? "絞り込みをリセット →"
                      : "公開の流れを見る →"}
                  </a>
                </div>
              )}
            </section>
            <section className="flow">
              <div>
                <span>01 / DISCOVER</span>
                <h3>必要な skill を探す</h3>
                <p>用途やエージェントで絞り込み。</p>
              </div>
              <div>
                <span>02 / INSTALL</span>
                <h3>コマンドひとつで追加</h3>
                <p>元リポジトリの clone は不要。</p>
              </div>
              <div>
                <span>03 / KEEP CURRENT</span>
                <h3>自分のタイミングで更新</h3>
                <p>バージョン固定も、過去版への変更も。</p>
              </div>
            </section>
          </>
        )}
      </main>
      <footer>
        <span>
          <b>{site.title}</b>
        </span>
        <span>{site.footer}</span>
      </footer>
    </>
  );
}
fetch("/site-config.json", { cache: "no-cache" })
  .then((r) => {
    if (!r.ok) throw new Error("Site configuration unavailable");
    return r.json();
  })
  .then((data) => {
    site = siteSchema.parse(data);
    document.title = site.title;
    createRoot(document.getElementById("root")!).render(<App />);
  })
  .catch(() => {
    document.getElementById("root")!.textContent =
      "サイト設定を取得できません。接続先を確認してください。";
  });
