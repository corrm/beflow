import { describe, expect, it } from "bun:test";

import { computeChangedFiles, evaluatePolicy, parseAgentowners } from "../src/core/policy.ts";
import type { PolicyContext, PolicyExec, PolicyReader } from "../src/core/policy.ts";
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
        const res = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec, "/wt");
        expect(res.decision).toBe("allow");
        expect(res.reason).toBe("no policy rule matched");
    });

    it("blocks when a single block rule matches a path", async () => {
        const policy = globsPolicy([{ decision: "block", paths: ["infra/**"] }]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["infra/main.tf"] }), policy, noopCmdExec, "/wt");
        expect(res.decision).toBe("block");
        expect(res.reason).toContain("infra/**");
        expect(res.matchedRules).toEqual([{ decision: "block", paths: ["infra/**"] }]);
    });

    it("populates structured matchedRules for every fired rule (not just the winner)", async () => {
        const policy = globsPolicy([
            { decision: "allow", paths: ["src/**"] },
            { agent: "claude", decision: "block", paths: ["src/**"] },
        ]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec, "/wt");
        expect(res.decision).toBe("block");
        expect(res.matchedRules).toEqual([
            { decision: "allow", paths: ["src/**"] },
            { agent: "claude", decision: "block", paths: ["src/**"] },
        ]);
    });

    it("leaves matchedRules empty when no rule matches", async () => {
        const policy = globsPolicy([{ decision: "block", paths: ["infra/**"] }]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec, "/wt");
        expect(res.matchedRules).toEqual([]);
    });

    it("only fires an agent-scoped rule for the matching agent", async () => {
        const policy = globsPolicy([{ agent: "gpt", decision: "block", paths: ["src/**"] }]);
        const claude = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec, "/wt");
        expect(claude.decision).toBe("allow");
        const gpt = await evaluatePolicy(
            contextWith({ agent: "gpt", changedFiles: ["src/a.ts"] }),
            policy,
            noopCmdExec,
            "/wt",
        );
        expect(gpt.decision).toBe("block");
        expect(gpt.reason).toContain("agent=gpt");
    });

    it("matches a rule with no paths against any change", async () => {
        const policy = globsPolicy([{ agent: "claude", decision: "require_approval" }]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["anything"] }), policy, noopCmdExec, "/wt");
        expect(res.decision).toBe("require_approval");
    });

    it("most-restrictive-wins: block beats require_approval beats allow", async () => {
        const policy = globsPolicy([
            { decision: "allow", paths: ["src/**"] },
            { decision: "require_approval", paths: ["src/**"] },
            { decision: "block", paths: ["src/**"] },
        ]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec, "/wt");
        expect(res.decision).toBe("block");
    });

    it("most-restrictive-wins: require_approval beats allow", async () => {
        const policy = globsPolicy([
            { decision: "allow", paths: ["src/**"] },
            { decision: "require_approval", paths: ["src/**"] },
        ]);
        const res = await evaluatePolicy(contextWith({ changedFiles: ["src/a.ts"] }), policy, noopCmdExec, "/wt");
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
        const res = await evaluatePolicy(context, commandPolicy(["policy.sh"]), exec, "/wt");
        expect(seenArgv).toEqual(["policy.sh"]);
        expect(JSON.parse(seenStdin)).toEqual(context);
        expect(res).toEqual({ decision: "require_approval", matchedRules: [], reason: "needs review" });
    });

    it("pipes the change receipt to the command on stdin", async () => {
        let seenStdin = "";
        const exec: PolicyExec = async (_argv, _cwd, stdin) => {
            seenStdin = stdin;
            return { exitCode: 0, stderr: "", stdout: '{"decision":"allow"}' };
        };
        const context = contextWith({
            changedFiles: ["src/a.ts"],
            receipt: { intent: "add a login route", riskSurfaces: ["app", "auth"] },
        });
        await evaluatePolicy(context, commandPolicy(["policy.sh"]), exec, "/wt");
        const parsed: unknown = JSON.parse(seenStdin);
        expect(parsed).toMatchObject({
            receipt: { intent: "add a login route", riskSurfaces: ["app", "auth"] },
        });
    });

    it("lets the command return require_approval informed by the receipt's risk surfaces", async () => {
        const exec: PolicyExec = async (_argv, _cwd, stdin) => {
            const parsed: unknown = JSON.parse(stdin);
            const surfaces =
                typeof parsed === "object" &&
                parsed !== null &&
                "receipt" in parsed &&
                typeof parsed.receipt === "object" &&
                parsed.receipt !== null &&
                "riskSurfaces" in parsed.receipt &&
                Array.isArray(parsed.receipt.riskSurfaces)
                    ? parsed.receipt.riskSurfaces
                    : [];
            return surfaces.includes("auth")
                ? { exitCode: 0, stderr: "", stdout: '{"decision":"require_approval","reason":"auth surface"}' }
                : { exitCode: 0, stderr: "", stdout: '{"decision":"allow"}' };
        };
        const flagged = await evaluatePolicy(
            contextWith({ receipt: { intent: "x", riskSurfaces: ["auth"] } }),
            commandPolicy(["policy.sh"]),
            exec,
            "/wt",
        );
        expect(flagged.decision).toBe("require_approval");
        expect(flagged.reason).toBe("auth surface");
        const clean = await evaluatePolicy(
            contextWith({ receipt: { intent: "x", riskSurfaces: ["app"] } }),
            commandPolicy(["policy.sh"]),
            exec,
            "/wt",
        );
        expect(clean.decision).toBe("allow");
    });

    it("throws on garbage (non-JSON) output", async () => {
        const exec: PolicyExec = async () => ({ exitCode: 0, stderr: "", stdout: "not json" });
        expect(evaluatePolicy(contextWith(), commandPolicy(["p"]), exec, "/wt")).rejects.toThrow(/non-JSON/);
    });

    it("throws on an invalid decision value", async () => {
        const exec: PolicyExec = async () => ({ exitCode: 0, stderr: "", stdout: '{"decision":"maybe"}' });
        expect(evaluatePolicy(contextWith(), commandPolicy(["p"]), exec, "/wt")).rejects.toThrow(/invalid decision/);
    });

    it("throws on a non-zero exit", async () => {
        const exec: PolicyExec = async () => ({ exitCode: 2, stderr: "engine crashed", stdout: "" });
        expect(evaluatePolicy(contextWith(), commandPolicy(["p"]), exec, "/wt")).rejects.toThrow(
            /policy command failed/,
        );
    });

    it("throws when command is missing", async () => {
        expect(evaluatePolicy(contextWith(), commandPolicy(undefined), noopCmdExec, "/wt")).rejects.toThrow(
            /policy.command is missing/,
        );
    });
});

