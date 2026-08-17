//! Versioned canonical request layouts for relay HTTP request signing, shared
//! by the daemon (signer) and relay (verifier).

use sha2::{Digest, Sha256};

const V1_SIGNATURE_PREFIX: &str = "v1=";
const V2_SIGNATURE_PREFIX: &str = "v2=";
const V2_DOMAIN: &[u8] = b"shelly-relay-request-v2";

/// HTTP request-signature canonicalization version.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SignatureVersion {
    /// Released lossy-UTF-8 canonicalization, retained during migration only.
    V1,
    /// Length-prefixed canonicalization over a body digest and relay audience.
    V2,
}

/// Builds the v1 canonical string used by released daemons.
///
/// The layout is `METHOD\nPATH\nBODY\nNONCE\nTS_MS` with the body decoded as
/// lossy UTF-8. This layout is intentionally frozen for migration compatibility
/// despite not being injective. New clients must use [`canonical_request_v2`].
pub fn canonical_request(method: &str, path: &str, body: &[u8], nonce: &str, ts_ms: u64) -> String {
    format!(
        "{method}\n{path}\n{}\n{nonce}\n{ts_ms}",
        String::from_utf8_lossy(body)
    )
}

/// Builds the v2 canonical bytes for a relay HTTP request.
///
/// Every field is encoded as an eight-byte big-endian length followed by its
/// bytes. The fields, in order, are the v2 domain separator, configured relay
/// audience, method, path, raw SHA-256 body digest, nonce, and the timestamp as
/// eight big-endian bytes. The audience must be passed from canonical
/// configuration; callers must never reconstruct it from request headers.
pub fn canonical_request_v2(
    relay_audience: &str,
    method: &str,
    path: &str,
    body: &[u8],
    nonce: &str,
    ts_ms: u64,
) -> Vec<u8> {
    let body_digest = Sha256::digest(body);
    let timestamp = ts_ms.to_be_bytes();
    let fields: [&[u8]; 7] = [
        V2_DOMAIN,
        relay_audience.as_bytes(),
        method.as_bytes(),
        path.as_bytes(),
        body_digest.as_ref(),
        nonce.as_bytes(),
        &timestamp,
    ];
    let capacity = fields
        .iter()
        .map(|field| 8_usize.saturating_add(field.len()))
        .sum();
    let mut canonical = Vec::with_capacity(capacity);
    for field in fields {
        canonical.extend_from_slice(&(field.len() as u64).to_be_bytes());
        canonical.extend_from_slice(field);
    }
    canonical
}

/// Formats the version marker and encoded Ed25519 signature for the signature
/// request header.
///
/// v1 may be formatted explicitly for tests and tooling, although released v1
/// clients sent bare base64. v2 is always explicit so old relays reject it
/// cleanly instead of accidentally interpreting it as a v1 signature.
pub fn signature_header(version: SignatureVersion, encoded_signature: &str) -> String {
    let prefix = match version {
        SignatureVersion::V1 => V1_SIGNATURE_PREFIX,
        SignatureVersion::V2 => V2_SIGNATURE_PREFIX,
    };
    format!("{prefix}{encoded_signature}")
}

/// Splits a signature request header into its version and encoded signature.
///
/// A bare value is the released implicit v1 format. Explicit `v1=` and `v2=`
/// values are accepted, while other `vN=` markers are rejected so future
/// versions cannot silently fall back to the legacy canonicalization.
pub fn split_signature_header(value: &str) -> Option<(SignatureVersion, &str)> {
    if let Some(signature) = value.strip_prefix(V1_SIGNATURE_PREFIX) {
        return Some((SignatureVersion::V1, signature));
    }
    if let Some(signature) = value.strip_prefix(V2_SIGNATURE_PREFIX) {
        return Some((SignatureVersion::V2, signature));
    }
    if value
        .split_once('=')
        .is_some_and(|(version, _)| is_version_marker(version))
    {
        return None;
    }
    Some((SignatureVersion::V1, value))
}

fn is_version_marker(value: &str) -> bool {
    value.strip_prefix('v').is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
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
    fn canonical_request_v1_decodes_invalid_utf8_body_lossily() {
        let canonical = canonical_request("POST", "/v1/push", &[0xff, 0xfe], "n", 0);

        assert_eq!(canonical, "POST\n/v1/push\n\u{fffd}\u{fffd}\nn\n0");
    }

    #[test]
    fn canonical_request_v1_with_empty_body_keeps_all_separators() {
        let canonical = canonical_request("POST", "/v1/pair/publish", b"", "abc", 1_700_000_000);

        assert_eq!(canonical, "POST\n/v1/pair/publish\n\nabc\n1700000000");
    }

    #[test]
    fn canonical_request_v2_hashes_raw_body_bytes() {
        let first = canonical_request_v2(
            "https://relay.shelly.sh",
            "POST",
            "/v1/push",
            &[0xff],
            "nonce",
            42,
        );
        let second = canonical_request_v2(
            "https://relay.shelly.sh",
            "POST",
            "/v1/push",
            &[0xfe],
            "nonce",
            42,
        );

        assert_ne!(first, second);
    }

    #[test]
    fn canonical_request_v2_uses_length_prefixed_fields() {
        let audience = "https://relay.shelly.sh";
        let body = b"body";
        let canonical = canonical_request_v2(audience, "POST", "/v1/push", body, "nonce", 42);
        let body_digest = Sha256::digest(body);
        let expected_fields: [&[u8]; 7] = [
            V2_DOMAIN,
            audience.as_bytes(),
            b"POST",
            b"/v1/push",
            body_digest.as_ref(),
            b"nonce",
            &42_u64.to_be_bytes(),
        ];
        let mut offset = 0;
        for field in expected_fields {
            let length = u64::from_be_bytes(canonical[offset..offset + 8].try_into().unwrap());
            offset += 8;
            assert_eq!(length as usize, field.len());
            assert_eq!(&canonical[offset..offset + field.len()], field);
            offset += field.len();
        }
        assert_eq!(offset, canonical.len());
    }

    #[test]
    fn signature_header_parser_keeps_implicit_v1_compatibility() {
        assert_eq!(
            split_signature_header("legacy-base64=="),
            Some((SignatureVersion::V1, "legacy-base64=="))
        );
        assert_eq!(
            split_signature_header("v1=explicit-base64"),
            Some((SignatureVersion::V1, "explicit-base64"))
        );
        assert_eq!(
            split_signature_header("v2=new-base64"),
            Some((SignatureVersion::V2, "new-base64"))
        );
        assert_eq!(split_signature_header("v3=future-base64"), None);
    }

    #[test]
    fn signature_header_formats_explicit_versions() {
        assert_eq!(
            signature_header(SignatureVersion::V1, "signature"),
            "v1=signature"
        );
        assert_eq!(
            signature_header(SignatureVersion::V2, "signature"),
            "v2=signature"
        );
    }
}
