# omp-sub-usage

what the hell are my subs doing

An [oh-my-pi](https://omp.sh) plugin that keeps your Claude and ChatGPT Codex subscription
limits in the footer: how much of each rolling window you have used, and when it resets.

```
 pi · [high] Fable 5.1 · ~/src/thing · ctx: 2.9%/1M
Claude 5h 42% (2h 13m) 7d 17% (3d 4h) | Codex 5h 81% (40m) 7d 23% (6d)
```

Each window reads the same as in omp's own `usage` status-line segment, which only ever shows
the provider of the model you are currently on. This shows both, all the time.

## How it gets the numbers

It asks omp. omp already logs in to Anthropic and OpenAI Codex, already fetches plan usage
from both (`/api/oauth/usage` and `wham/usage`), caches it, and updates the cache from the
rate-limit headers on every Claude and Codex response. The plugin reads that cache through
the session's `AuthStorage`, the same path `/usage` uses. So:

- no extra logins, no token files read, no second OAuth client;
- no extra load on the usage endpoints: omp decides when to hit the network (about every
  five minutes), and the plugin just re-reads the cache every minute and after each turn;
- multi-account setups show the account the session is actually using.

Works with omp 18.1 and later, including 18.3+, which moved AuthStorage onto namespaces.

It is an oh-my-pi plugin only. Upstream [pi](https://github.com/earendil-works/pi) has no
subscription-usage API to read from, so there is nothing for it to show there.

## Install

```sh
omp plugin install omp-sub-usage
```

Log in to the providers you want to see with `/login` if you have not already.

## Use

The footer line appears on its own. `/sub-usage` prints every window, including per-model
weekly caps, with absolute reset times and any saved Codex resets. `/sub-usage refresh`
throws away the cached numbers and fetches fresh ones.

```
Claude
  5h          11%  resets in 3h 14m (09:00 PM)
  7d           3%  resets in 2d 9h (Tue, Sep 29 03:00 AM)
  7d fable     0%  resets in 2d 9h (Tue, Sep 29 03:00 AM)
Codex (plus)
  7d           0%  resets in 6d 23h (Sat, Oct 3 05:45 PM)
  saved resets: 2
```

## Settings

Managed with omp's plugin config, globally or per project (`.omp/plugin-overrides.json`):

```sh
omp plugin config list omp-sub-usage
omp plugin config set omp-sub-usage display widget
```

| Setting          | Default                  | What it does                                                                                                  |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `display`        | `status`                 | `status` puts a plain line in omp's footer status area. `widget` draws a coloured line just below the editor. |
| `providers`      | `anthropic,openai-codex` | Which omp providers to show, in order.                                                                        |
| `modelLimits`    | `false`                  | Also show per-model weekly caps, such as Claude's Fable limit, in the footer.                                 |
| `refreshSeconds` | `60`                     | How often to re-read omp's usage cache (minimum 15).                                                          |

Settings are read when a session starts, so changes apply to the next session.

In `widget` mode percentages are coloured like omp's native segment: yellow from 50%, red from
80%, and red whenever the provider reports the window exhausted. The `status` area is plain
text by omp's design. Hide status lines entirely with omp's `statusLine.showHookStatus`
setting.

## Development

```sh
git clone https://github.com/ryanskidmore/omp-sub-usage
cd omp-sub-usage
bun install
omp plugin link .         # run your checkout in omp
bun run check             # lint, typecheck, unit tests, integration tests
bun run test:integration  # boots real omp in RPC mode with the plugin loaded
OMP_BIN=$(which omp) bun run test:integration   # against your installed omp
```

The integration tests run omp itself, with the plugin loaded both via `-e` and by linking
the `npm pack` tarball, so they also check that the published files are complete. Only the
upstream usage fetchers are faked (`integration/fake-usage.ts`), so everything from omp's
AuthStorage to the footer text is the real code path. CI runs them against the locked omp
version and the latest one on npm.

## Releasing

Bump `version` in `package.json`, merge to `main`, then tag and push:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The `Publish` workflow checks the tag matches the version, runs `bun run check`, publishes to
npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (no npm token lives
in the repository, and provenance is attached) and creates the GitHub release with generated
notes. Each step skips work already done, so a failed run can simply be re-run.

`npm publish` from a checkout refuses to run, so no version reaches npm without its tag and
release. `npm publish --ignore-scripts` bypasses that if CI is ever unavailable; push the tag
afterwards and the workflow creates the missing release.

npm's trusted publisher for this package is GitHub Actions, `ryanskidmore/omp-sub-usage`,
workflow `publish.yml`, with `npm publish` allowed.
