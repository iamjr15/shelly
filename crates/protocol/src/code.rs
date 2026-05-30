//! Shared short pairing-code constants and normalization used by the daemon,
//! relay, and mobile bindings so every component agrees on the same alphabet.
//!
//! Codes are exactly [`CODE_LEN`] characters drawn from the Crockford base32
//! alphabet (no `I`/`L`/`O`/`U` to avoid confusables). The daemon owns code
//! generation; this module only exposes the alphabet plus the normalize and
//! validate routines so user input can be canonicalized consistently.

/// Number of characters in a pairing code.
pub const CODE_LEN: usize = 5;

/// Crockford base32 alphabet used for pairing codes (no `I`/`L`/`O`/`U`).
pub const CODE_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Normalizes user-entered pairing code text to its canonical uppercase form.
///
/// Spaces and dashes are stripped, lowercase is uppercased, and the Crockford
/// input aliases are applied: `I`/`L` map to `1` and `O` maps to `0`. The
/// result is not validated; callers should pass it to [`is_valid_code`].
pub fn normalize_code(input: &str) -> String {
    input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect()
}

/// Returns whether `code` is already a canonical [`CODE_LEN`]-character code.
///
/// This expects normalized input; it does not apply Crockford aliasing. Pass
/// the output of [`normalize_code`] to validate user-entered text.
pub fn is_valid_code(code: &str) -> bool {
    code.chars().count() == CODE_LEN && code.chars().all(|c| CODE_ALPHABET.contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alphabet_has_no_confusables() {
        assert_eq!(CODE_ALPHABET.len(), 32);
        for c in ['I', 'L', 'O', 'U'] {
            assert!(!CODE_ALPHABET.contains(c), "alphabet contains {c}");
        }
    }

    #[test]
    fn normalize_uppercases_and_strips_separators() {
        assert_eq!(normalize_code(" ab2-3 4 "), "AB234");
    }

    #[test]
    fn normalize_applies_crockford_aliases() {
        assert_eq!(normalize_code("iloO0"), "11000");
    }

    #[test]
    fn valid_code_requires_exact_length_and_alphabet() {
        assert!(is_valid_code("AB234"));
        assert!(!is_valid_code("AB23"));
        assert!(!is_valid_code("AB2345"));
        // `I`, `L`, `O`, `U` are not in the canonical alphabet.
        assert!(!is_valid_code("ABCIO"));
    }
}
