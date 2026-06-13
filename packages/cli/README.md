# shelly

Your terminal sessions, from anywhere.

Shelly runs a real PTY on your laptop and lets paired mobile clients continue
the same terminal session without losing process state. Commands such as `bash`,
`zsh`, `vim`, `htop`, `python`, `node`, `lazygit`, `claude`, and `codex` keep
running on the host while clients attach, detach, resize, and reconnect.

## Install

```sh
npm i -g shellykit
```

The unscoped `shellykit` package is the v1 desktop install and update path. It
installs these commands:

- `shelly`: the user-facing CLI
- `shellyd`: the local daemon that owns PTYs, pairing, replay, and transport

Use npm to update installed builds:

```sh
npm update -g shellykit
```

## First Run

```sh
shelly daemon install
shelly pair
shelly
shelly refactoringjob
shelly new --name shell bash
shelly new bash
shelly attach <session-id>
shelly kill <session-id-or-name>
shelly kill-all
shelly completion bash
```

`shelly pair` starts QR pairing. Running `shelly` with no subcommand
creates and attaches a new shell-backed Shelly session every time, with a
generated one-word name like `waffle` or `kazoo` even when other sessions already
exist. From that shell the user can start Claude, exit it, start Codex, or run
any other terminal program inside the same Shelly session. Running
`shelly new bash`, `shelly new claude`, or any `new` command without `--name` keeps the
requested command and still chooses a generated one-word session name.
Running `shelly refactoringjob` attaches that named session when it exists, or
creates and attaches a shell-backed Shelly PTY named `refactoringjob` when it
does not. The same daemon session name appears in the mobile app dashboard.
Use `shelly kill <session-id-or-name>` to stop one Shelly session and `shelly kill-all`
to stop all current sessions.

`shelly --help` prints `Usage: shelly`, and `shelly completion bash` generates a
completion script for the `shelly` command.

The default desktop command is the user's shell, and arbitrary PTY commands are
supported. Mobile clients can pair, list sessions, attach, send input, resize,
detach, and register push tokens. Mobile clients cannot create or kill sessions.
The desktop CLI talks to the daemon over the local Unix socket; iroh is reserved
for paired mobile clients.

## Package Layout

This meta-package depends on exactly one platform package at install time:

- `shellykit-darwin-arm64`
- `shellykit-darwin-x64`
- `shellykit-linux-arm64`
- `shellykit-linux-x64`

When postinstall scripts are allowed, the matching platform package swaps
`bin/shelly` and `bin/shellyd` to native binaries. When scripts are
disabled, the shipped dispatchers still run the matching platform binaries. v1
Windows host support is through the Linux package inside WSL2.

Local persistence is encrypted by default with an OS-keychain-held key unless
the user explicitly opts out. Keychain prompts are only for local key material;
terminal output, keystrokes, commands, paths, session names, and push tokens are
not stored there. Shelly push payloads are privacy-preserving and do not
include terminal content, commands, paths, or session names.
