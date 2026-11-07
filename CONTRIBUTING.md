# Contributing to Patchvia DNS

> **Pull requests are not being accepted yet.** For now, please open an
> [issue](https://github.com/patchvia/patchvia/issues): a bug report, an idea or a question. This page will say when pull
> requests are welcome. The rest of it describes how contributions will work.

Patchvia DNS is licensed under the [Apache License 2.0](LICENSE). Contributions are accepted under the same license, and
you keep the copyright on what you write.

## Sign your commits (DCO)

Every commit needs a `Signed-off-by:` line with your real name and an address you can be reached at:

```sh
git commit -s -m "Fix the thing"
```

By adding it you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/), which says that
you wrote the change or have the right to submit it under the project's license, and that the record of your
contribution is kept and may be redistributed under that license.

A pull request fails its DCO check until every commit has a sign-off. To add one to commits you have already made:
`git rebase --signoff main`, then push with `--force-with-lease`.

## Before you open a pull request

Each folder is its own project; see its README for how to run its tests. Keep a change focused, add a test for a fix,
and add a line to `CHANGELOG.md` for anything a user would notice.

## The name

The Apache license does not give anyone the right to use the Patchvia name or logo. You are welcome to say that your
work is based on, compatible with or a fork of Patchvia DNS. Please do not name a product or service in a way that
suggests it is the official one.

## Writing about other tools

Patchvia DNS is one tool among many. In the docs, the README and anywhere else we write:

- **Describe what Patchvia DNS does, not what it replaces or beats.** No "replaces X", "alternative to X", "better than
  X" or feature-by-feature scorecards.
- **Help people who come from another server with a "Coming from X?" page** under `docs/migration/`. The
  [PowerDNS page](docs/migration/from-powerdns.md) is the first one.
- **Name other tools plainly and only to be useful**: their real name, spelled as they spell it, with nothing implied
  about endorsement or affiliation. State only what you can verify, and say what you checked against.
- **Be kind about them.** Many are small open-source projects with people behind them.
