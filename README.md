# X Unfollow Tool

Small local CLI that scans the accounts you follow on X and flags or unfollows them based on a configurable policy.

Out of the box, the example policy removes accounts when either of these match:

- the bio contains explicit role keywords like `CM`, `mod`, `KOL`, `community manager`, `community moderator`, `alpha hunter`, or `alpha caller`
- the latest visible post is older than 2 months

The tool prefers your installed Chrome or Edge for sign-in, then saves a separate reusable Playwright session under `.x-session/`.

## What it does

1. Opens X in a real browser when possible, falling back to Playwright Chromium.
2. Reuses the tool's own saved session from `.x-session/`.
3. Loads your `Following` list and collects accounts.
4. Checks each profile bio and latest visible post date.
5. Writes a JSON report to `reports/`.
6. Only unfollows when you pass `--apply`.
7. Reuses bio and recent-post hints from X's own following responses to speed up larger dry runs.

## Setup

```bash
npm install
npm run setup:browser
```

Optional: create your own policy file from the example:

```bash
cp x-unfollow.config.example.json x-unfollow.config.json
```

Then edit `x-unfollow.config.json` to match your own preferences.

## First run

Run in headed mode so you can sign in manually:

```bash
npm start -- --headed
```

That first run is a fast dry run. It will inspect up to 100 accounts, avoid slow full-profile lookups when X's following feed data is incomplete, and save a report under `reports/`.

Important: this does not reuse the login from your normal Chrome profile automatically. You need to sign in once inside the browser window opened by the tool. After that, the saved session in `.x-session/` is reused on later runs.

If X loads but the tool still cannot infer your own username from the page chrome, pass it explicitly with `--handle your_username`.

## Actually unfollow matches

```bash
npm start -- --headed --apply
```

If X is difficult about login in the bundled browser, force real Chrome explicitly:

```bash
npm start -- --headed --browser chrome
```

## Useful options

```bash
npm start -- --headed --limit 200 --apply
npm start -- --headed --deep-scan --limit 200
npm start -- --inactive-months 3 --apply
npm start -- --keywords "cm,mod,kol,community manager,community moderator,alpha hunter,alpha caller" --apply
npm start -- --headed --handle your_username --limit 200
npm start -- --headed --browser chrome --login-timeout-ms 900000
npm start -- --headed --browser chrome --limit 1000 --max-scrolls 200
npm start -- --config x-unfollow.config.json --headed --deep-scan --apply
```

## Config file

The tool looks for `x-unfollow.config.json` in the project root by default, or you can pass `--config path/to/file.json`.

Example:

```json
{
  "defaults": {
    "inactiveMonths": 2
  },
  "policy": {
    "keepMutuals": true,
    "treatNoPublicPostsAsInactive": true,
    "treatHiddenProfilesAsInactive": true,
    "keywords": [
      "cm",
      "mod",
      "kol",
      "community manager",
      "community moderator",
      "moderator",
      "alpha hunter",
      "alpha caller",
      "caller"
    ],
    "allowlistHandles": [
      "jack"
    ]
  }
}
```

Supported policy options:

- `keywords`: bio keywords that count as a match
- `inactiveMonths`: inactivity threshold
- `keepMutuals`: keep accounts that follow you back
- `treatNoPublicPostsAsInactive`: treat visible `0 posts` profiles as removable
- `treatHiddenProfilesAsInactive`: treat profiles that never expose a visible post date as removable
- `allowlistHandles`: handles that should always be kept

The config file does not overwrite [src/rules.mjs](/Users/agentsandbox/Documents/New%20project/src/rules.mjs). That file still defines the built-in defaults and evaluation logic; your config file only overrides those defaults at runtime for the current run.

CLI flags like `--inactive-months` and `--keywords` still override the config file.

## Notes

- Example of a larger real-world run:

```bash
npm start -- --headed --browser chrome --handle Capcaptainteemo --deep-scan --apply --resume --limit 3650 --collect-batch-size 100 --recovery-cooldown-ms 60000
```

In that example:

- `--limit 3650` means the run is allowed to work through up to 3650 followed accounts in total
- `--collect-batch-size 100` means the tool collects around 100 more handles at a time before returning to profile checks
- `--recovery-cooldown-ms` is part of the recovery behavior; if you are not actively tuning recovery, it is usually best to leave it alone

- The inactivity rule only triggers when a visible post date is available on the profile timeline.
- Depending on config, hidden or no-post profiles can also count as removable.
- Fast dry runs on large follow lists reuse data from the following feed and skip expensive profile lookups when information is incomplete. Use `--deep-scan` for a more exhaustive dry run.
- If the browser window crashes or gets closed mid-run, the tool will try to reopen the saved session once and continue. The report includes `runDiagnostics.sessionRecoveries`.
- The saved session belongs to this tool's `.x-session/` directory, not your regular browser profile.
- X changes its UI often, so selectors may need small updates over time.
- Start with dry-run mode and review the report before enabling `--apply`.
