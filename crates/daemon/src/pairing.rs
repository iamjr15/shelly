use anyhow::{Context, Result, anyhow, bail};
use chacha20poly1305::aead::{OsRng, rand_core::RngCore};
use fieldwork_protocol::{CODE_ALPHABET, CODE_LEN, ClientId, now_ms};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Duration, timeout};

const PAIR_TOKEN_TTL_MS: u64 = 5 * 60 * 1000;
/// Wrong in-band code attempts tolerated before an active code is invalidated.
const MAX_CODE_ATTEMPTS: u8 = 5;

#[derive(Debug)]
pub struct PairingApprovalEvent {
    pub request_id: ClientId,
    pub device_name: String,
    pub device_node_id: String,
}

struct PendingPairCode {
    expires_at: u64,
    /// Wrong in-band code attempts observed while this code was active.
    attempts: u8,
    request_tx: mpsc::UnboundedSender<PairingApprovalEvent>,
}

pub struct PairingManager {
    codes: Mutex<HashMap<String, PendingPairCode>>,
    approvals: Mutex<HashMap<ClientId, oneshot::Sender<bool>>>,
}

impl PairingManager {
    pub fn new() -> Self {
        Self {
            codes: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
        }
    }

    pub fn begin_pairing(
        &self,
    ) -> Result<(String, u64, mpsc::UnboundedReceiver<PairingApprovalEvent>)> {
        self.prune_expired()?;
        let code = generate_code();
        let expires_at = now_ms().saturating_add(PAIR_TOKEN_TTL_MS);
        let (request_tx, request_rx) = mpsc::unbounded_channel();

        let mut codes = self
            .codes
            .lock()
            .map_err(|_| anyhow!("pair code lock poisoned"))?;
        codes.clear();
        codes.insert(
            code.clone(),
            PendingPairCode {
                expires_at,
                attempts: 0,
                request_tx,
            },
        );

        Ok((code, expires_at, request_rx))
    }

    pub async fn request_approval(
        &self,
        code: &str,
        device_name: String,
        device_node_id: String,
    ) -> Result<bool> {
        let pending = {
            let mut codes = self
                .codes
                .lock()
                .map_err(|_| anyhow!("pair code lock poisoned"))?;
            match codes.remove(code) {
                // Hit: consume the code and proceed to desktop approval.
                Some(pending) => pending,
                // Miss: charge a failed attempt against every active code and
                // invalidate any that exhaust the budget, leaving the QR path
                // intact until the desktop operator restarts pairing.
                None => {
                    let now = now_ms();
                    codes.retain(|_, pending| {
                        if pending.expires_at <= now {
                            return false;
                        }
                        pending.attempts = pending.attempts.saturating_add(1);
                        pending.attempts < MAX_CODE_ATTEMPTS
                    });
                    bail!("pair code is invalid or already used");
                }
            }
        };

        let remaining_ms = pending.expires_at.saturating_sub(now_ms());
        if remaining_ms == 0 {
            bail!("pair code expired");
        }

        let request_id = ClientId::new();
        let (approval_tx, approval_rx) = oneshot::channel();
        self.approvals
            .lock()
            .map_err(|_| anyhow!("pair approval lock poisoned"))?
            .insert(request_id, approval_tx);

        if pending
            .request_tx
            .send(PairingApprovalEvent {
                request_id,
                device_name,
                device_node_id,
            })
            .is_err()
        {
            self.approvals
                .lock()
                .map_err(|_| anyhow!("pair approval lock poisoned"))?
                .remove(&request_id);
            bail!("desktop pairing approval prompt is no longer active");
        }

        match timeout(Duration::from_millis(remaining_ms), approval_rx).await {
            Ok(Ok(approved)) => Ok(approved),
            Ok(Err(_)) => Ok(false),
            Err(_) => {
                self.approvals
                    .lock()
                    .map_err(|_| anyhow!("pair approval lock poisoned"))?
                    .remove(&request_id);
                Ok(false)
            }
        }
    }

    pub fn approve(&self, request_id: ClientId, approved: bool) -> Result<()> {
        let tx = self
            .approvals
            .lock()
            .map_err(|_| anyhow!("pair approval lock poisoned"))?
            .remove(&request_id)
            .context("pairing request not found or already answered")?;
        let _ = tx.send(approved);
        Ok(())
    }

    fn prune_expired(&self) -> Result<()> {
        let now = now_ms();
        self.codes
            .lock()
            .map_err(|_| anyhow!("pair code lock poisoned"))?
            .retain(|_, pending| pending.expires_at > now);
        Ok(())
    }
}

