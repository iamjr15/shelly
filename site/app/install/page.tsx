import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Install",
  description:
    "Install Shelly with the npm-only desktop distribution path and run the local development flow from source.",
};

export default function InstallPage() {
  return (
    <section className="page">
      <div className="page-copy">
        <p className="eyebrow">Install</p>
        <h1>Desktop first, phone second.</h1>
        <p className="lede">
          Shelly v1 distributes the desktop CLI and daemon through npm only. Paired
          mobile apps can attach to desktop sessions, create shell-only sessions,
          and kill sessions; they cannot choose commands.
        </p>

        <h2>npm install</h2>
        <pre className="install-block"><code>npm i -g shellykit{"\n"}
shelly daemon install{"\n"}
shelly pair{"\n"}
shelly{"\n"}
shelly refactoringjob{"\n"}
shelly new --name shell bash</code></pre>
        <p>
          <code>shelly</code> with no subcommand creates and attaches a shell-backed
          session (the user&apos;s <code>$SHELL</code>) with a generated one-word name,
          even when other sessions already exist. <code>shelly refactoringjob</code>
          attaches that named session if it exists, or creates it as a shell-backed
          PTY. Mobile shows the same daemon session names in its dashboard.
        </p>

        <h2>Source build</h2>
        <pre className="install-block"><code>cargo build --workspace{"\n"}
target/debug/shelly{"\n"}
target/debug/shelly refactoringjob{"\n"}
target/debug/shelly new --name shell bash{"\n"}
target/debug/shelly ls{"\n"}
target/debug/shelly attach &lt;session-id&gt;</code></pre>

        <h2>Mobile builds</h2>
        <p>
          Android release builds are wired in CI, with Play distribution handled by
          the signed release workflow. iOS is deferred and is not part of the current
          release surface.
        </p>
      </div>
    </section>
  );
}
