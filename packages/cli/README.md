# Agent Skills CLI

Install, update and uninstall skills from an Agent Skills Portal on Windows, macOS and Linux. Requires Node.js 24 or later. The executable is sv-skills.

## Installation

Configure your npm scope for GitHub Packages (or an authenticated mirror). GitHub Packages requires authentication even for public packages. Use a personal access token (classic) with read:packages; keep the token in your user configuration, never in a repository.

```ini
@kurotch-homelab:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=TOKEN
```

```sh
npm install -g @kurotch-homelab/agent-skills-cli
sv-skills config set portal https://skills.example.test/
sv-skills search
```

Portal selection: --portal, then SV_SKILLS_PORTAL, then saved configuration. No default portal is bundled. Configuration lives in %APPDATA%/agent-skills/config.json on Windows and $XDG_CONFIG_HOME/agent-skills/config.json (default ~/.config) elsewhere.

```sh
sv-skills config get portal
sv-skills config unset portal
npm install -g @kurotch-homelab/agent-skills-cli@latest
npm uninstall -g @kurotch-homelab/agent-skills-cli
```

Uninstalling the CLI leaves installed skills intact. Local list and uninstall operations do not require a portal.

## skill 操作

```sh
sv-skills search keyword
sv-skills info @kurotch-homelab/example
sv-skills install @kurotch-homelab/example --agent codex
sv-skills install @kurotch-homelab/example@2.0.0-beta.1 --agent claude
sv-skills install @kurotch-homelab/example@1.2.3 --agent all
sv-skills install @kurotch-homelab/example --agent codex --project ./project
sv-skills list
sv-skills outdated
sv-skills update @kurotch-homelab/example
sv-skills update --all
sv-skills pin @kurotch-homelab/example
sv-skills unpin @kurotch-homelab/example
sv-skills uninstall @kurotch-homelab/example
```

- `install` の `--agent` は必須。他の操作は指定がなければ両エージェントの管理台帳を対象にします。
- ユーザー単位の配置先は Codex が `~/.agents/skills`、Claude Code が `~/.claude/skills`。`--project` 指定時はその配下です。
- バージョン省略は `latest`、タグ指定はそのタグを追跡。正確な SemVer は固定扱いになります。SemVer 範囲は v1 では扱いません。
- 更新は明示的な操作だけです。タグが過去版を指す場合、`update` もその版に移動します。`unpin` は正確な版指定を `latest` 追跡へ戻します。
- 過去版を `install ...@1.0.0` と指定すれば戻せます。現在の内容が手動変更されていれば停止します。
- `--portal` または `SV_SKILLS_PORTAL` で別ポータルを指定できます。配布元の無断変更は拒否します。
- `search` / `info` / `list` / `outdated` などで `--json` を利用できます。複数ターゲットの変更結果は順に出力します。
- 環境変数などの認証情報は各 skill の説明に沿って利用者側で用意します。CLI は値を収集・保存しません。

## 競合・復旧

同名の既存 skill、手動編集、追加ファイル、リンク、台帳の不整合は停止理由になります。`--force` は用意していません。変更を別の場所へ退避し、導入時の内容へ戻してから再実行します。

配置先の `.sv-skills/` に管理台帳とトランザクション記録を置きます。更新は一時展開後に置き換え、台帳の commit 前の失敗は旧版へ戻します。次の変更操作でも未完了トランザクションを復旧します。複数エージェントの操作はターゲットごとに確定するため、片方が失敗した場合は成功済みターゲットを表示してから終了します。

異常終了で lock が残った場合は、表示された PID が終了していることと他の CLI が動いていないことを確認してから、表示された `.sv-skills/lock` だけを削除し再実行します。台帳や transaction.json は削除しないでください。

アンインストールはネットワーク不要で、台帳に登録された未変更の skill だけを削除します。
