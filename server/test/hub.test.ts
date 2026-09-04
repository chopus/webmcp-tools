import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../src/hub.js";
import { FakeRelay, sleep } from "./helpers.js";

describe("hub", () => {
  let hub: Hub;
  let hubFile: string;

  beforeEach(async () => {
    hubFile = path.join(os.tmpdir(), `webmcp-hub-test-${process.pid}-${Date.now()}.json`);
    hub = new Hub({ filePath: hubFile, log: () => {} });
    await hub.listen();
  });

  afterEach(async () => {
    await hub.close();
  });

  it("binds an ephemeral port on 127.0.0.1 and writes the discovery file", () => {
    expect(hub.port).toBeGreaterThan(0);
    expect(existsSync(hubFile)).toBe(true);
    const discovery = JSON.parse(readFileSync(hubFile, "utf8")) as { port: number; token: string };
    expect(discovery.port).toBe(hub.port);
    expect(discovery.token).toBe(hub.token);
    expect(discovery.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deletes the discovery file on close", async () => {
    await hub.close();
    expect(existsSync(hubFile)).toBe(false);
  });

  it("destroys a connection with a wrong token", async () => {
    const relay = new FakeRelay(hub.port);
    relay.send({ v: 1, kind: "hello", who: "relay", token: "wrong-token" });
    expect(await relay.closedWithin(1500)).toBe(true);
    relay.destroy();
  });

  it("destroys a connection that does not start with hello", async () => {
    const relay = new FakeRelay(hub.port);
    relay.send({ v: 1, kind: "request", id: 1, tool: "navigate", params: {} });
    expect(await relay.closedWithin(1500)).toBe(true);
    relay.destroy();
  });

  it("completes the hello handshake for a valid token", async () => {
    const relay = new FakeRelay(hub.port);
    relay.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    const reply = await relay.next();
    expect(reply).toEqual({ v: 1, kind: "hello", who: "hub" });
    relay.destroy();
  });

  it("routes a request to the extension and resolves the response", async () => {
    const relay = new FakeRelay(hub.port);
    relay.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await relay.next(); // hub hello

    const pending = hub.request("navigate", { url: "https://example.com/" }, 3000);
    const request = await relay.next();
    expect(request.kind).toBe("request");
    expect(request.tool).toBe("navigate");
    expect(request.params).toEqual({ url: "https://example.com/" });
    expect(typeof request.id).toBe("number");

    relay.send({ v: 1, kind: "response", id: request.id, ok: true, result: { tabId: 1, url: "https://example.com/", title: "Example" } });
    await expect(pending).resolves.toEqual({ tabId: 1, url: "https://example.com/", title: "Example" });
    relay.destroy();
  });

  it("rejects with the error code when the extension answers ok:false", async () => {
    const relay = new FakeRelay(hub.port);
    relay.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await relay.next();

    const pending = hub.request("click", { ref: 4 }, 3000);
    const request = await relay.next();
    relay.send({ v: 1, kind: "response", id: request.id, ok: false, error: { message: "no such ref", code: "ENO_SUCH_REF" } });

    const error = await pending.then(
      () => {
        throw new Error("expected rejection");
      },
      (e) => e,
    );
    expect(error.message).toBe("no such ref");
    expect(error.code).toBe("ENO_SUCH_REF");
    relay.destroy();
  });

  it("rejects with timeout and drops a late response", async () => {
    const relay = new FakeRelay(hub.port);
    relay.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await relay.next();

    const pending = hub.request("navigate", { url: "x" }, 50);
    const request = await relay.next();
    const error = await pending.then(
      () => {
        throw new Error("expected rejection");
      },
      (e) => e,
    );
    expect(error.code).toBe("timeout");

    // Late response for the timed-out id must be ignored (dropped, not resolved/rejected).
    relay.send({ v: 1, kind: "response", id: request.id, ok: true, result: { late: true } });
    await sleep(100);

    // The hub still works for a fresh request.
    const again = hub.request("get_browser_info", {}, 2000);
    const request2 = await relay.next();
    relay.send({ v: 1, kind: "response", id: request2.id, ok: true, result: { chromeVersion: "139" } });
    await expect(again).resolves.toEqual({ chromeVersion: "139" });
    relay.destroy();
  });

  it("rejects pending requests with extension_disconnected when the socket closes", async () => {
    const relay = new FakeRelay(hub.port);
    relay.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await relay.next();

    const pending = hub.request("wait_for", { text: "x" }, 5000);
    relay.destroy();
    const error = await pending.then(
      () => {
        throw new Error("expected rejection");
      },
      (e) => e,
    );
    expect(error.code).toBe("extension_disconnected");
  });

  it("rejects immediately with extension_not_connected when no relay is attached", async () => {
    const error = await hub.request("list_tabs", {}, 1000).then(
      () => {
        throw new Error("expected rejection");
      },
      (e) => e,
    );
    expect(error.code).toBe("extension_not_connected");
  });

  it("stores extension info from the extensionHello event", async () => {
    const relay = new FakeRelay(hub.port);
    relay.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await relay.next();
    // Authenticated relays register immediately under a synthetic instance id.
    expect(hub.extensionConnected).toBe(true);
    expect(hub.extensionInfo).toEqual({});
    expect(hub.activeInstanceId).toMatch(/^conn-\d+$/);

    relay.send({
      v: 1,
      kind: "event",
      event: "extensionHello",
      data: {
        instanceId: "inst-real",
        extensionVersion: "0.1.0",
        chromeVersion: "139.0.0.0",
        userAgent: "Mozilla/5.0 (X)",
        platform: "win32",
      },
    });
    await sleep(100);
    expect(hub.extensionConnected).toBe(true);
    expect(hub.activeInstanceId).toBe("inst-real");
    expect(hub.extensionInfo).toEqual({
      extensionVersion: "0.1.0",
      chromeVersion: "139.0.0.0",
      userAgent: "Mozilla/5.0 (X)",
      platform: "win32",
    });
    relay.destroy();
  });

  it("keeps anonymous connections as separate instances; most recent is active", async () => {
    const first = new FakeRelay(hub.port);
    first.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await first.next();

    const second = new FakeRelay(hub.port);
    second.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await second.next();

    await sleep(100);
    expect(first.closed).toBe(false); // coexist — not closed
    expect(hub.listInstances().length).toBe(2);

    const pending = hub.request("list_tabs", {}, 2000);
    const request = await second.next(); // active = most recent
    second.send({ v: 1, kind: "response", id: request.id, ok: true, result: { tabs: [] } });
    await expect(pending).resolves.toEqual({ tabs: [] });
    second.destroy();
    first.destroy();
  });

  it("coexists multiple browser instances and routes by instanceId", async () => {
    const daily = new FakeRelay(hub.port);
    daily.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await daily.next();
    daily.send({
      v: 1,
      kind: "event",
      event: "extensionHello",
      data: { instanceId: "inst-daily", chromeVersion: "152.0.0.0", platform: "Win32" },
    });

    const test = new FakeRelay(hub.port);
    test.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await test.next();
    test.send({
      v: 1,
      kind: "event",
      event: "extensionHello",
      data: { instanceId: "inst-test", chromeVersion: "152.0.0.0", platform: "Win32" },
    });
    await sleep(100);

    expect(daily.closed).toBe(false);
    expect(test.closed).toBe(false);
    expect(hub.activeInstanceId).toBe("inst-test"); // most recent wins default targeting

    const instances = hub.listInstances();
    expect(instances.map((i) => i.instanceId).sort()).toEqual(["inst-daily", "inst-test"]);

    // Explicit targeting routes to the right socket.
    const p1 = hub.request("list_tabs", {}, 2000, "inst-daily");
    const r1 = await daily.next();
    expect(daily.closed).toBe(false);
    daily.send({ v: 1, kind: "response", id: r1.id, ok: true, result: { tabs: ["daily"] } });
    await expect(p1).resolves.toEqual({ tabs: ["daily"] });

    const p2 = hub.request("list_tabs", {}, 2000, "inst-test");
    const r2 = await test.next();
    test.send({ v: 1, kind: "response", id: r2.id, ok: true, result: { tabs: ["test"] } });
    await expect(p2).resolves.toEqual({ tabs: ["test"] });

    daily.destroy();
    test.destroy();
  });

  it("drops the stale socket when the same instance reconnects", async () => {
    const first = new FakeRelay(hub.port);
    first.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await first.next();
    first.send({
      v: 1,
      kind: "event",
      event: "extensionHello",
      data: { instanceId: "inst-a", chromeVersion: "152.0.0.0" },
    });

    const second = new FakeRelay(hub.port);
    second.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await second.next();
    second.send({
      v: 1,
      kind: "event",
      event: "extensionHello",
      data: { instanceId: "inst-a", chromeVersion: "152.0.0.0" },
    });

    expect(await first.closedWithin(1500)).toBe(true); // stale socket dropped
    expect(hub.listInstances().length).toBe(1);
    expect(hub.activeInstanceId).toBe("inst-a");

    const pending = hub.request("list_tabs", {}, 2000, "inst-a");
    const request = await second.next();
    second.send({ v: 1, kind: "response", id: request.id, ok: true, result: { tabs: [] } });
    await expect(pending).resolves.toEqual({ tabs: [] });
    second.destroy();
    first.destroy();
  });

  it("falls back to the remaining instance when the active one disconnects", async () => {
    const a = new FakeRelay(hub.port);
    a.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await a.next();
    a.send({ v: 1, kind: "event", event: "extensionHello", data: { instanceId: "inst-a" } });

    const b = new FakeRelay(hub.port);
    b.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await b.next();
    b.send({ v: 1, kind: "event", event: "extensionHello", data: { instanceId: "inst-b" } });
    await sleep(100);
    expect(hub.activeInstanceId).toBe("inst-b");

    b.destroy();
    await sleep(150);
    expect(hub.activeInstanceId).toBe("inst-a");
    expect(hub.listInstances().map((i) => i.instanceId)).toEqual(["inst-a"]);

    const pending = hub.request("list_tabs", {}, 2000);
    const request = await a.next();
    a.send({ v: 1, kind: "response", id: request.id, ok: true, result: { tabs: ["a"] } });
    await expect(pending).resolves.toEqual({ tabs: ["a"] });
    a.destroy();
  });

  it("works without an extensionHello event (first tool call still routes)", async () => {
    const relay = new FakeRelay(hub.port);
    relay.send({ v: 1, kind: "hello", who: "relay", token: hub.token });
    await relay.next();
    // Registered under a synthetic id with no info until extensionHello arrives.
    expect(hub.extensionConnected).toBe(true);
    expect(hub.listInstances()).toEqual([{ instanceId: expect.stringMatching(/^conn-\d+$/) }]);

    const pending = hub.request("get_browser_info", {}, 2000);
    const request = await relay.next();
    relay.send({ v: 1, kind: "response", id: request.id, ok: true, result: { platform: "win32" } });
    await expect(pending).resolves.toEqual({ platform: "win32" });
    relay.destroy();
  });
});
