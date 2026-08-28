import { describe, expect, it } from "vitest";
import { buildDccChildEnvironment } from "../../apps/worker/src/dcc-environment.js";
import { runControlledProcess } from "../../apps/worker/src/process.js";

describe("DCC child environment", () => {
  it("copies only case-insensitive Windows runtime keys and explicit overrides", () => {
    const childEnvironment = buildDccChildEnvironment({
      parentEnvironment: {
        sYsTeMrOoT: "C:\\Windows",
        pAtH: "C:\\Windows\\System32",
        tMp: "C:\\Temp",
        OPENAI_API_KEY: "must_not_leak",
        GITHUB_TOKEN: "must_not_leak",
        AWS_SECRET_ACCESS_KEY: "must_not_leak",
        DATABASE_URL: "must_not_leak",
        RANDOM_PRIVATE_TOKEN: "must_not_leak",
        CHAOS_API_TOKEN: "must_not_leak",
        AI_ARCHVIZ_UNTRUSTED_PARENT_VALUE: "must_not_leak",
      },
      overrides: {
        AI_ARCHVIZ_CANDIDATE_PATH: "candidate.max",
        AI_ARCHVIZ_REQUIRE_SAFE_SCENE: "1",
      },
    });

    expect(childEnvironment).toMatchObject({
      SystemRoot: "C:\\Windows",
      Path: "C:\\Windows\\System32",
      TMP: "C:\\Temp",
      AI_ARCHVIZ_CANDIDATE_PATH: "candidate.max",
      AI_ARCHVIZ_REQUIRE_SAFE_SCENE: "1",
    });
    for (const secretKey of [
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URL",
      "RANDOM_PRIVATE_TOKEN",
      "CHAOS_API_TOKEN",
      "AI_ARCHVIZ_UNTRUSTED_PARENT_VALUE",
    ]) {
      expect(childEnvironment).not.toHaveProperty(secretKey);
    }
  });

  it("does not silently inherit the parent environment", async () => {
    const result = await runControlledProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({allowed:process.env.AI_ARCHVIZ_TEST_ALLOWED,secret:process.env.OPENAI_API_KEY}))",
      ],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: { AI_ARCHVIZ_TEST_ALLOWED: "present" },
    });

    expect(result.errorCode).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ allowed: "present" });
  });
});
