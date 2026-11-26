const HOST = "https://api.feedbin.com/v2";
const AUTH_HEADERS = {
  Authorization: `Basic ${toBase64(username + ":" + password)}`,
  "Content-Type": "application/json; charset=utf-8",
};

var lastUpdate = null;
var lastSubscriptionUpdate = null;
var feedInformation = {};

async function verify() {
  await fetch.get(HOST + "/authentication.json", { headers: AUTH_HEADERS });
  return {};
}

async function load() {
  const since = lastUpdate === null
    ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Initial fetch: maximum 7 days.
    : new Date(lastUpdate - 4 * 60 * 60 * 1000); // Refresh recently interacted-with items.

  if (
    lastSubscriptionUpdate === null ||
    isOlderThanOneDay(lastSubscriptionUpdate)
  ) {
    await updateSubscriptions();
    lastSubscriptionUpdate = new Date();
  }

  let requestParams = `since=${formatDateToISOWithMicroseconds(since)}`;

  // Fetch current list of starred entries
  const starred = await fetch.get(`${HOST}/starred_entries.json`, {
    headers: AUTH_HEADERS,
  }).json();

  // Fetch current list of unread entries
  const unread = await fetch.get(`${HOST}/unread_entries.json`, {
    headers: AUTH_HEADERS,
  }).json();

  if (fetchUnreadOnly === "on") {
    requestParams += `&read=false`;
  }

  let newEntries = [];
  let url = HOST + `/entries.json?${requestParams}&page=1`;

  while (url) {
    const response = await fetch.get(url, { headers: AUTH_HEADERS });
    newEntries.push(...await response.json());
    url = parseLinkHeader(response.headers.get("Link")).next || null;
  }

  const items = newEntries
    .filter((feedItem) => feedItem?.url !== undefined)
    .map((feedItem) => processNewItem(feedItem, starred, unread));

  lastUpdate = new Date();
  return items;
}

async function performAction(actionId, item, actionValue) {
  // Older timeline items carry their entry ID in actionValue instead of metadata.
  const entryId = Number(item.metadata?.id ?? actionValue);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    throw new Error("Missing or invalid Feedbin entry ID");
  }

  if (actionId == "star") {
    await fetch.post(HOST + "/starred_entries.json", {
      json: { starred_entries: [entryId] },
      headers: AUTH_HEADERS,
    });
    item.actions.delete("star");
    item.actions.add("unstar");
  } else if (actionId == "unstar") {
    await fetch.post(HOST + "/starred_entries/delete.json", {
      json: { starred_entries: [entryId] },
      headers: AUTH_HEADERS,
    });
    item.actions.delete("unstar");
    item.actions.add("star");
  } else if (actionId == "read") {
    await fetch.post(HOST + "/unread_entries/delete.json", {
      json: { unread_entries: [entryId] },
      headers: AUTH_HEADERS,
    });
    item.actions.delete("read");
    item.actions.add("unread");
  } else if (actionId == "unread") {
    await fetch.post(HOST + "/unread_entries.json", {
      json: { unread_entries: [entryId] },
      headers: AUTH_HEADERS,
    });
    item.actions.delete("unread");
    item.actions.add("read");
  } else {
    throw new Error(`actionId "${actionId}" not implemented`);
  }

  item.metadata = { ...item.metadata, id: String(entryId) };
  return item;
}

