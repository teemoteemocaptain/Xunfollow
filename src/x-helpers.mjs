const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const PROFILE_FOLLOWS_YOU_STOP_LINES = new Set([
  "posts",
  "replies",
  "media",
  "likes",
  "highlights",
  "articles",
  "you might like",
  "who to follow",
  "what's happening",
  "trending",
  "terms of service",
]);

const RESERVED_PATH_SEGMENTS = new Set([
  "compose",
  "download",
  "explore",
  "hashtag",
  "home",
  "i",
  "intent",
  "jobs",
  "login",
  "messages",
  "notifications",
  "privacy",
  "search",
  "settings",
  "share",
  "signup",
  "tos",
]);

export function isLikelyHandle(value) {
  return HANDLE_PATTERN.test(String(value ?? "").trim());
}

export function extractLikelyHandleFromHref(href) {
  if (!href) {
    return null;
  }

  let url;

  try {
    url = new URL(href, "https://x.com");
  } catch {
    return null;
  }

  const [firstSegment] = url.pathname.split("/").filter(Boolean);

  if (!firstSegment || RESERVED_PATH_SEGMENTS.has(firstSegment.toLowerCase())) {
    return null;
  }

  return isLikelyHandle(firstSegment) ? firstSegment : null;
}

function scoreOwnHandleCandidate(candidate, handle) {
  const textBlob = [
    candidate.text,
    candidate.ariaLabel,
    candidate.title,
    candidate.dataTestId,
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  const normalizedHandle = handle.toLowerCase();

  let score = 0;

  if (textBlob.includes("profile")) {
    score += 10;
  }

  if (String(candidate.dataTestId ?? "").toLowerCase().includes("profile")) {
    score += 6;
  }

  if (String(candidate.ariaLabel ?? "").toLowerCase().includes(`@${normalizedHandle}`)) {
    score += 3;
  }

  if (String(candidate.text ?? "").toLowerCase().includes(`@${normalizedHandle}`)) {
    score += 2;
  }

  if (String(candidate.title ?? "").toLowerCase().includes(normalizedHandle)) {
    score += 2;
  }

  return score;
}

export function selectLikelyOwnHandleFromAnchors(candidates) {
  const ranked = candidates
    .map((candidate) => {
      const handle = extractLikelyHandleFromHref(candidate.href);

      if (!handle) {
        return null;
      }

      return {
        handle,
        score: scoreOwnHandleCandidate(candidate, handle),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.handle.localeCompare(right.handle));

  if (ranked.length === 0 || ranked[0].score <= 0) {
    return null;
  }

  return ranked[0].handle;
}

export function extractBioFromFollowingRowText(text, handle) {
  const normalizedHandle = String(handle ?? "").trim().toLowerCase();
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.toLowerCase() !== `@${normalizedHandle}`)
    .filter((line) => ![
      "following",
      "follow",
      "requested",
      "follows you",
    ].includes(line.toLowerCase()));

  if (lines.length <= 1) {
    return "";
  }

  return lines.slice(1).join(" ").trim();
}

export function extractFollowsYouFromFollowingRowText(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .includes("follows you");
}

export function extractFollowsYouFromProfileText(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);

  const focusedLines = [];

  for (const line of lines) {
    if (PROFILE_FOLLOWS_YOU_STOP_LINES.has(line)) {
      break;
    }

    focusedLines.push(line);
  }

  return focusedLines.includes("follows you");
}

export function profileTextIndicatesNoPosts(text) {
  const normalized = String(text ?? "").toLowerCase();

  return normalized.includes("hasn’t posted")
    || normalized.includes("hasn't posted")
    || normalized.includes("no posts yet")
    || /\b0 posts?\b/.test(normalized);
}

export function selectPrimaryHandleFromRow(hrefs, rowText, ownHandle) {
  const handles = [...new Set(
    hrefs
      .map((href) => extractLikelyHandleFromHref(href))
      .filter((handle) => handle && handle !== ownHandle),
  )];

  if (handles.length === 0) {
    return null;
  }

  const normalizedText = String(rowText ?? "").toLowerCase();
  const lines = normalizedText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const ranked = handles
    .map((handle, index) => {
      const normalizedHandle = handle.toLowerCase();
      let score = 0;

      if (lines.includes(`@${normalizedHandle}`)) {
        score += 10;
      }

      if (normalizedText.includes(`@${normalizedHandle}`)) {
        score += 4;
      }

      score += Math.max(0, 3 - index);

      return { handle, score };
    })
    .sort((left, right) => right.score - left.score || left.handle.localeCompare(right.handle));

  return ranked[0]?.handle ?? null;
}

function parseApiDate(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function pickFirstDefined(values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function pickLaterIsoDate(left, right) {
  const leftTimestamp = left ? new Date(left).getTime() : Number.NaN;
  const rightTimestamp = right ? new Date(right).getTime() : Number.NaN;

  if (!Number.isFinite(leftTimestamp)) {
    return Number.isFinite(rightTimestamp) ? right : null;
  }

  if (!Number.isFinite(rightTimestamp)) {
    return left;
  }

  return rightTimestamp > leftTimestamp ? right : left;
}

export function mergeUserSummary(existing, next) {
  const merged = {
    handle: next.handle,
    bioKnown: existing?.bioKnown ?? false,
    bio: existing?.bio ?? "",
    followsYouKnown: existing?.followsYouKnown ?? false,
    followsYou: existing?.followsYou ?? false,
    latestPostKnown: existing?.latestPostKnown ?? false,
    latestPostAt: existing?.latestPostAt ?? null,
  };

  if (next.bioKnown && (!merged.bioKnown || !merged.bio)) {
    merged.bioKnown = true;
    merged.bio = next.bio;
  }

  if (next.followsYouKnown) {
    merged.followsYouKnown = true;
    merged.followsYou = merged.followsYou || Boolean(next.followsYou);
  }

  if (next.latestPostKnown) {
    merged.latestPostKnown = true;
    merged.latestPostAt = pickLaterIsoDate(merged.latestPostAt, next.latestPostAt);
  }

  return merged;
}

export function extractUserSummariesFromApiPayload(payload) {
  const found = new Map();
  const stack = [payload];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }

    const handle = current.legacy?.screen_name ?? current.screen_name;

    if (isLikelyHandle(handle)) {
      const rawBio = pickFirstDefined([
        current.legacy?.description,
        current.description,
      ]);
      const rawLatestPostAt = pickFirstDefined([
        current.legacy?.status?.created_at,
        current.status?.created_at,
        current.status?.result?.legacy?.created_at,
        current.latest_tweet?.legacy?.created_at,
      ]);

      found.set(
        handle,
        mergeUserSummary(found.get(handle), {
          handle,
          bioKnown: rawBio !== undefined,
          bio: typeof rawBio === "string" ? rawBio : "",
          latestPostKnown: parseApiDate(rawLatestPostAt) !== null,
          latestPostAt: parseApiDate(rawLatestPostAt),
        }),
      );
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return Array.from(found.values());
}

export function extractHandlesFromApiPayload(payload) {
  return extractUserSummariesFromApiPayload(payload).map((summary) => summary.handle);
}
