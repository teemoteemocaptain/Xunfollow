import test from "node:test";
import assert from "node:assert/strict";
import {
  extractBioFromFollowingRowText,
  extractFollowsYouFromFollowingRowText,
  extractFollowsYouFromProfileText,
  extractHandlesFromApiPayload,
  extractLikelyHandleFromHref,
  extractUserSummariesFromApiPayload,
  isLikelyHandle,
  profileTextIndicatesNoPosts,
  selectPrimaryHandleFromRow,
  selectLikelyOwnHandleFromAnchors,
} from "../src/x-helpers.mjs";

test("isLikelyHandle follows X handle rules", () => {
  assert.equal(isLikelyHandle("valid_name"), true);
  assert.equal(isLikelyHandle("too-long-for-x-handle"), false);
  assert.equal(isLikelyHandle("invalid.name"), false);
});

test("extractLikelyHandleFromHref ignores reserved routes", () => {
  assert.equal(extractLikelyHandleFromHref("/home"), null);
  assert.equal(extractLikelyHandleFromHref("https://x.com/i/flow/login"), null);
});

test("extractLikelyHandleFromHref returns the first path handle", () => {
  assert.equal(extractLikelyHandleFromHref("/jack"), "jack");
  assert.equal(extractLikelyHandleFromHref("https://x.com/jack/status/20"), "jack");
});

test("selectLikelyOwnHandleFromAnchors prefers profile-like anchors", () => {
  const candidates = [
    {
      href: "/somebody",
      text: "Somebody else",
      ariaLabel: null,
      title: null,
      dataTestId: null,
    },
    {
      href: "/myhandle",
      text: "Profile @myhandle",
      ariaLabel: "Profile",
      title: "@myhandle",
      dataTestId: "SideNav_AccountSwitcher_Button",
    },
  ];

  assert.equal(selectLikelyOwnHandleFromAnchors(candidates), "myhandle");
});

test("extractBioFromFollowingRowText removes the name, handle, and button text", () => {
  const text = [
    "Kapil",
    "@kapsology",
    "Following",
    "Design | Technology | Artificial Intelligence",
  ].join("\n");

  assert.equal(
    extractBioFromFollowingRowText(text, "kapsology"),
    "Design | Technology | Artificial Intelligence",
  );
});

test("extractFollowsYouFromFollowingRowText detects mutual follow labels", () => {
  const rowText = [
    "Kapil",
    "@kapsology",
    "Follows you",
    "Following",
    "Design | Technology",
  ].join("\n");

  assert.equal(extractFollowsYouFromFollowingRowText(rowText), true);
  assert.equal(extractFollowsYouFromFollowingRowText("Builder\n@alpha\nFollowing"), false);
});

test("extractFollowsYouFromProfileText detects a real profile mutual badge", () => {
  const profileText = [
    "YAPYO",
    "@yapyo_arb",
    "Mindshare flywheel",
    "Follows you",
    "Joined May 2025",
    "Posts",
    "Replies",
  ].join("\n");

  assert.equal(extractFollowsYouFromProfileText(profileText), true);
});

test("extractFollowsYouFromProfileText ignores right-rail follows-you badges", () => {
  const profileText = [
    "YAPYO",
    "@yapyo_arb",
    "Mindshare flywheel",
    "Joined May 2025",
    "Posts",
    "Replies",
    "You might like",
    "orDNAs",
    "Follows you",
  ].join("\n");

  assert.equal(extractFollowsYouFromProfileText(profileText), false);
});

test("profileTextIndicatesNoPosts detects a zero-post profile header", () => {
  const profileText = [
    "Mardell G.",
    "0 posts",
    "@godwins_33",
    "Coffee addict. Credit Analyst. Adventure Travel enthusiast.",
  ].join("\n");

  assert.equal(profileTextIndicatesNoPosts(profileText), true);
});

test("selectPrimaryHandleFromRow prefers the row's own @handle over bio mentions", () => {
  const hrefs = ["/whop", "/cultured", "/someone"];
  const rowText = [
    "Steven Schwartz",
    "@cultured",
    "Following",
    "Co-Founder / CEO @whop",
  ].join("\n");

  assert.equal(selectPrimaryHandleFromRow(hrefs, rowText, "exampleuser"), "cultured");
});

test("extractHandlesFromApiPayload finds screen names recursively", () => {
  const payload = {
    data: {
      user: {
        result: {
          legacy: {
            screen_name: "alpha_user",
          },
        },
      },
      timeline: [
        {
          screen_name: "beta_user",
        },
      ],
    },
  };

  assert.deepEqual(
    extractHandlesFromApiPayload(payload).sort(),
    ["alpha_user", "beta_user"],
  );
});

test("extractUserSummariesFromApiPayload keeps bio and latest post hints", () => {
  const payload = {
    data: {
      user: {
        result: {
          legacy: {
            screen_name: "alpha_user",
            description: "Community manager",
            status: {
              created_at: "Mon Mar 30 03:39:30 +0000 2026",
            },
          },
        },
      },
    },
  };

  assert.deepEqual(extractUserSummariesFromApiPayload(payload), [
    {
      handle: "alpha_user",
      bioKnown: true,
      bio: "Community manager",
      followsYouKnown: false,
      followsYou: false,
      latestPostKnown: true,
      latestPostAt: "2026-03-30T03:39:30.000Z",
    },
  ]);
});

test("extractUserSummariesFromApiPayload merges repeated user nodes", () => {
  const payload = {
    nodes: [
      {
        legacy: {
          screen_name: "alpha_user",
          description: "Builder",
        },
      },
      {
        screen_name: "alpha_user",
        status: {
          result: {
            legacy: {
              created_at: "Sun Mar 29 01:00:00 +0000 2026",
            },
          },
        },
      },
    ],
  };

  assert.deepEqual(extractUserSummariesFromApiPayload(payload), [
    {
      handle: "alpha_user",
      bioKnown: true,
      bio: "Builder",
      followsYouKnown: false,
      followsYou: false,
      latestPostKnown: true,
      latestPostAt: "2026-03-29T01:00:00.000Z",
    },
  ]);
});