describe("evaluatePolicy off", () => {
    it("always allows regardless of changes", async () => {
        const policy: ResolvedPolicy = { evaluator: "off", onBlock: "comment" };
        const res = await evaluatePolicy(contextWith({ changedFiles: ["infra/x"] }), policy, noopCmdExec, "/wt");
        expect(res.decision).toBe("allow");
        expect(res.reason).toBe("policy disabled");
    });
});

describe("parseAgentowners", () => {
    it("parses globs with decisions and an optional agent column", () => {
        const rules = parseAgentowners("infra/** block\nsrc/** require_approval gpt\ndocs/** allow");
        expect(rules).toEqual([
            { decision: "block", paths: ["infra/**"] },
            { agent: "gpt", decision: "require_approval", paths: ["src/**"] },
            { decision: "allow", paths: ["docs/**"] },
        ]);
    });

    it("ignores blank lines and # comments, including trailing inline comments", () => {
        const rules = parseAgentowners("# header\n\ninfra/** block  # needs human\n   \n");
        expect(rules).toEqual([{ decision: "block", paths: ["infra/**"] }]);
    });

    it("throws on an invalid decision token", () => {
        expect(() => parseAgentowners("infra/** maybe")).toThrow(/invalid AGENTOWNERS decision/);
    });

    it("throws on a malformed line (missing decision)", () => {
        expect(() => parseAgentowners("infra/**")).toThrow(/malformed AGENTOWNERS line/);
    });

    it("throws on a malformed line (extra token)", () => {
        expect(() => parseAgentowners("infra/** block gpt extra")).toThrow(/malformed AGENTOWNERS line/);
    });
});

describe("evaluatePolicy agentowners", () => {
    function agentownersPolicy(agentownersPath?: string): ResolvedPolicy {
        return { agentownersPath, evaluator: "agentowners", onBlock: "comment" };
    }

    it("resolves a relative path against cwd and evaluates with most-restrictive-wins", async () => {
        let seenPath = "";
        const reader: PolicyReader = async (path) => {
            seenPath = path;
            return "src/** allow\nsrc/** block\n";
        };
        const res = await evaluatePolicy(
            contextWith({ changedFiles: ["src/a.ts"] }),
            agentownersPolicy(".github/AGENTOWNERS"),
            noopCmdExec,
            "/wt",
            reader,
        );
        expect(seenPath).toBe("/wt/.github/AGENTOWNERS");
        expect(res.decision).toBe("block");
    });

    it("uses an absolute path as-is", async () => {
        let seenPath = "";
        const reader: PolicyReader = async (path) => {
            seenPath = path;
            return "infra/** block\n";
        };
        await evaluatePolicy(
            contextWith({ changedFiles: ["infra/x"] }),
            agentownersPolicy("/trusted/AGENTOWNERS"),
            noopCmdExec,
            "/wt",
            reader,
        );
        expect(seenPath).toBe("/trusted/AGENTOWNERS");
    });

    it("only fires an agent-scoped line for the matching agent", async () => {
        const reader: PolicyReader = async () => "src/** block gpt\n";
        const claude = await evaluatePolicy(
            contextWith({ changedFiles: ["src/a.ts"] }),
            agentownersPolicy(),
            noopCmdExec,
            "/wt",
            reader,
        );
        expect(claude.decision).toBe("allow");
        const gpt = await evaluatePolicy(
            contextWith({ agent: "gpt", changedFiles: ["src/a.ts"] }),
            agentownersPolicy(),
            noopCmdExec,
            "/wt",
            reader,
        );
        expect(gpt.decision).toBe("block");
    });

    it("defaults to .github/AGENTOWNERS and allows when the file is missing", async () => {
        let seenPath = "";
        const reader: PolicyReader = async (path) => {
            seenPath = path;
            return undefined;
        };
        const res = await evaluatePolicy(contextWith(), agentownersPolicy(), noopCmdExec, "/wt", reader);
        expect(seenPath).toBe("/wt/.github/AGENTOWNERS");
        expect(res.decision).toBe("allow");
        expect(res.reason).toBe("no AGENTOWNERS file at /wt/.github/AGENTOWNERS");
    });

    it("throws when a present file is malformed", async () => {
        const reader: PolicyReader = async () => "infra/** nope\n";
        expect(evaluatePolicy(contextWith(), agentownersPolicy(), noopCmdExec, "/wt", reader)).rejects.toThrow(
            /invalid AGENTOWNERS decision/,
        );
    });
});
