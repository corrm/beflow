import { describe, expect, it } from "bun:test";

import { computeChangedFiles, evaluatePolicy } from "../src/core/policy.ts";
import type { PolicyContext, PolicyExec } from "../src/core/policy.ts";
import type { Exec } from "../src/core/worktree.ts";
import type { ResolvedPolicy } from "../src/model/types.ts";

function contextWith(over: Partial<PolicyContext> = {}): PolicyContext {
    return {
        agent: "claude",
        baseBranch: "main",
        changedFiles: [],
        issueKey: "CG-1",
        jobKind: "implement",
        repo: "/repo/bin",
        ...over,
    };
}

describe("computeChangedFiles", () => {
    it("runs git diff --name-only base...HEAD in cwd and parses the list", async () => {
        let seenArgs: string[] = [];
        const exec: Exec = async (cmd, args) => {
            expect(cmd).toBe("git");
            seenArgs = args;
            return { code: 0, stderr: "", stdout: "src/a.ts\nsrc/b.ts\n\n" };
        };
        const files = await computeChangedFiles("/wt", "main", exec);
        expect(seenArgs).toEqual(["-C", "/wt", "diff", "--name-only", "main...HEAD"]);
        expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("throws when git diff exits non-zero", async () => {
        const exec: Exec = async () => ({ code: 1, stderr: "boom", stdout: "" });
        expect(computeChangedFiles("/wt", "main", exec)).rejects.toThrow(/git diff failed/);
    });
});

const noopCmdExec: PolicyExec = async () => ({ exitCode: 0, stderr: "", stdout: "" });

describe("evaluatePolicy globs", () => {
    function globsPolicy(rules: ResolvedPolicy["rules"]): ResolvedPolicy {
        return { evaluator: "globs", onBlock: "comment", rules };
    }

    it("allows when no rule matches", async () => {
        const policy = globsPolicy([{ decision: "block", paths: ["infra/**"] }]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec);
        expect(res.decision).toBe("allow");
        expect(res.reason).toBe("no policy rule matched");
    });

    it("blocks when a single block rule matches a path", async () => {
        const policy = globsPolicy([{ decision: "block", paths: ["infra/**"] }]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["infra/main.tf"] }), policy, noopCmdExec);
        expect(res.decision).toBe("block");
        expect(res.reason).toContain("infra/**");
    });

    it("only fires an agent-scoped rule for the matching agent", async () => {
        const policy = globsPolicy([{ agent: "gpt", decision: "block", paths: ["src/**"] }]);
        const claude = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec);
        expect(claude.decision).toBe("allow");
        const gpt = await evaluatePolicy(
            contextWith({ agent: "gpt", changedFiles: ["src/a.ts"] }),
            policy,
            noopCmdExec,
        );
        expect(gpt.decision).toBe("block");
        expect(gpt.reason).toContain("agent=gpt");
    });

    it("matches a rule with no paths against any change", async () => {
        const policy = globsPolicy([{ agent: "claude", decision: "require_approval" }]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["anything"] }), policy, noopCmdExec);
        expect(res.decision).toBe("require_approval");
    });

    it("most-restrictive-wins: block beats require_approval beats allow", async () => {
        const policy = globsPolicy([
            { decision: "allow", paths: ["src/**"] },
            { decision: "require_approval", paths: ["src/**"] },
            { decision: "block", paths: ["src/**"] },
        ]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec);
        expect(res.decision).toBe("block");
    });

    it("most-restrictive-wins: require_approval beats allow", async () => {
        const policy = globsPolicy([
            { decision: "allow", paths: ["src/**"] },
            { decision: "require_approval", paths: ["src/**"] },
        ]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec);
        expect(res.decision).toBe("require_approval");
    });
});

describe("evaluatePolicy command", () => {
    function commandPolicy(command?: string[]): ResolvedPolicy {
        return { command, evaluator: "command", onBlock: "comment" };
    }

    it("parses {decision,reason} from the command stdout and pipes the context as JSON", async () => {
        let seenArgv: string[] = [];
        let seenStdin = "";
        const exec: PolicyExec = async (argv, _cwd, stdin) => {
            seenArgv = argv;
            seenStdin = stdin;
            return { exitCode: 0, stderr: "", stdout: '{"decision":"require_approval","reason":"needs review"}' };
        };
        const context = contextWith({ changedFiles: ["src/a.ts"] });
        const res = await evaluatePolicy(context, commandPolicy(["policy.sh"]), exec);
        expect(seenArgv).toEqual(["policy.sh"]);
        expect(JSON.parse(seenStdin)).toEqual(context);
        expect(res).toEqual({ decision: "require_approval", reason: "needs review" });
    });

    it("throws on garbage (non-JSON) output", async () => {
        const exec: PolicyExec = async () => ({ exitCode: 0, stderr: "", stdout: "not json" });
        expect(evaluatePolicy(contextWith(), commandPolicy(["p"]), exec)).rejects.toThrow(/non-JSON/);
    });

    it("throws on an invalid decision value", async () => {
        const exec: PolicyExec = async () => ({ exitCode: 0, stderr: "", stdout: '{"decision":"maybe"}' });
        expect(evaluatePolicy(contextWith(), commandPolicy(["p"]), exec)).rejects.toThrow(/invalid decision/);
    });

    it("throws on a non-zero exit", async () => {
        const exec: PolicyExec = async () => ({ exitCode: 2, stderr: "engine crashed", stdout: "" });
        expect(evaluatePolicy(contextWith(), commandPolicy(["p"]), exec)).rejects.toThrow(/policy command failed/);
    });

    it("throws when command is missing", async () => {
        expect(evaluatePolicy(contextWith(), commandPolicy(undefined), noopCmdExec)).rejects.toThrow(
            /policy.command is missing/,
        );
    });
});

describe("evaluatePolicy off", () => {
    it("always allows regardless of changes", async () => {
        const policy: ResolvedPolicy = { evaluator: "off", onBlock: "comment" };
        const res = await evaluatePolicy(contextWith({ changedFiles: ["infra/x"] }), policy, noopCmdExec);
        expect(res.decision).toBe("allow");
        expect(res.reason).toBe("policy disabled");
    });
});
