import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAccount, findKeywordMatches, subtractMonths } from "../src/rules.mjs";

test("findKeywordMatches treats cm as a standalone token", () => {
  assert.deepEqual(findKeywordMatches("Builder | CM | markets"), ["cm"]);
  assert.deepEqual(findKeywordMatches("community lead at Acme"), []);
});

test("findKeywordMatches keeps short tokens strict", () => {
  assert.deepEqual(findKeywordMatches("Builder | MOD | markets"), ["mod"]);
  assert.deepEqual(findKeywordMatches("modern builder"), []);
});

test("findKeywordMatches uses word boundaries for explicit single-word role labels", () => {
  assert.deepEqual(findKeywordMatches("Researcher | caller"), ["caller"]);
  assert.deepEqual(findKeywordMatches("alphabet soup"), []);
});

test("findKeywordMatches catches longer phrases case-insensitively", () => {
  assert.deepEqual(
    findKeywordMatches("Part-time Community Moderator and writer"),
    ["community moderator"],
  );
  assert.deepEqual(
    findKeywordMatches("Community Manager"),
    ["community manager"],
  );
});

test("findKeywordMatches prefers the more specific phrase when keywords overlap", () => {
  assert.deepEqual(findKeywordMatches("alpha caller"), ["alpha caller"]);
  assert.deepEqual(findKeywordMatches("community moderator"), ["community moderator"]);
});

test("findKeywordMatches ignores generic market words that caused false positives", () => {
  assert.deepEqual(
    findKeywordMatches("Macro & digital asset research. Cross-market signal verification."),
    [],
  );
  assert.deepEqual(findKeywordMatches("Follow for alpha and airdrops"), []);
});

test("subtractMonths keeps the last valid day in shorter months", () => {
  const result = subtractMonths(new Date("2026-03-31T10:00:00.000Z"), 1);
  assert.equal(result.toISOString(), "2026-02-28T10:00:00.000Z");
});

test("evaluateAccount marks old activity as inactive", () => {
  const now = new Date("2026-03-30T00:00:00.000Z");
  const evaluation = evaluateAccount({
    bio: "Researcher",
    latestPostAt: "2025-12-20T00:00:00.000Z",
    now,
    inactiveMonths: 2,
  });

  assert.equal(evaluation.inactiveMatch, true);
  assert.equal(evaluation.shouldUnfollow, true);
});

test("evaluateAccount leaves unknown activity as review-only unless keywords match", () => {
  const evaluation = evaluateAccount({
    bio: "Long-form writer",
    latestPostAt: null,
  });

  assert.equal(evaluation.hasKnownActivity, false);
  assert.equal(evaluation.shouldUnfollow, false);
});

test("evaluateAccount ignores invalid activity dates", () => {
  const evaluation = evaluateAccount({
    bio: "Analyst",
    latestPostAt: "not-a-date",
  });

  assert.equal(evaluation.hasKnownActivity, false);
  assert.equal(evaluation.inactiveMatch, false);
  assert.equal(evaluation.shouldUnfollow, false);
});

test("evaluateAccount matches expanded default keywords without treating unknown activity as inactive", () => {
  const evaluation = evaluateAccount({
    bio: "KOL | alpha caller",
    latestPostAt: null,
  });

  assert.equal(evaluation.hasKnownActivity, false);
  assert.deepEqual(evaluation.keywordMatches, ["kol", "alpha caller"]);
  assert.equal(evaluation.inactiveMatch, false);
  assert.equal(evaluation.shouldUnfollow, true);
});

test("evaluateAccount keeps mutuals even when other rules match", () => {
  const evaluation = evaluateAccount({
    bio: "CM | alpha caller",
    followsYou: true,
    latestPostAt: "2025-12-20T00:00:00.000Z",
    now: new Date("2026-03-30T00:00:00.000Z"),
    inactiveMonths: 2,
  });

  assert.equal(evaluation.followsYou, true);
  assert.deepEqual(evaluation.keywordMatches, ["cm", "alpha caller"]);
  assert.equal(evaluation.inactiveMatch, true);
  assert.equal(evaluation.shouldUnfollow, false);
});

test("evaluateAccount can disable the mutual-follow safeguard", () => {
  const evaluation = evaluateAccount({
    bio: "CM",
    followsYou: true,
    keepMutuals: false,
  });

  assert.equal(evaluation.followsYou, true);
  assert.equal(evaluation.keepMutuals, false);
  assert.equal(evaluation.shouldUnfollow, true);
});

test("evaluateAccount respects the allowlist", () => {
  const evaluation = evaluateAccount({
    bio: "CM",
    allowlisted: true,
  });

  assert.equal(evaluation.allowlisted, true);
  assert.equal(evaluation.shouldUnfollow, false);
});

test("evaluateAccount treats confirmed no-post profiles as inactive", () => {
  const evaluation = evaluateAccount({
    bio: "Researcher",
    latestPostAt: null,
    hasNoPublicPosts: true,
  });

  assert.equal(evaluation.hasKnownActivity, false);
  assert.equal(evaluation.hasNoPublicPosts, true);
  assert.equal(evaluation.inactiveMatch, true);
  assert.equal(evaluation.shouldUnfollow, true);
});
