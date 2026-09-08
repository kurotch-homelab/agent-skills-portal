# skill を npm パッケージとして公開する

## パッケージ規約

1 npm パッケージにつき 1 skill。モノレポから複数パッケージの公開も可能です。

パッケージ名は原則として `@kurotch-homelab/` スコープを使います。このガイドの `@kurotch-homelab/example` は例示名なので、公開する skill の名前へ置き換えてください。

```text
skill-package/
  package.json
  SKILL.md
  references/
  scripts/
  assets/
```

```json
{
  "name": "@kurotch-homelab/example",
  "version": "1.0.0",
  "description": "内部のドキュメントを参照する",
  "repository": {
    "type": "git",
    "url": "https://github.com/kurotch-homelab/source.git"
  },
  "keywords": ["docs"],
  "files": ["SKILL.md", "references", "scripts", "assets"],
  "publishConfig": { "registry": "https://registry.example.test/" },
  "agentSkill": {
    "compatibleAgents": ["codex", "claude"],
    "dataMode": "hybrid",
    "snapshot": "2026-09-07",
    "requirements": {
      "environment": [
        {
          "name": "SERVICE_TOKEN",
          "description": "利用者自身の読み取りトークン"
        }
      ],
      "commands": ["python"],
      "endpoints": ["https://service.example.test/"]
    }
  }
}
```

```markdown
---
name: kurotch-example
description: 内部資料の内容や運用手順を尋ねられたときに使う。
---

同梱の references/ を参照する。実行時の最新情報が必要なら scripts/ の手順に従い、利用者の認証で取得する。
```

`name` は小文字英数字と単一ハイフン、64 文字以内。配置ディレクトリ名になるので、チーム名を含めて重複を避けてください。npm の scope/name とは別です。名前が同じ skill を同じエージェントに同居させることはできません。

`dataMode` は `bundled` / `runtime` / `hybrid`。必要な認証の**名前と説明**だけを書き、値は含めません。runtime 型の取得や認証処理は各 skill が担当します。別リポジトリのローカルパスに依存せず、同梱データは skill からの相対パスで参照してください。

必要なコードは公開前にバンドルしてください。skill の dependencies / optionalDependencies / peerDependencies は非空を拒否します。CLI は install/postinstall などを実行しません。配布ファイル内のシンボリックリンク、特殊ファイル、`.env`、`.npmrc`、秘密鍵、`.git`、`node_modules` も拒否します。圧縮 32 MiB、展開 128 MiB、4,096 エントリ、SKILL.md 256 KiB が上限です。バイナリや巨大データの配布には使わず、runtime 型を選んでください。

## 検証と公開

```sh
npm pack --ignore-scripts
agent-skills-portal validate ./kurotch-homelab-example-1.0.0.tgz
npm publish --ignore-scripts
```

公開先 registry の認証・CI 公開手順に従ってください。公開後はポータルの catalog/package.json に依存を追加し、npm で生成した lockfile と一緒にレビューします。詳細は [運用ガイド](../packages/portal/README.md) を参照してください。
