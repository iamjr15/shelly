import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Protocol",
  description:
    "Shelly protocol overview: contract version 3, length-prefixed framing, pairing tickets, attach replay, and push registration.",
};

export default function ProtocolPage() {
  return (
    <section className="page">
      <div className="page-copy">
        <p className="eyebrow">Protocol</p>
        <h1>Contract version 3.</h1>
        <p className="lede">
          Every client starts with <code>Hello</code> and rejects contract mismatches.
          Version 3 carries compact pairing tickets while preserving the raw PTY byte
          contract: local IPC uses bincode, mobile transport uses MessagePack, and iroh
          accepts only paired mobile client kinds.
        </p>
      </div>

      <div className="doc-list">
        <article className="tile">
          <h3>Framing</h3>
          <p>Each frame is a 4-byte big-endian payload length followed by a serialized protocol message.</p>
        </article>
        <article className="tile">
          <h3>Attach and replay</h3>
          <p><code>AttachSession.last_seen_seq</code> requests warm replay from the PTY byte ring. Stale clients receive a daemon-rendered ANSI snapshot.</p>
        </article>
        <article className="tile">
          <h3>Pairing</h3>
          <p>Pairing uses a 5-character Crockford code plus a compact <code>sh1</code> PairingTicket. A single active code expires after 5 minutes, wrong attempts are capped, and the desktop must approve the request.</p>
        </article>
        <article className="tile">
          <h3>Mobile capabilities</h3>
          <p>Paired mobile clients can list, create shell-only sessions, kill, attach, input, resize, detach, ping, and register push tokens. Agent-state events remain desktop-CLI-only, and desktop CLI clients use the local Unix socket instead of iroh.</p>
        </article>
      </div>
    </section>
  );
}
