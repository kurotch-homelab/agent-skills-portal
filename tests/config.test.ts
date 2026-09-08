import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  loadPortal,
  savePortal,
  configPath,
} from "../packages/cli/src/config.ts";
import { temporary } from "./helpers.ts";
test("CLI configuration precedence, persistence, unset, and invalid URL handling", async (t) => {
  const tmp = await temporary();
  t.after(tmp.cleanup);
  const path = join(tmp.path, "config.json");
  assert.throws(() => loadPortal(undefined, {}, path), /sv-skills config set/);
  savePortal("https://saved.example.test", path);
  assert.equal(loadPortal(undefined, {}, path), "https://saved.example.test/");
  assert.equal(
    loadPortal(
      undefined,
      { SV_SKILLS_PORTAL: "https://env.example.test/" },
      path,
    ),
    "https://env.example.test/",
  );
  assert.equal(
    loadPortal(
      "https://flag.example.test/",
      { SV_SKILLS_PORTAL: "https://env.example.test/" },
      path,
    ),
    "https://flag.example.test/",
  );
  assert.throws(() => savePortal("https://user:secret@example.test/", path));
  savePortal(undefined, path);
  assert.throws(() => loadPortal(undefined, {}, path));
  assert.equal(
    configPath({ APPDATA: tmp.path }, "win32"),
    join(tmp.path, "agent-skills", "config.json"),
  );
  assert.equal(
    configPath({ XDG_CONFIG_HOME: tmp.path }, "linux"),
    join(tmp.path, "agent-skills", "config.json"),
  );
});
