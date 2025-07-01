const HOST = "https://api.feedbin.com/v2";
const AUTH_HEADERS = {
  Authorization: `Basic ${toBase64(username + ":" + password)}`,
  "Content-Type": "application/json; charset=utf-8",
};

var lastUpdate = null;
var lastSubscriptionUpdate = null;
var feedInformation = {};

function verify() {
  sendRequest(HOST + "/authentication.json", "GET", null, AUTH_HEADERS)
    .then(() => {
      processVerification({});
    })
    .catch((requestError) => {
      processError(requestError);
    });
}

function load() {
  console.log("--- LOAD ---");
  if (lastUpdate === null) {
    lastUpdate = new Date(new Date().getTime() - 7 * 24 * 60 * 60 * 1000); // Initial fetch: Looking back to maximum 7 days.
  } else {
    lastUpdate = new Date(lastUpdate - 4 * 60 * 60 * 1000); // lastUpdate - 4 hours to update items recently interacted with in a different app
  }

  console.log(`Looking for items after ${lastUpdate}`);

  if (
    lastSubscriptionUpdate === null ||
    isOlderThanOneDay(lastSubscriptionUpdate)
  ) {
    updateSubscriptions();
    lastSubscriptionUpdate = new Date();
  }

  let requestParams = `since=${formatDateToISOWithMicroseconds(lastUpdate)}`;

  Promise.all([
    sendRequest(
      `${HOST}/starred_entries.json`,
      "GET",
      null,
      AUTH_HEADERS,
      true
    ),
    sendRequest(`${HOST}/unread_entries.json`, "GET", null, AUTH_HEADERS, true),
  ])
    .then((response) => {
      const parsedStarred = JSON.parse(response[0]);
      const parsedUnread = JSON.parse(response[1]);

      if (fetchUnreadOnly === "on") {
        requestParams += `&read=false`;
      }

      let url = HOST + `/entries.json?${requestParams}&page=1`;

      fetchAllItems(url)
        .then((newItems) => {
          let items = [];
          newItems
            .filter((feedItem) => feedItem?.url !== undefined)
            .map((feedItem) => {
              items.push(
                processNewItem(
                  feedItem,
                  JSON.parse(parsedStarred.body),
                  JSON.parse(parsedUnread.body)
                )
              );
            });
          processResults(items);
          lastUpdate = new Date();
        })
        .catch((requestError) => {
          processError(requestError);
        });
    })
    .catch((requestError) => {
      processError(requestError);
    });
}

function fetchAllItems(url, results = []) {
  return sendRequest(url, "GET", null, AUTH_HEADERS, true)
    .then((response) => {
      const parsedResponse = JSON.parse(response);
      const { headers, body, ...rest } = parsedResponse;
      const combinedResults = results.concat(...JSON.parse(body));
      const nextPageUrl = parseLinkHeader(headers?.links).next || null;

      if (nextPageUrl) {
        // Recursive call to fetch the next page
        return fetchAllItems(nextPageUrl, combinedResults);
      } else {
        // No more pages, return combined results
        return combinedResults;
      }
    })
    .catch((requestError) => {
      processError(requestError);
    });
}

function performAction(actionId, actionValue, item) {
  let actions = item.actions;

  if (actionId == "star") {
    // Mark as Starred
    sendRequest(
      HOST + `/starred_entries.json`,
      "POST",
      JSON.stringify({ starred_entries: [actionValue] }),
      AUTH_HEADERS,
      true
    )
      .then((_) => {
        delete actions["star"];
        actions["unstar"] = actionValue;

        item.actions = actions;
        actionComplete(item, null);
      })
      .catch((error) => {
        actionComplete(null, error);
      });
  } else if (actionId == "unstar") {
    // Remove Star
    sendRequest(
      HOST + `/starred_entries/delete.json`,
      "POST",
      JSON.stringify({ starred_entries: [actionValue] }),
      AUTH_HEADERS,
      true
    )
      .then((_) => {
        delete actions["unstar"];
        actions["star"] = actionValue;

        item.actions = actions;
        actionComplete(item, null);
      })
      .catch((error) => {
        actionComplete(null, error);
      });
  } else if (actionId == "read") {
    // Mark as read
    sendRequest(
      HOST + `/unread_entries.json`,
      "POST",
      JSON.stringify({ unread_entries: [actionValue] }),
      AUTH_HEADERS,
      true
    )
      .then((_) => {
        delete actions["read"];
        actions["unread"] = actionValue;

        item.actions = actions;
        actionComplete(item, null);
      })
      .catch((error) => {
        actionComplete(null, error);
      });
  } else if (actionId == "unread") {
    // Mark as unread
    sendRequest(
      HOST + `/unread_entries/delete.json`,
      "POST",
      JSON.stringify({ unread_entries: [actionValue] }),
      AUTH_HEADERS,
      true
    )
      .then((_) => {
        delete actions["unread"];
        actions["read"] = actionValue;

        item.actions = actions;
        actionComplete(item, null);
      })
      .catch((error) => {
        actionComplete(null, error);
      });
  } else {
    let error = new Error(`actionId "${actionId}" not implemented`);
    actionComplete(null, error);
  }
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
  const subscriptionInformation = JSON.parse(
    getItem(`feed-${feedItem.feed_id}`)
  );

  if (subscriptionInformation?.title) {
    let annotation = Annotation.createWithText(subscriptionInformation.title);
    if (subscriptionInformation?.icon) {
      annotation.icon = subscriptionInformation.icon;
    }

    item.annotations = [annotation];
  }

  // Actions
  let actions = {};

  if (starredEntries.includes(feedItem.id)) {
    actions["unstar"] = feedItem.id;
  } else {
    actions["star"] = feedItem.id;
  }

  if (unreadEntries.includes(feedItem.id)) {
    actions["unread"] = feedItem.id;
  } else {
    actions["read"] = feedItem.id;
  }

  item.actions = actions;
  console.log("Finish processing");
  return item;
}

function updateSubscriptions() {
  console.log(`--- UpdateSubscriptions ---`);
  const subscriptionUpdateHeaders = AUTH_HEADERS;
  let requestParams = "";
  if (lastSubscriptionUpdate !== null) {
    requestParams = `since=${formatDateToISOWithMicroseconds(
      lastSubscriptionUpdate
    )}`;
  }

  Promise.all([
    sendRequest(
      `${HOST}/icons.json?${requestParams}`,
      "GET",
      null,
      subscriptionUpdateHeaders
    ),
    sendRequest(
      `${HOST}/subscriptions.json?${requestParams}`,
      "GET",
      null,
      subscriptionUpdateHeaders
    ),
  ])
    .then((response) => {
      const parsedIcons = JSON.parse(response[0]);
      const parsedSubscriptions = JSON.parse(response[1]);
      parsedSubscriptions.map((subscription) => {
        const host = getHostname(subscription.site_url);
        console.log(`Caching ${host} [feed-${subscription.feed_id}]`);
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
    })
    .catch((requestError) => {
      processError(requestError);
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
