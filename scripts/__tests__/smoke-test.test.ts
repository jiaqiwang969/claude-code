import { describe, expect, test } from "bun:test";

import {
	ONLINE_CHECK_GROUP_NAMES,
	ONLINE_CHECK_GROUPS,
	OFFLINE_CHECKS,
	ONLINE_CHECKS,
	parseArgs,
	resolveChecks,
	shouldRetryTransientToolSmoke,
} from "../smoke-test";

describe("smoke-test CLI parsing", () => {
	test("parses repeated and comma-separated group flags", () => {
		const parsed = parseArgs([
			"--online",
			"--group",
			"tools-and-agent",
			"--groups=integrations,api-and-session",
			"--checks",
			"doctor,context-command",
			"--list-groups",
			"--model",
			"claude-test-model",
			"--max-budget-usd=0.33",
		]);

		expect(parsed).toEqual({
			online: true,
			checks: ["doctor", "context-command"],
			groups: ["tools-and-agent", "integrations", "api-and-session"],
			listGroups: true,
			model: "claude-test-model",
			maxBudgetUsd: 0.33,
		});
	});
});

describe("smoke-test group resolution", () => {
	test("exposes the canonical online group names", () => {
		expect(ONLINE_CHECK_GROUP_NAMES).toEqual(["api-and-session", "tools-and-agent", "integrations"]);
	});

	test("resolves named groups to their registered checks", () => {
		expect(resolveChecks([], ["tools-and-agent"], true)).toEqual(ONLINE_CHECK_GROUPS["tools-and-agent"]);
	});

	test("merges groups and explicit checks without duplicates", () => {
		expect(resolveChecks(["bash-tool", "doctor"], ["tools-and-agent"], true)).toEqual([
			...ONLINE_CHECK_GROUPS["tools-and-agent"],
			"doctor",
		]);
	});

	test("returns the default offline set when no online flags are requested", () => {
		expect(resolveChecks([], [], false)).toEqual([...OFFLINE_CHECKS]);
	});

	test("returns the full offline plus online set for default online smoke", () => {
		expect(resolveChecks([], [], true)).toEqual([...OFFLINE_CHECKS, ...ONLINE_CHECKS]);
	});

	test("throws on unknown group names", () => {
		expect(() => resolveChecks([], ["not-a-real-group"], true)).toThrow("Unknown smoke group(s): not-a-real-group");
	});
});

describe("smoke-test transient retry detection", () => {
	test("retries timeout and missing tool_use failures", () => {
		expect(shouldRetryTransientToolSmoke("[smoke-timeout] command exceeded 120000 ms")).toBe(true);
		expect(shouldRetryTransientToolSmoke("Bash tool_use event not observed")).toBe(true);
	});

	test("does not retry deterministic tool failures", () => {
		expect(shouldRetryTransientToolSmoke("Bash tool result did not match expected stdout")).toBe(false);
		expect(shouldRetryTransientToolSmoke("expected token FOO, got BAR")).toBe(false);
	});
});