/// Picks a [`CODE_LEN`]-character pairing code uniformly from [`CODE_ALPHABET`].
///
/// Rejection sampling against a power-of-two mask avoids the modulo bias a
/// naive `byte % 32` would introduce; the alphabet is exactly 32 characters so
/// every accepted 5-bit value maps to one character.
fn generate_code() -> String {
    let alphabet = CODE_ALPHABET.as_bytes();
    debug_assert_eq!(alphabet.len(), 32);
    let mut code = String::with_capacity(CODE_LEN);
    while code.len() < CODE_LEN {
        let mut byte = [0_u8; 1];
        OsRng.fill_bytes(&mut byte);
        let index = (byte[0] & 0x1f) as usize;
        code.push(alphabet[index] as char);
    }
    code
}

#[cfg(test)]
mod tests {
    use super::{MAX_CODE_ATTEMPTS, PAIR_TOKEN_TTL_MS, PairingManager};
    use fieldwork_protocol::{CODE_ALPHABET, CODE_LEN, is_valid_code, now_ms};
    use std::sync::Arc;

    #[test]
    fn generated_codes_are_crockford_charset_and_fixed_length() {
        let manager = PairingManager::new();
        let (code, _, _rx) = manager.begin_pairing().unwrap();

        assert_eq!(code.chars().count(), CODE_LEN);
        assert!(code.chars().all(|ch| CODE_ALPHABET.contains(ch)));
        assert!(is_valid_code(&code));
    }

    #[test]
    fn pair_codes_expire_after_five_minutes() {
        let manager = PairingManager::new();
        let before = now_ms();
        let (_, expires_at, _rx) = manager.begin_pairing().unwrap();
        let after = now_ms();

        assert!(expires_at >= before.saturating_add(PAIR_TOKEN_TTL_MS));
        assert!(expires_at <= after.saturating_add(PAIR_TOKEN_TTL_MS));
    }

    #[tokio::test]
    async fn pair_codes_are_single_use_even_before_approval() {
        let manager = Arc::new(PairingManager::new());
        let (code, _, mut rx) = manager.begin_pairing().unwrap();

        let first_manager = Arc::clone(&manager);
        let first_code = code.clone();
        let first = tokio::spawn(async move {
            first_manager
                .request_approval(&first_code, "phone".to_string(), "node-a".to_string())
                .await
        });
        let event = rx.recv().await.expect("pair approval request");
        let second = manager
            .request_approval(&code, "phone".to_string(), "node-a".to_string())
            .await;

        assert!(second.is_err());
        manager.approve(event.request_id, false).unwrap();
        assert!(!first.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn starting_new_pairing_invalidates_previous_code() {
        let manager = Arc::new(PairingManager::new());
        let (first_code, _, _first_rx) = manager.begin_pairing().unwrap();
        let (second_code, _, mut second_rx) = manager.begin_pairing().unwrap();

        assert_ne!(first_code, second_code);
        assert!(
            manager
                .request_approval(&first_code, "phone".to_string(), "node-a".to_string())
                .await
                .is_err()
        );

        let approval_manager = Arc::clone(&manager);
        let request = tokio::spawn(async move {
            approval_manager
                .request_approval(&second_code, "phone".to_string(), "node-a".to_string())
                .await
        });
        let event = second_rx.recv().await.expect("pair approval request");
        manager.approve(event.request_id, true).unwrap();
        assert!(request.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn pairing_succeeds_only_after_explicit_approval() {
        let manager = Arc::new(PairingManager::new());
        let (code, _, mut rx) = manager.begin_pairing().unwrap();

        let approval_manager = Arc::clone(&manager);
        let request = tokio::spawn(async move {
            approval_manager
                .request_approval(&code, "phone".to_string(), "node-a".to_string())
                .await
        });
        let event = rx.recv().await.expect("pair approval request");

        assert!(!request.is_finished());
        manager.approve(event.request_id, true).unwrap();
        assert!(request.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn active_code_is_invalidated_after_five_wrong_attempts() {
        let manager = PairingManager::new();
        let (code, _, _rx) = manager.begin_pairing().unwrap();

        // Each miss charges the active code; the fifth exhausts its budget.
        for _ in 0..MAX_CODE_ATTEMPTS {
            assert!(
                manager
                    .request_approval("ZZZZZ", "phone".to_string(), "node-a".to_string())
                    .await
                    .is_err()
            );
        }

        // The correct code is now invalid because the window was burned down.
        assert!(
            manager
                .request_approval(&code, "phone".to_string(), "node-a".to_string())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn wrong_attempts_below_cap_leave_the_code_usable() {
        let manager = Arc::new(PairingManager::new());
        let (code, _, mut rx) = manager.begin_pairing().unwrap();

        for _ in 0..(MAX_CODE_ATTEMPTS - 1) {
            assert!(
                manager
                    .request_approval("ZZZZZ", "phone".to_string(), "node-a".to_string())
                    .await
                    .is_err()
            );
        }

        let approval_manager = Arc::clone(&manager);
        let request = tokio::spawn(async move {
            approval_manager
                .request_approval(&code, "phone".to_string(), "node-a".to_string())
                .await
        });
        let event = rx.recv().await.expect("pair approval request");
        manager.approve(event.request_id, true).unwrap();
        assert!(request.await.unwrap().unwrap());
    }
}