function processNewItem(feedItem, starredEntries = [], unreadEntries = []) {
  // Basic Information
  let item = Item.createWithUriDate(
    feedItem.url,
    new Date(feedItem.created_at)
  );
  item.title = feedItem?.title ?? "";

  // Text with HTML formatting that will be displayed for the post.
  // provides_attachment in the plugin config is set to false, so Tapestry is finding attachments in the HTML content.
  item.body = feedItem?.content ?? "";

  // Author
  if (feedItem?.author) {
    let identity = Identity.createWithName(feedItem.author);
    // identity.uri = feedInformation[feedItem?.feed_id]?.site_url;
    identity.username = feedItem?.author;
    item.author = identity;
  }

  // Feed Information + Icon
  const subscriptionRaw = getItem(`feed-${feedItem.feed_id}`);
  let subscriptionInformation = null;

  // Avoid JSON.parse on undefined / "undefined" / empty
  if (subscriptionRaw && subscriptionRaw !== "undefined") {
    try {
      subscriptionInformation = JSON.parse(subscriptionRaw);
    } catch (e) {
      console.error(
        "Failed to parse subscription info for feed",
        feedItem.feed_id,
        e
      );
      subscriptionInformation = null;
    }
  }

  if (subscriptionInformation?.title) {
    let annotation = Annotation.createWithText(subscriptionInformation.title);
    if (subscriptionInformation?.icon) {
      annotation.icon = subscriptionInformation.icon;
    }

    item.annotations = [annotation];
  }

  // Actions
  let actions = new Set();

  if (starredEntries.includes(feedItem.id)) {
    actions.add("unstar");
  } else {
    actions.add("star");
  }

  if (unreadEntries.includes(feedItem.id)) {
    actions.add("read");
  } else {
    actions.add("unread");
  }

  item.actions = actions;
  item.metadata = { id: String(feedItem.id) };
  console.log("Finish processing");
  return item;
}

async function updateSubscriptions() {
  const subscriptionUpdateHeaders = AUTH_HEADERS;
  let requestParams = "";
  if (lastSubscriptionUpdate !== null) {
    requestParams = `since=${formatDateToISOWithMicroseconds(
      lastSubscriptionUpdate
    )}`;
  }

  const parsedIcons = await fetch.get(`${HOST}/icons.json?${requestParams}`, {
    headers: subscriptionUpdateHeaders,
  }).json();

  const parsedSubscriptions = await fetch.get(`${HOST}/subscriptions.json?${requestParams}`, {
    headers: subscriptionUpdateHeaders,
  }).json();
  parsedSubscriptions.map((subscription) => {
    const host = getHostname(subscription.site_url);
    setItem(
      `feed-${subscription.feed_id}`,
      JSON.stringify({
        icon:
          host !== null
            ? parsedIcons.filter((icon) => icon.host === host)?.[0]?.url
            : null,
        ...subscription,
      })
    );
  });
}

function toBase64(input) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  let i = 0;

  while (i < input.length) {
    const byte1 = input.charCodeAt(i++) || 0;
    const byte2 = input.charCodeAt(i++) || 0;
    const byte3 = input.charCodeAt(i++) || 0;

    const enc1 = byte1 >> 2;
    const enc2 = ((byte1 & 3) << 4) | (byte2 >> 4);
    const enc3 = ((byte2 & 15) << 2) | (byte3 >> 6);
    const enc4 = byte3 & 63;

    if (isNaN(input.charCodeAt(i - 2))) {
      output += chars.charAt(enc1) + chars.charAt(enc2) + "==";
    } else if (isNaN(input.charCodeAt(i - 1))) {
      output +=
        chars.charAt(enc1) + chars.charAt(enc2) + chars.charAt(enc3) + "=";
    } else {
      output +=
        chars.charAt(enc1) +
        chars.charAt(enc2) +
        chars.charAt(enc3) +
        chars.charAt(enc4);
    }
  }

  return output;
}

function formatDateToISOWithMicroseconds(date) {
  const isoString = date.toISOString(); // Standard ISO string: YYYY-MM-DDTHH:mm:ss.sssZ
  const milliseconds = date.getMilliseconds().toString().padStart(3, "0"); // Ensure 3 digits for ms
  const microseconds = `${milliseconds}000`; // Simulate microseconds by adding three zeros

  return isoString.replace(/\.\d{3}Z$/, `.${microseconds}Z`);
}

function isOlderThanOneDay(date) {
  const now = new Date();
  const oneDayInMilliseconds = 24 * 60 * 60 * 1000;

  return now.getTime() - date.getTime() > oneDayInMilliseconds;
}

function getHostname(url) {
  const matches = url.match(/^(?:https?:\/\/)?([^\/:?#]+)(?:[\/:?#]|$)/i);
  return matches && matches[1];
}

function parseLinkHeader(header) {
  if (!header || header.length === 0) return {};

  const parts = header.split(",");
  const links = {};

  parts.forEach((part) => {
    const section = part.split(";");
    if (section.length !== 2) return;

    const url = section[0].trim().replace(/^<|>$/g, "");
    const rel = section[1].trim().replace(/^rel="|"$/g, "");
    links[rel] = url;
  });

  return links;
}
