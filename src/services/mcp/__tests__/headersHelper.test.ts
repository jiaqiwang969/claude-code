import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMcpHeadersFromHelper, getMcpServerHeaders } from "../headersHelper";

const tempDirs: string[] = [];

async function createHelperScript(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "headers-helper-test-"));
  const helperPath = join(dir, "helper.sh");
  tempDirs.push(dir);
  await writeFile(helperPath, source, "utf8");
  await chmod(helperPath, 0o755);
  return helperPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("getMcpHeadersFromHelper", () => {
  test("executes headersHelper and passes server context env vars", async () => {
    const helperPath = await createHelperScript(`#!/bin/sh
printf '%s' '{"X-Server-Name":"'"$CLAUDE_CODE_MCP_SERVER_NAME"'","X-Server-Url":"'"$CLAUDE_CODE_MCP_SERVER_URL"'"}'
`);

    const headers = await getMcpHeadersFromHelper("smoke-http", {
      type: "http",
      url: "https://example.test/mcp",
      headersHelper: helperPath,
    });

    expect(headers).toEqual({
      "X-Server-Name": "smoke-http",
      "X-Server-Url": "https://example.test/mcp",
    });
  });

  test("returns null when helper returns non-string header values", async () => {
    const helperPath = await createHelperScript(`#!/bin/sh
printf '%s' '{"Authorization":1}'
`);

    const headers = await getMcpHeadersFromHelper("smoke-http", {
      type: "http",
      url: "https://example.test/mcp",
      headersHelper: helperPath,
    });

    expect(headers).toBeNull();
  });
});

describe("getMcpServerHeaders", () => {
  test("dynamic helper headers override static headers", async () => {
    const helperPath = await createHelperScript(`#!/bin/sh
printf '%s' '{"Authorization":"Bearer helper-token","X-Helper":"enabled"}'
`);

    const headers = await getMcpServerHeaders("smoke-http", {
      type: "http",
      url: "https://example.test/mcp",
      headers: {
        Authorization: "Bearer static-token",
        "X-Static": "kept",
      },
      headersHelper: helperPath,
    });

    expect(headers).toEqual({
      Authorization: "Bearer helper-token",
      "X-Static": "kept",
      "X-Helper": "enabled",
    });
  });
});
