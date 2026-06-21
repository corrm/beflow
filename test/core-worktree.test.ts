import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { xdgDataHome } from "../src/config/xdg.ts";
import {
    createWorktree,
    expandHome,
    removeWorktree,
    resolveWorktreeDir,
    sanitizeKey,
    worktreePath,
} from "../src/core/worktree.ts";
import type { Exec, ExecResult } from "../src/core/worktree.ts";

interface ExecCall {
    cmd: string;
    args: string[];
}

function fakeExec(result: Partial<ExecResult> = {}): {
    exec: Exec;
    calls: ExecCall[];
} {
    const calls: ExecCall[] = [];
    const exec: Exec = async (cmd, args) => {
        calls.push({ args, cmd });
        return { code: 0, stderr: "", stdout: "", ...result };
    };
    return { calls, exec };
}

describe("sanitizeKey", () => {
    it("lowercases and replaces non-alnum with single dashes", () => {
        expect(sanitizeKey("CG-42")).toBe("cg-42");
        expect(sanitizeKey("Foo / Bar_42!")).toBe("foo-bar-42");
    });
});

describe("worktreePath", () => {
    it("lives under <baseDir>/<sanitized>", () => {
        expect(worktreePath("/wt", "CG-42")).toBe("/wt/cg-42");
    });
});

describe("expandHome", () => {
    it("expands a leading ~ / ~/ to the home dir, passes others through", () => {
        expect(expandHome("~")).toBe(homedir());
        expect(expandHome("~/.beflow/worktrees")).toBe(join(homedir(), ".beflow", "worktrees"));
        expect(expandHome("/abs/path")).toBe("/abs/path");
        expect(expandHome("~notme/x")).toBe("~notme/x");
    });
});

describe("resolveWorktreeDir", () => {
    it("defaults under the XDG data home when unconfigured", () => {
        expect(resolveWorktreeDir()).toBe(join(xdgDataHome(), "worktrees"));
    });
    it("expands and uses a configured dir", () => {
        expect(resolveWorktreeDir("~/wt")).toBe(join(homedir(), "wt"));
        expect(resolveWorktreeDir("/var/wt")).toBe("/var/wt");
    });
});

describe("createWorktree", () => {
    it("runs git -C <repo> worktree add -B beflow/<key> <baseDir>/<key>", async () => {
        const { exec, calls } = fakeExec();
        const wt = await createWorktree("/repo", "CG-42", exec, "/wt");
        expect(wt).toBe("/wt/cg-42");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({
            args: ["-C", "/repo", "worktree", "add", "-B", "beflow/cg-42", "/wt/cg-42"],
            cmd: "git",
        });
    });

    it("throws on non-zero exit", async () => {
        const { exec } = fakeExec({ code: 128, stderr: "fatal: already exists" });
        expect(createWorktree("/repo", "CG-42", exec, "/wt")).rejects.toThrow(/already exists/);
    });
});

describe("removeWorktree", () => {
    it("runs git -C <repo> worktree remove <wt> --force", async () => {
        const { exec, calls } = fakeExec();
        await removeWorktree("/repo", "/repo/.beflow/worktrees/cg-42", exec);
        expect(calls[0]).toEqual({
            args: ["-C", "/repo", "worktree", "remove", "/repo/.beflow/worktrees/cg-42", "--force"],
            cmd: "git",
        });
    });

    it("throws on non-zero exit", async () => {
        const { exec } = fakeExec({ code: 1, stderr: "not a worktree" });
        expect(removeWorktree("/repo", "/repo/.beflow/worktrees/cg-42", exec)).rejects.toThrow(/not a worktree/);
    });
});
