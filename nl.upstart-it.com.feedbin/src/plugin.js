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

async function load() {
  if (lastUpdate === null) {
    lastUpdate = new Date(new Date().getTime() - 7 * 24 * 60 * 60 * 1000); // Initial fetch: Looking back to maximum 7 days.
  }

  if (
    lastSubscriptionUpdate === null ||
    isOlderThanOneDay(lastSubscriptionUpdate)
  ) {
    await updateSubscriptions();
    lastSubscriptionUpdate = new Date();
  }

  let requestHeaders = AUTH_HEADERS;
  let requestParams = `since=${formatDateToISOWithMicroseconds(lastUpdate)}`;

  if (fetchUnreadOnly === "on") {
    requestParams += `&read=false`;
  }

  // Feedbin is providing pagination information via response headers, which we don't have access to.
  // The current implemention is therefore querying pages for as long as the API returns an error (which is usually HTTP 404) indicating that this page doesn't exist anymore.
  let more = true;
  let page = 0;
  let newEntries = [];

  while (more) {
    page += 1;

    try {
      let entries = await sendRequest(
        HOST + `/entries.json?${requestParams}&page=${page}`,
        "GET",
        null,
        requestHeaders
      );
      newEntries.push(...JSON.parse(entries));
    } catch (error) {
      more = false;
    }
  }

  let items = [];
  newEntries
    .filter((feedItem) => feedItem?.url !== undefined)
    .map((feedItem) => {
      items.push(processNewItem(feedItem));
    });
  processResults(items);

  lastUpdate = new Date();
}

function processNewItem(feedItem) {
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

  const icons = await sendRequest(
    `${HOST}/icons.json?${requestParams}`,
    "GET",
    null,
    subscriptionUpdateHeaders
  );
  const parsedIcons = JSON.parse(icons);

  const subscriptions = await sendRequest(
    `${HOST}/subscriptions.json?${requestParams}`,
    "GET",
    null,
    subscriptionUpdateHeaders
  );
  const parsedSubscriptions = JSON.parse(subscriptions);
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
