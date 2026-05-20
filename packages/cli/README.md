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
installs both commands:

- `fieldwork`: the user-facing CLI
- `fieldworkd`: the local daemon that owns PTYs, pairing, replay, and transport

Use npm to update installed builds:

```sh
npm update -g fieldwork
```

## First Run

```sh
fieldwork daemon install
fieldwork pair
fieldwork new bash
fieldwork attach <session-id>
```

The default desktop command can be `claude`, but arbitrary PTY commands are
supported. Mobile clients can pair, list sessions, attach, send input, resize,
detach, and register push tokens. Mobile clients cannot create or kill sessions.

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
the user explicitly opts out. Fieldwork push payloads are privacy-preserving and
do not include terminal content, commands, paths, or session names.
