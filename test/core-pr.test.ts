import { describe, expect, it } from "bun:test";

import { closePr, detectBaseBranch, editPr, hasCommits, markReady, openDraftPr } from "../src/core/pr.ts";
import type { Exec, ExecResult } from "../src/core/worktree.ts";

interface ExecCall {
    cmd: string;
    args: string[];
}

type Responder = (cmd: string, args: string[]) => Partial<ExecResult>;

function recordingExec(responder: Responder = () => ({})): { exec: Exec; calls: ExecCall[] } {
    const calls: ExecCall[] = [];
    const exec: Exec = async (cmd, args) => {
        calls.push({ args, cmd });
        return { code: 0, stderr: "", stdout: "", ...responder(cmd, args) };
    };
    return { calls, exec };
}

describe("detectBaseBranch", () => {
    it("returns an explicit base branch verbatim without shelling out", async () => {
        const { exec, calls } = recordingExec();
        expect(await detectBaseBranch("owner/repo", "develop", exec)).toBe("develop");
        expect(calls).toHaveLength(0);
    });

    it("detects the repo default branch via gh when base is 'auto'", async () => {
        const { exec, calls } = recordingExec(() => ({ stdout: "main\n" }));
        expect(await detectBaseBranch("owner/repo", "auto", exec)).toBe("main");
        expect(calls[0]).toEqual({
            args: ["repo", "view", "owner/repo", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
            cmd: "gh",
        });
    });

    it("throws when gh fails to resolve the default branch", async () => {
        const { exec } = recordingExec(() => ({ code: 1, stderr: "no repo" }));
        expect(detectBaseBranch("owner/repo", "auto", exec)).rejects.toThrow(/no repo/);
    });
});

describe("hasCommits", () => {
    it("runs git rev-list --count <base>..HEAD in cwd and is true when > 0", async () => {
        const { exec, calls } = recordingExec(() => ({ stdout: "3\n" }));
        expect(await hasCommits("/wt", "main", exec)).toBe(true);
        expect(calls[0]).toEqual({
            args: ["-C", "/wt", "rev-list", "--count", "main..HEAD"],
            cmd: "git",
        });
    });

    it("is false when there are no commits ahead of base", async () => {
        const { exec } = recordingExec(() => ({ stdout: "0\n" }));
        expect(await hasCommits("/wt", "main", exec)).toBe(false);
    });
});

describe("openDraftPr", () => {
    const args = {
        base: "main",
        body: "Closes #1",
        cwd: "/wt",
        head: "beflow/cg-42",
        repo: "owner/repo",
        title: "Fix the bug",
    };

    it("creates a draft PR and parses the bare URL printed by gh", async () => {
        const { exec, calls } = recordingExec(() => ({ stdout: "https://github.com/owner/repo/pull/7\n" }));
        const pr = await openDraftPr(args, exec);
        expect(pr).toEqual({ number: 7, url: "https://github.com/owner/repo/pull/7" });
        expect(calls[0]).toEqual({
            args: [
                "pr",
                "create",
                "--repo",
                "owner/repo",
                "--draft",
                "--base",
                "main",
                "--head",
                "beflow/cg-42",
                "--title",
                "Fix the bug",
                "--body",
                "Closes #1",
            ],
            cmd: "gh",
        });
    });

    it("falls back to the existing PR when create reports head already has one", async () => {
        const { exec, calls } = recordingExec((_cmd, a) => {
            if (a[1] === "create") {
                return { code: 1, stderr: "a pull request for branch beflow/cg-42 already exists" };
            }
            return { stdout: JSON.stringify({ number: 9, url: "https://github.com/owner/repo/pull/9" }) };
        });
        const pr = await openDraftPr(args, exec);
        expect(pr).toEqual({ number: 9, url: "https://github.com/owner/repo/pull/9" });
        expect(calls[1]).toEqual({
            args: ["pr", "view", "beflow/cg-42", "--repo", "owner/repo", "--json", "url,number"],
            cmd: "gh",
        });
    });

    it("throws a real failure when neither create nor view succeed", async () => {
        const { exec } = recordingExec(() => ({ code: 1, stderr: "boom" }));
        expect(openDraftPr(args, exec)).rejects.toThrow(/boom/);
    });
});

describe("markReady", () => {
    it("runs gh pr ready for a PR number", async () => {
        const { exec, calls } = recordingExec();
        await markReady(7, "owner/repo", exec);
        expect(calls[0]).toEqual({ args: ["pr", "ready", "7", "--repo", "owner/repo"], cmd: "gh" });
    });

    it("accepts a PrRef and uses its number", async () => {
        const { exec, calls } = recordingExec();
        await markReady({ number: 7, url: "u" }, "owner/repo", exec);
        expect(calls[0]?.args).toEqual(["pr", "ready", "7", "--repo", "owner/repo"]);
    });

    it("tolerates a PR that is already ready", async () => {
        const { exec } = recordingExec(() => ({ code: 1, stderr: "Pull request is already open for review" }));
        expect(markReady(7, "owner/repo", exec)).resolves.toBeUndefined();
    });

    it("throws on a real gh failure", async () => {
        const { exec } = recordingExec(() => ({ code: 1, stderr: "network error" }));
        expect(markReady(7, "owner/repo", exec)).rejects.toThrow(/network error/);
    });
});

describe("editPr", () => {
    it("passes only the provided fields to gh pr edit", async () => {
        const { exec, calls } = recordingExec();
        await editPr(7, "owner/repo", { title: "New title" }, exec);
        expect(calls[0]).toEqual({
            args: ["pr", "edit", "7", "--repo", "owner/repo", "--title", "New title"],
            cmd: "gh",
        });
    });

    it("passes both title and body when supplied", async () => {
        const { exec, calls } = recordingExec();
        await editPr(7, "owner/repo", { body: "New body", title: "New title" }, exec);
        expect(calls[0]?.args).toEqual([
            "pr",
            "edit",
            "7",
            "--repo",
            "owner/repo",
            "--title",
            "New title",
            "--body",
            "New body",
        ]);
    });

    it("is a no-op when no fields are provided", async () => {
        const { exec, calls } = recordingExec();
        await editPr(7, "owner/repo", {}, exec);
        expect(calls).toHaveLength(0);
    });
});

describe("closePr", () => {
    it("closes the PR without --delete-branch and never touches the local branch", async () => {
        const { exec, calls } = recordingExec();
        await closePr(7, "owner/repo", exec);
        expect(calls[0]).toEqual({
            args: ["pr", "close", "7", "--repo", "owner/repo"],
            cmd: "gh",
        });
        expect(calls).toHaveLength(1);
        expect(calls.some((c) => c.cmd === "git" && c.args.includes("branch"))).toBe(false);
    });

    it("tolerates an already-closed PR without throwing", async () => {
        const { exec } = recordingExec((cmd, a) => {
            if (cmd === "gh" && a[1] === "close") {
                return { code: 1, stderr: "Pull request is already closed" };
            }
            return {};
        });
        expect(closePr(7, "owner/repo", exec)).resolves.toBeUndefined();
    });

    it("throws on a real gh close failure", async () => {
        const { exec } = recordingExec((cmd, a) =>
            cmd === "gh" && a[1] === "close" ? { code: 1, stderr: "permission denied" } : {},
        );
        expect(closePr(7, "owner/repo", exec)).rejects.toThrow(/permission denied/);
    });
});
