import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Architecture",
  description:
    "Shelly architecture overview: daemon-owned PTYs, raw byte streaming, iroh transport, encrypted persistence, and relay push.",
};

export default function ArchitecturePage() {
  return (
    <section className="page">
      <div className="page-copy">
        <p className="eyebrow">Architecture</p>
        <h1>Daemon-owned PTYs with native mobile views.</h1>
        <p className="lede">
          The host daemon owns every session. Desktop CLI and Android are views into
          the same PTY: desktop uses local IPC, while paired mobile clients use
          authenticated iroh streams.
        </p>
      </div>

      <div className="doc-list">
        <article className="tile">
          <h3>PTY model</h3>
          <p>Shelly streams raw PTY bytes. The daemon keeps a 256 KB byte ring with monotonic sequence numbers and a <code>wezterm-term</code> terminal model for synthetic ANSI snapshots.</p>
        </article>
        <article className="tile">
          <h3>Transport</h3>
          <p>Local desktop clients use length-prefixed bincode over a hardened Unix socket. Paired mobile clients use length-prefixed MessagePack over iroh QUIC, and iroh rejects desktop CLI client kinds during handshake.</p>
        </article>
        <article className="tile">
          <h3>Persistence</h3>
          <p>Session summaries, scrollback, paired devices, and push tokens are stored in encrypted local <code>redb</code> databases with keys held by the OS keychain unless the user explicitly opts out. Persistence parents are private <code>0700</code>, database files are <code>0600</code>, and symlinked stores are rejected.</p>
        </article>
        <article className="tile">
          <h3>Relay</h3>
          <p>The relay handles iroh fallback and privacy-preserving push. FCM service-account JSON and Honeycomb credentials live only on the relay; APNs is deferred with iOS.</p>
        </article>
      </div>
    </section>
  );
}
