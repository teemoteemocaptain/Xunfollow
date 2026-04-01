export const DEFAULT_KEYWORDS = [
  "cm",
  "mod",
  "kol",
  "community manager",
  "community moderator",
  "moderator",
  "alpha hunter",
  "alpha caller",
  "caller",
];

export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function subtractMonths(date, months) {
  const source = new Date(date);
  const year = source.getFullYear();
  const month = source.getMonth() - months;
  const day = source.getDate();
  const hour = source.getHours();
  const minute = source.getMinutes();
  const second = source.getSeconds();
  const millisecond = source.getMilliseconds();

  const target = new Date(year, month, 1, hour, minute, second, millisecond);
  const lastDayOfMonth = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
  ).getDate();

  target.setDate(Math.min(day, lastDayOfMonth));
  return target;
}

export function daysBetween(olderDate, newerDate) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((newerDate - olderDate) / millisecondsPerDay);
}

export function findKeywordMatches(bio, keywords = DEFAULT_KEYWORDS) {
  const normalizedBio = normalizeText(bio);
  const normalizedKeywords = [...new Set(
    keywords
      .map((keyword) => normalizeText(keyword))
      .filter(Boolean),
  )];

  const matchedKeywords = normalizedKeywords
    .filter((keyword) => {
      if (!keyword.includes(" ")) {
        const tokenRegex = new RegExp(
          `(^|[^a-z0-9])${escapeRegExp(keyword)}($|[^a-z0-9])`,
          "i",
        );
        return tokenRegex.test(normalizedBio);
      }

      return normalizedBio.includes(keyword);
    });

  return matchedKeywords.filter((keyword) => {
    return !matchedKeywords.some(
      (otherKeyword) =>
        otherKeyword !== keyword &&
        otherKeyword.length > keyword.length &&
        new RegExp(`(^|\\s)${escapeRegExp(keyword)}($|\\s)`, "i").test(otherKeyword),
    );
  });
}

export function evaluateAccount({
  bio,
  followsYou = false,
  latestPostAt,
  hasNoPublicPosts = false,
  keepMutuals = true,
  allowlisted = false,
  now = new Date(),
  inactiveMonths = 2,
  keywords = DEFAULT_KEYWORDS,
}) {
  const keywordMatches = findKeywordMatches(bio, keywords);
  const cutoffDate = subtractMonths(now, inactiveMonths);
  const latestPostDate = latestPostAt ? new Date(latestPostAt) : null;
  const latestPostTimestamp = latestPostDate?.getTime();
  const hasKnownActivity = Number.isFinite(latestPostTimestamp);
  const inactiveMatch = hasNoPublicPosts || (hasKnownActivity ? latestPostDate < cutoffDate : false);
  const ageDays = hasKnownActivity ? daysBetween(latestPostDate, now) : null;

  return {
    followsYou: Boolean(followsYou),
    keepMutuals: Boolean(keepMutuals),
    allowlisted: Boolean(allowlisted),
    keywordMatches,
    hasNoPublicPosts: Boolean(hasNoPublicPosts),
    inactiveMatch,
    shouldUnfollow: !allowlisted && !(keepMutuals && followsYou) && (keywordMatches.length > 0 || inactiveMatch),
    hasKnownActivity,
    latestPostAt: hasKnownActivity ? latestPostDate.toISOString() : null,
    cutoffDate: cutoffDate.toISOString(),
    ageDays,
  };
}
