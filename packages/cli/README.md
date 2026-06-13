# fieldwork

Your terminal sessions, from anywhere.

Fieldwork runs a real PTY on your laptop and lets paired mobile clients continue
the same terminal session without losing process state. Commands such as `bash`,
`zsh`, `vim`, `htop`, `python`, `node`, `lazygit`, `claude`, and `codex` keep
running on the host while clients attach, detach, resize, and reconnect.

## Install

```sh
npm i -g fieldwork
```

The unscoped `fieldwork` package is the v1 desktop install and update path. It
installs these commands:

- `fieldwork`: the user-facing CLI
- `fw`: a shorter alias for the same user-facing CLI
- `fieldworkd`: the local daemon that owns PTYs, pairing, replay, and transport

Use npm to update installed builds:

```sh
npm update -g fieldwork
```

## First Run

```sh
fw daemon install
fw pair
fw
fw refactoringjob
fw new --name shell bash
fw new bash
fw attach <session-id>
fw kill <session-id-or-name>
fw kill-all
fw completion bash
```

The shorter `fw` alias accepts the same arguments as `fieldwork`: `fw pair` is
the short QR-pairing command, and `fw new bash`, `fw attach <session-id>`,
`fw kill <session-id-or-name>`, and `fw kill-all` are equivalent to the longer
forms. Running `fieldwork` or `fw` with no subcommand
creates and attaches a new shell-backed Fieldwork session every time, with a
generated one-word name like `waffle` or `kazoo` even when other sessions already
exist. From that shell the user can start Claude, exit it, start Codex, or run
any other terminal program inside the same Fieldwork session. Running
`fw new bash`, `fw new claude`, or any `new` command without `--name` keeps the
requested command and still chooses a generated one-word session name.
Running `fw refactoringjob` attaches that named session when it exists, or
creates and attaches a shell-backed Fieldwork PTY named `refactoringjob` when it
does not. The same daemon session name appears in the mobile app dashboard.
Use `fw kill <session-id-or-name>` to stop one Fieldwork session and `fw kill-all`
to stop all current sessions.

Help and shell completions follow the command used to invoke them. `fw --help`
prints `Usage: fw`, `fw completion bash` registers the short alias, and
`fieldwork completion bash` registers the long command.

The default desktop command is the user's shell, and arbitrary PTY commands are
supported. Mobile clients can pair, list sessions, attach, send input, resize,
detach, and register push tokens. Mobile clients cannot create or kill sessions.
The desktop CLI talks to the daemon over the local Unix socket; iroh is reserved
for paired mobile clients.

## Package Layout

This meta-package depends on exactly one platform package at install time:

- `fieldwork-darwin-arm64`
- `fieldwork-darwin-x64`
- `fieldwork-linux-arm64`
- `fieldwork-linux-x64`

When postinstall scripts are allowed, the matching platform package swaps
`bin/fieldwork` and `bin/fieldworkd` to native binaries. When scripts are
disabled, the shipped dispatchers still run the matching platform binaries. v1
Windows host support is through the Linux package inside WSL2.

Local persistence is encrypted by default with an OS-keychain-held key unless
the user explicitly opts out. Keychain prompts are only for local key material;
terminal output, keystrokes, commands, paths, session names, and push tokens are
not stored there. Fieldwork push payloads are privacy-preserving and do not
include terminal content, commands, paths, or session names.
