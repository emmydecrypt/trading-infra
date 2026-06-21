import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../src/db/store.js";

describe("store", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });
  afterEach(() => {
    store.close();
  });

  it("inserts and lists agents", () => {
    const a = store.insertAgent({ name: "alice", author: "alice@example.com", code: "// code" });
    const b = store.insertAgent({ name: "bob", author: "bob@example.com", code: "// code" });
    const all = store.listAgents();
    expect(all.map((x) => x.id)).toEqual([b.id, a.id]); // DESC by id
    expect(all[0]!.name).toBe("bob");
  });

  it("returns a single agent by id and undefined for missing", () => {
    const a = store.insertAgent({ name: "alice", author: "alice", code: "// x" });
    expect(store.getAgent(a.id)?.name).toBe("alice");
    expect(store.getAgent(9999)).toBeUndefined();
  });

  it("stores runs and surfaces the latest one", () => {
    const a = store.insertAgent({ name: "alice", author: "a", code: "// x" });
    store.insertRun({
      agent_id: a.id,
      started_at: "2024-06-01T00:00:00Z",
      finished_at: "2024-06-01T00:01:00Z",
      metrics_json: JSON.stringify({ ok: true, metrics: { sharpe: 1 } }),
    });
    store.insertRun({
      agent_id: a.id,
      started_at: "2024-06-02T00:00:00Z",
      finished_at: "2024-06-02T00:01:00Z",
      metrics_json: JSON.stringify({ ok: true, metrics: { sharpe: 2 } }),
    });
    const latest = store.latestRun(a.id);
    expect(latest?.started_at).toBe("2024-06-02T00:00:00Z");
    const all = store.allRuns();
    expect(all.length).toBe(2);
  });
});