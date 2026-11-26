const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(`${__dirname}/../nl.upstart-it.com.feedbin/plugin.js`, "utf8");
const HOST = "https://api.feedbin.com/v2";
const entry = (id) => ({
  id,
  feed_id: 10,
  url: `https://example.com/${id}`,
  title: `Entry ${id}`,
  content: "<p>Hello</p>",
  author: "Author",
  created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
});

function connector({ storage = new Map(), unreadOnly = "off" } = {}) {
  const calls = [];
  const state = { entries: [entry(1)], unread: [1], starred: [], fail: null };
  function request(method, url, options) {
    const parsed = new URL(url);
    calls.push({ method, url, ...options });
    const response = async () => {
      if (state.fail && url.includes(state.fail)) throw new Error("HTTP 503");
      if (method === "POST" && parsed.pathname.endsWith("/unread_entries/delete.json")) {
        state.unread = state.unread.filter((id) => !options.json.unread_entries.includes(id));
      } else if (method === "POST" && parsed.pathname.endsWith("/unread_entries.json")) {
        state.unread = [...new Set([...state.unread, ...options.json.unread_entries])];
      }
      let body = [];
      let link = null;
      if (parsed.pathname.endsWith("/starred_entries.json")) body = state.starred;
      if (parsed.pathname.endsWith("/unread_entries.json")) body = state.unread;
      if (parsed.pathname.endsWith("/entries.json")) {
        body = state.entries;
        if (parsed.searchParams.get("page") === "2") body = state.nextEntries;
        else if (state.nextEntries) link = `<${HOST}/entries.json?page=2>; rel="next"`;
      }
      return {
        json: async () => body,
        headers: { get: (name) => name.toLowerCase() === "link" ? link : null },
      };
    };
    // Tapestry's pending request is not the browser fetch API.
    return {
      then: (resolve, reject) => response().then(resolve, reject),
      json: async () => (await response()).json(),
    };
  }
  const context = vm.createContext({
    username: "user",
    password: "password",
    fetchUnreadOnly: unreadOnly,
    fetch: {
      get: (url, options) => request("GET", url, options),
      post: (url, options) => request("POST", url, options),
    },
    getItem: (key) => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
    Item: {
      createWithUriDate: (uri, date) => ({ uri, date, actions: new Set() }),
      delete: (uri) => ({ deleted: true, uri }),
    },
    Identity: { createWithName: (name) => ({ name }) },
    Annotation: { createWithText: (text) => ({ text }) },
    console: { log() {}, error() {} },
  });
  vm.runInContext(source, context);
  return { context, state, calls, storage };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("targets Tapestry 2.0", () => {
  const config = JSON.parse(readFileSync(`${__dirname}/../nl.upstart-it.com.feedbin/plugin-config.json`));
  assert.equal(config.minimum_app_version, "2.0");
});

test("verification returns a result and propagates authentication errors", async () => {
  const { context, state, calls } = connector();
  assert.deepEqual(plain(await context.verify()), {});
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from("user:password").toString("base64")}`);
  state.fail = "authentication.json";
  await assert.rejects(context.verify(), /HTTP 503/);
});

test("load returns items with metadata and Set actions, following Link pagination", async () => {
  const { context, state, calls } = connector();
  state.starred = [1];
  state.nextEntries = [entry(2)];
  const items = await context.load();
  assert.equal(items.length, 2);
  assert.equal(items[0].uri, entry(1).url);
  assert.equal(items[0].body, "<p>Hello</p>");
  assert.deepEqual(plain(items[0].metadata), { id: "1" });
  assert.ok(items[0].actions.has("unstar"));
  assert.ok(items[1].actions.has("star"));
  assert.equal(calls.filter((call) => call.url.includes("/entries.json?")).length, 2);
});

test("a failed page rejects the load without advancing its checkpoint", async () => {
  const { context, state } = connector();
  await context.load();
  const previousUpdate = context.lastUpdate;
  state.nextEntries = [entry(2)];
  state.fail = "page=2";
  await assert.rejects(context.load(), /HTTP 503/);
  assert.equal(context.lastUpdate, previousUpdate);
});

for (const [action, endpoint, inverse] of [
  ["star", "starred_entries.json", "unstar"],
  ["unstar", "starred_entries/delete.json", "star"],
]) {
  test(`${action} uses v2 JSON requests and returns the updated item`, async () => {
    const { context, calls } = connector();
    const item = { metadata: { id: "1" }, actions: new Set([action]) };
    assert.equal(await context.performAction(action, item), item);
    assert.equal(calls[0].url, `${HOST}/${endpoint}`);
    assert.deepEqual(plain(calls[0].json), { starred_entries: [1] });
    assert.deepEqual([...item.actions], [inverse]);
  });
}

test("read/unread actions describe the operation, not the current state", async () => {
  const { context, state } = connector();
  state.entries = [entry(1), entry(2)];
  const items = await context.load();
  assert.ok(items[0].actions.has("read"));
  assert.ok(!items[0].actions.has("unread"));
  assert.ok(items[1].actions.has("unread"));
  assert.ok(!items[1].actions.has("read"));
});

for (const [action, endpoint, inverse] of [
  ["read", "unread_entries/delete.json", "unread"],
  ["unread", "unread_entries.json", "read"],
]) {
  test(`${action} updates Feedbin and offers the inverse action`, async () => {
    const { context, calls } = connector();
    const item = { uri: entry(1).url, metadata: { id: "1" }, actions: new Set([action]) };
    assert.equal(await context.performAction(action, item), item);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `${HOST}/${endpoint}`);
    assert.deepEqual(plain(calls[0].json), { unread_entries: [1] });
    assert.deepEqual([...item.actions], [inverse]);
  });
}

test("actions support IDs on pre-2.0 timeline items", async () => {
  const { context, calls } = connector();
  const item = { actions: new Set(["star"]) };
  await context.performAction("star", item, "42");
  assert.deepEqual(plain(calls[0].json), { starred_entries: [42] });
  assert.equal(item.metadata.id, "42");
});

test("failed actions throw without changing item state", async () => {
  const { context, state } = connector();
  state.fail = "starred_entries.json";
  const item = { metadata: { id: "1" }, actions: new Set(["star"]) };
  await assert.rejects(context.performAction("star", item), /HTTP 503/);
  assert.deepEqual([...item.actions], ["star"]);
});

test("invalid IDs and unknown actions fail without sending a request", async () => {
  const { context, calls } = connector();
  await assert.rejects(context.performAction("star", { actions: new Set() }), /entry ID/);
  await assert.rejects(context.performAction("unknown", { metadata: { id: "1" } }), /not implemented/);
  assert.equal(calls.length, 0);
});

test("mark as read removes the item on the next unread-only refresh", async () => {
  const { context, state, calls, storage } = connector({ unreadOnly: "on" });
  const [item] = await context.load();
  assert.equal(new URL(calls.find((call) => call.url.includes("/entries.json?")).url).searchParams.get("read"), "false");
  assert.equal(await context.performAction("read", item), item);
  assert.deepEqual(state.unread, []);
  state.entries = []; // Feedbin's read=false response no longer includes the item.
  assert.deepEqual(plain(await context.load()), [{ deleted: true, uri: item.uri }]);
  assert.deepEqual(JSON.parse(storage.get("entry-uris")), {});
  assert.deepEqual(plain(await context.load()), []);
});

test("external read changes remove older items even after a connector restart", async () => {
  const first = connector({ unreadOnly: "on" });
  first.state.entries = [entry(1), entry(2)];
  first.state.unread = [1, 2];
  await first.context.load();
  const restarted = connector({ unreadOnly: "on", storage: first.storage });
  restarted.state.entries = []; // Both entries have fallen outside the fetch window.
  restarted.state.unread = [2];
  assert.deepEqual(plain(await restarted.context.load()), [{ deleted: true, uri: entry(1).url }]);
  assert.deepEqual(JSON.parse(first.storage.get("entry-uris")), { 2: entry(2).url });
});

test("marking read then unread before refreshing cancels removal", async () => {
  const { context, state } = connector({ unreadOnly: "on" });
  const [item] = await context.load();
  await context.performAction("read", item);
  await context.performAction("unread", item);
  state.entries = [];
  assert.deepEqual(plain(await context.load()), []);
});

test("read actions on legacy items register their URI for refresh removal", async () => {
  const { context, state } = connector({ unreadOnly: "on" });
  const item = { uri: entry(1).url, actions: new Set(["read"]) };
  await context.performAction("read", item, "1");
  state.entries = [];
  assert.deepEqual(plain(await context.load()), [{ deleted: true, uri: item.uri }]);
});

test("all-items mode retains read entries and does not emit removals", async () => {
  const { context, state, storage } = connector();
  const [item] = await context.load();
  await context.performAction("read", item);
  const items = await context.load();
  assert.equal(items.length, 1);
  assert.equal(items[0].uri, item.uri);
  assert.ok(items[0].actions.has("unread"));
  assert.equal(items[0].deleted, undefined);
  assert.equal(storage.has("entry-uris"), false);
});

for (const failure of ["unread_entries.json", "page=2"]) {
  test(`failed ${failure} fetch preserves pending removals for retry`, async () => {
    const { context, state, storage } = connector({ unreadOnly: "on" });
    await context.load();
    const previous = storage.get("entry-uris");
    const previousUpdate = context.lastUpdate;
    state.entries = [];
    state.nextEntries = [];
    state.unread = [];
    state.fail = failure;
    await assert.rejects(context.load(), /HTTP 503/);
    assert.equal(storage.get("entry-uris"), previous);
    assert.equal(context.lastUpdate, previousUpdate);
    state.fail = null;
    assert.deepEqual(plain(await context.load()), [{ deleted: true, uri: entry(1).url }]);
  });
}

test("a failed read action leaves the item unread and tracked", async () => {
  const { context, state, storage } = connector({ unreadOnly: "on" });
  const [item] = await context.load();
  const previous = storage.get("entry-uris");
  state.fail = "unread_entries/delete.json";
  await assert.rejects(context.performAction("read", item), /HTTP 503/);
  assert.ok(item.actions.has("read"));
  assert.equal(storage.get("entry-uris"), previous);
  state.fail = null;
  const items = await context.load();
  assert.equal(items.length, 1);
  assert.equal(items[0].deleted, undefined);
});

test("read entries in a stale page produce only removals, not replacement items", async () => {
  const { context, state } = connector({ unreadOnly: "on" });
  state.unread = [];
  assert.deepEqual(plain(await context.load()), [{ deleted: true, uri: entry(1).url }]);
});

test("invalid unread snapshots cannot clear tracked items", async () => {
  const { context, state, storage } = connector({ unreadOnly: "on" });
  await context.load();
  const previous = storage.get("entry-uris");
  for (const invalid of [null, {}, "[]", ["1"]]) {
    state.unread = invalid;
    await assert.rejects(context.load(), /Invalid Feedbin unread entry list/);
    assert.equal(storage.get("entry-uris"), previous);
  }
});

test("a shared article URI stays visible while another entry is unread", async () => {
  const { context, state } = connector({ unreadOnly: "on" });
  state.entries = [entry(1), { ...entry(2), url: entry(1).url }];
  state.unread = [1, 2];
  await context.load();
  state.entries = [];
  state.unread = [2];
  assert.deepEqual(plain(await context.load()), []);
  state.unread = [];
  assert.deepEqual(plain(await context.load()), [{ deleted: true, uri: entry(1).url }]);
});

test("a rejected storage write fails visibly rather than losing removal tracking", async () => {
  const { context, storage } = connector({ unreadOnly: "on" });
  storage.set = () => {}; // Tapestry silently rejects writes when storage is full.
  await assert.rejects(context.load(), /storage is full/);
  assert.equal(context.lastUpdate, null);
});
