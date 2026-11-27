# TabDesk

A desktop workspace for AI coding agents and terminals. Every project gets a
tab with its own real terminal — Claude Code, Codex, Gemini CLI, opencode,
Aider, Cursor Agent or a plain shell — with the tab rail on the left, the
active project on the right, and the rail telling you which session is working
and which one wants you.

**Site and documentation: <https://tabdesk.thern.io>**

## Install

Linux (Debian/Ubuntu), from the signed apt repository:

```sh
curl -fsSL https://cdn.thern.io/tabdesk/install.sh | sudo bash
```

Updates then arrive with `apt upgrade`. The full instructions, including how
to check the signing key by hand and a tarball for other distributions, are at
<https://cdn.thern.io/tabdesk/install.html>.

macOS and Windows builds are **beta**: unsigned, without self-update, and not
yet much used. They are attached to each [release](../../releases), with
SHA-256 checksums.

## This repository

This repository carries releases only. The source is not published here yet;
TabDesk is MIT licensed (see [LICENSE](LICENSE)).

Bugs and feedback: use *Bugs & Feedback* inside the app, or write to
info@thern.io.
