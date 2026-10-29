import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectedPrompts, userPrompts } from "./harness-fixtures";

describe("UserPromptSubmit hooks", () => {
  test("save and recall only genuine user text", async () => {
    const home = mkdtempSync(join(tmpdir(), "honcho-prompt-hooks-"));
    const uploads: Array<{ peer_id: string; content: string }> = [];
    const searches: string[] = [];
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        requests.push(url.pathname);
        if (url.pathname.endsWith("/messages")) {
          const body = await req.json() as { messages: Array<{ peer_id: string; content: string }> };
          uploads.push(...body.messages);
          return Response.json(body.messages.map((m, i) => ({ ...m, id: `m${i}`, session_id: "project", workspace_id: "test" })));
        }
        if (url.pathname.endsWith("/context")) {
          searches.push(url.searchParams.get("search_query") ?? "");
          return Response.json({ representation: {}, peer_card: [] });
        }
        return Response.json({ id: "test", metadata: {}, configuration: {} });
      },
    });
    try {
      mkdirSync(join(home, ".honcho"));
      writeFileSync(join(home, ".honcho/config.json"), JSON.stringify({
        apiKey: "test-only",
        peerName: "human",
        workspace: "test",
        endpoint: { baseUrl: `http://127.0.0.1:${server.port}` },
        injection: { perTurn: ["userContext"], searchQuerySource: "prompt" },
      }));
      const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HONCHO_") && !key.startsWith("CLAUDE_")));
      const invoke = async (hook: string, prompt: string) => {
        const proc = Bun.spawn([process.execPath, `hooks/${hook}.ts`], {
          cwd: join(import.meta.dir, ".."),
          env: { ...base, HOME: home },
          stdin: new Blob([JSON.stringify({ prompt, cwd: join(home, "project"), session_id: "fixture" })]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
      };
      for (const hook of ["save-user-message", "user-prompt"]) {
        for (const prompt of injectedPrompts) await invoke(hook, prompt);
      }
      expect(requests).toEqual([]);
      for (const { prompt } of userPrompts) {
        await invoke("save-user-message", prompt);
        await invoke("user-prompt", prompt);
      }
      expect(uploads).toHaveLength(userPrompts.length);
      expect(uploads.map((m) => m.peer_id)).toEqual(userPrompts.map(() => "human"));
      expect(uploads.map((m) => m.content)).toEqual(userPrompts.map((p) => p.text));
      expect(searches).toEqual(userPrompts.map((p) => p.text));
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("dedupePerSession injects each conclusion once per session, truncated", async () => {
    const home = mkdtempSync(join(tmpdir(), "honcho-prompt-dedupe-"));
    let representation = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (new URL(req.url).pathname.endsWith("/context")) {
          return Response.json({ peer_id: "human", representation, peer_card: [] });
        }
        return Response.json({ id: "test", metadata: {}, configuration: {} });
      },
    });
    try {
      mkdirSync(join(home, ".honcho"));
      writeFileSync(join(home, ".honcho/config.json"), JSON.stringify({
        apiKey: "test-only",
        peerName: "human",
        workspace: "test",
        endpoint: { baseUrl: `http://127.0.0.1:${server.port}` },
        injection: { perTurn: ["userContext"], dedupePerSession: true, maxConclusionChars: 30 },
      }));
      const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HONCHO_") && !key.startsWith("CLAUDE_")));
      const invoke = async (hook: string, sessionId: string, input: Record<string, unknown> = {}) => {
        const proc = Bun.spawn([process.execPath, `hooks/${hook}.ts`], {
          cwd: join(import.meta.dir, ".."),
          env: { ...base, HOME: home },
          stdin: new Blob([JSON.stringify({ prompt: "how does the delivery webhook work?", cwd: join(home, "project"), session_id: sessionId, ...input })]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, , stdout] = await Promise.all([proc.exited, new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
        expect(code).toBe(0);
        const line = stdout.trim().split("\n").pop() ?? "{}";
        return (JSON.parse(line).hookSpecificOutput?.additionalContext ?? "") as string;
      };

      representation = "## Explicit Observations\n\n[2026-10-01 10:00:00] User prefers short answers\n[2026-10-01 10:00:00] User maintains the delivery app and its webhooks";
      const first = await invoke("user-prompt", "s1");
      expect(first).toContain("User prefers short answers");
      expect(first).toContain("User maintains the delivery a…");
      expect(first).not.toContain("delivery app and its webhooks");

      // Same conclusions again: nothing new to inject.
      expect(await invoke("user-prompt", "s1")).toBe("");

      // Only the new conclusion is injected; case/whitespace variants count as seen.
      representation += "\n[2026-10-02 10:00:00] User deploys via GitHub Actions\n[2026-10-02 10:00:00] user PREFERS  short answers";
      const third = await invoke("user-prompt", "s1");
      expect(third).toContain("User deploys via GitHub Actio…");
      expect(third).not.toContain("short answers");

      // Another Claude session starts from scratch.
      expect(await invoke("user-prompt", "s2")).toContain("User prefers short answers");
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
