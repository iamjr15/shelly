//! Canonical request layout for relay HTTP request signing, shared by the
//! daemon (signer) and relay (verifier).

/// Builds the canonical string that the daemon signs with its Ed25519 key and
/// the relay verifies against the daemon's registered public key.
///
/// The layout is `METHOD\nPATH\nBODY\nNONCE\nTS_MS` with the body decoded as
/// lossy UTF-8. Signer and verifier must produce identical bytes, so this
/// layout is frozen: any change breaks every deployed daemon/relay pair.
pub fn canonical_request(method: &str, path: &str, body: &[u8], nonce: &str, ts_ms: u64) -> String {
    format!(
        "{method}\n{path}\n{}\n{nonce}\n{ts_ms}",
        String::from_utf8_lossy(body)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_request_locks_v1_byte_layout() {
        let canonical = canonical_request(
            "POST",
            "/v1/push",
            br#"{"nonce":"nonce-1","ts_ms":42}"#,
            "nonce-1",
            42,
        );

        assert_eq!(
            canonical,
            "POST\n/v1/push\n{\"nonce\":\"nonce-1\",\"ts_ms\":42}\nnonce-1\n42"
        );
    }

    #[test]
    fn canonical_request_decodes_invalid_utf8_body_lossily() {
        let canonical = canonical_request("POST", "/v1/push", &[0xff, 0xfe], "n", 0);

        assert_eq!(canonical, "POST\n/v1/push\n\u{fffd}\u{fffd}\nn\n0");
    }

    #[test]
    fn canonical_request_with_empty_body_keeps_all_separators() {
        let canonical = canonical_request("POST", "/v1/pair/publish", b"", "abc", 1_700_000_000);

        assert_eq!(canonical, "POST\n/v1/pair/publish\n\nabc\n1700000000");
    }
}
