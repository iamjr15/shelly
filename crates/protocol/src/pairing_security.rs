//! Normative pairing transcript helpers shared by both authenticated endpoints.

use data_encoding::{HEXLOWER, HEXUPPER};
use sha2::{Digest, Sha256};

use crate::normalize_code;

const SAS_DOMAIN: &[u8] = b"shelly-pair-sas-v1\0";
const SAS_BYTES: usize = 10;
const SAS_GROUP_HEX_CHARS: usize = 4;

/// Returns the relay locator for a pairing code.
///
/// This is `hex_lower(SHA-256(normalized_code))`. Pairing codes have low enough
/// entropy for the digest to be enumerated offline, so the result is a locator,
/// not confidentiality or proof that the publisher knows the code.
pub fn pairing_code_locator(code: &str) -> String {
    let normalized_code = normalize_code(code);
    HEXLOWER.encode(&Sha256::digest(normalized_code.as_bytes()))
}

/// Computes the normative 80-bit pairing SAS and returns its fixed presentation.
///
/// The transcript is
/// `SHA-256("shelly-pair-sas-v1\0" || normalized_code || daemon_key || phone_key)`.
/// Both keys are the raw 32-byte public keys authenticated by iroh. The first 10
/// digest bytes are rendered as five uppercase hexadecimal groups of four:
/// `XXXX-XXXX-XXXX-XXXX-XXXX`.
pub fn pairing_sas(
    code: &str,
    daemon_public_key: &[u8; 32],
    phone_public_key: &[u8; 32],
) -> String {
    let normalized_code = normalize_code(code);
    let mut hash = Sha256::new();
    hash.update(SAS_DOMAIN);
    hash.update(normalized_code.as_bytes());
    hash.update(daemon_public_key);
    hash.update(phone_public_key);
    let digest = hash.finalize();
    let encoded = HEXUPPER.encode(&digest[..SAS_BYTES]);

    encoded
        .as_bytes()
        .chunks(SAS_GROUP_HEX_CHARS)
        .map(|group| std::str::from_utf8(group).expect("hex output is UTF-8"))
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::{pairing_code_locator, pairing_sas};

    #[test]
    fn locator_normalizes_before_hashing() {
        assert_eq!(
            pairing_code_locator("ab2-34 cd"),
            pairing_code_locator("AB234CD")
        );
        assert_eq!(pairing_code_locator("AB234CD").len(), 64);
    }

    #[test]
    fn sas_has_stable_transcript_and_grouped_presentation() {
        let sas = pairing_sas("ab2-34 cd", &[0x11; 32], &[0x22; 32]);

        assert_eq!(sas, "84A9-FB21-1FC7-20DF-3B6E");
    }

    #[test]
    fn sas_binds_key_roles_and_both_authenticated_keys() {
        let daemon = [0x11; 32];
        let phone = [0x22; 32];
        let expected = pairing_sas("AB234CD", &daemon, &phone);

        assert_ne!(expected, pairing_sas("AB234CE", &daemon, &phone));
        assert_ne!(expected, pairing_sas("AB234CD", &phone, &daemon));
        assert_ne!(expected, pairing_sas("AB234CD", &daemon, &[0x23; 32]));
    }
}
