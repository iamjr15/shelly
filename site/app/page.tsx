import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Shelly",
  description:
    "Open-source terminal handoff for any CLI: keep one PTY session alive on your computer and continue it from Android.",
};

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">Universal terminal handoff</p>
          <h1>Shelly</h1>
          <p className="lede">
            Run any CLI on your computer, leave the desk, and attach to that same live PTY
            session from Android. Shells, TUIs, REPLs, Claude Code, and Codex all keep their
            state in one daemon-owned session.
          </p>
          <div className="actions">
            <Link className="button primary" href="/install/">Install desktop CLI</Link>
            <Link className="button" href="/architecture/">Read architecture</Link>
          </div>
        </div>

        <div className="terminal-scene" aria-label="Shelly session handoff preview">
          <div className="terminal-window">
            <div className="terminal-bar" aria-hidden="true"><span /><span /><span /></div>
            <pre className="terminal-body"><code><span className="prompt">$</span> shelly new --dir ~/projects/api claude{"\n"}
created 018f1e...  claude · api{"\n\n"}
<span className="prompt">$</span> shelly ls{"\n"}
SESSION                         STATUS{"\n"}
claude · api                    Working{"\n"}
bash · shelly                   Idle{"\n"}
vim · docs                      Attached{"\n\n"}
<span className="dim">phone attached over iroh</span>{"\n"}
Claude is waiting for input.{"\n"}
Continue with the release notes?{"\n\n"}
<span className="prompt">$</span> y</code></pre>
          </div>

          <div className="phone-window">
            <h2>Sessions</h2>
            <div className="session-row"><strong>claude · api</strong><span>Awaiting input</span></div>
            <div className="session-row"><strong>bash · shelly</strong><span>Idle</span></div>
            <div className="session-row"><strong>vim · docs</strong><span>Attached</span></div>
          </div>
        </div>
      </section>

      <section className="band light">
        <div className="split">
          <div>
            <p className="eyebrow">What ships in v1</p>
            <h2>One daemon. Many views. Raw PTY bytes.</h2>
          </div>
          <div className="grid">
            <article className="tile">
              <h3>Arbitrary commands</h3>
              <p><code>bash</code>, <code>zsh</code>, <code>vim</code>, <code>htop</code>, <code>python</code>, <code>node</code>, <code>lazygit</code>, <code>claude</code>, and <code>codex</code> run as normal PTYs.</p>
            </article>
            <article className="tile">
              <h3>Warm reconnect</h3>
              <p>Clients replay from a byte offset when possible and fall back to a synthetic ANSI snapshot when stale.</p>
            </article>
            <article className="tile">
              <h3>Agent-aware push</h3>
              <p>Claude Code and Codex get first-class waiting-for-input state; unknown CLIs still hand off cleanly.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="split">
          <div>
            <p className="eyebrow">Flow</p>
            <h2>Pair once, then attach anywhere.</h2>
          </div>
          <ol className="flow">
            <li><span>Install <code>shelly</code>, then start the user daemon.</span></li>
            <li><span>Run <code>shelly pair</code>, scan the QR code, and approve the device on your computer.</span></li>
            <li><span>Create sessions from the computer or phone. Mobile can list, create shell-only sessions, kill, attach, send input, resize, detach, and register push tokens.</span></li>
            <li><span>Push payloads contain only fixed text and opaque hashes; terminal content is fetched over the paired iroh channel after unlock.</span></li>
          </ol>
        </div>
      </section>

      <section className="band light">
        <div className="split">
          <div className="page-copy">
            <p className="eyebrow">Product surfaces</p>
            <h2>Desktop install, explicit pairing, live mobile terminal.</h2>
            <p>These source-controlled captures mirror the v1 flows used in local smoke tests and release documentation.</p>
          </div>
          <div className="doc-list">
            <Image className="shot" src="/media/shelly-cli-flow.svg" width={1280} height={720} alt="Shelly CLI install and session list" />
            <Image className="shot" src="/media/shelly-pairing.svg" width={1280} height={720} alt="Shelly QR pairing with desktop approval" />
            <Image className="shot" src="/media/shelly-mobile-session.svg" width={1280} height={720} alt="Shelly mobile sessions and terminal attach" />
          </div>
        </div>
      </section>

      <section className="band">
        <div className="split">
          <div>
            <p className="eyebrow">Docs</p>
            <h2>Security and protocol details are public.</h2>
          </div>
          <div className="grid">
            <Link className="tile" href="/protocol/"><h3>Protocol</h3><p>Contract version, framing, attach/replay, pairing, and push registration.</p></Link>
            <Link className="tile" href="/architecture/"><h3>Architecture</h3><p>Daemon, mobile core, transport, relay, persistence, and npm distribution.</p></Link>
            <Link className="tile" href="/privacy/"><h3>Privacy</h3><p>What stays local, what crosses iroh, and what push providers can see.</p></Link>
          </div>
        </div>
      </section>
    </>
  );
}
