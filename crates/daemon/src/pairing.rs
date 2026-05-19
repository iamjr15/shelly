use anyhow::{Context, Result, anyhow, bail};
use chacha20poly1305::aead::{OsRng, rand_core::RngCore};
use data_encoding::BASE32_NOPAD;
use fieldwork_protocol::{ClientId, now_ms};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Duration, timeout};

const PAIR_TOKEN_BYTES: usize = 32;
const PAIR_TOKEN_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug)]
pub struct PairingApprovalEvent {
    pub request_id: ClientId,
    pub device_name: String,
    pub device_node_id: String,
}

struct PendingPairToken {
    expires_at: u64,
    request_tx: mpsc::UnboundedSender<PairingApprovalEvent>,
}

pub struct PairingManager {
    tokens: Mutex<HashMap<String, PendingPairToken>>,
    approvals: Mutex<HashMap<ClientId, oneshot::Sender<bool>>>,
}

impl PairingManager {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
        }
    }

    pub fn begin_pairing(
        &self,
    ) -> Result<(String, u64, mpsc::UnboundedReceiver<PairingApprovalEvent>)> {
        self.prune_expired()?;
        let mut random = [0_u8; PAIR_TOKEN_BYTES];
        OsRng.fill_bytes(&mut random);
        let token = BASE32_NOPAD.encode(&random);
        let expires_at = now_ms().saturating_add(PAIR_TOKEN_TTL_MS);
        let (request_tx, request_rx) = mpsc::unbounded_channel();

        self.tokens
            .lock()
            .map_err(|_| anyhow!("pair token lock poisoned"))?
            .insert(
                token.clone(),
                PendingPairToken {
                    expires_at,
                    request_tx,
                },
            );

        Ok((token, expires_at, request_rx))
    }

    pub async fn request_approval(
        &self,
        pair_token: &str,
        device_name: String,
        device_node_id: String,
    ) -> Result<bool> {
        let pending = {
            let mut tokens = self
                .tokens
                .lock()
                .map_err(|_| anyhow!("pair token lock poisoned"))?;
            tokens.remove(pair_token)
        }
        .context("pair token is invalid or already used")?;

        if now_ms() > pending.expires_at {
            bail!("pair token expired");
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

        match timeout(Duration::from_millis(PAIR_TOKEN_TTL_MS), approval_rx).await {
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
        self.tokens
            .lock()
            .map_err(|_| anyhow!("pair token lock poisoned"))?
            .retain(|_, pending| pending.expires_at > now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{BASE32_NOPAD, PAIR_TOKEN_BYTES, PAIR_TOKEN_TTL_MS, PairingManager};
    use fieldwork_protocol::now_ms;
    use std::sync::Arc;

    #[test]
    fn generated_pair_tokens_are_base32_encoded_32_bytes() {
        let manager = PairingManager::new();
        let (token, _, _rx) = manager.begin_pairing().unwrap();

        assert_eq!(token.len(), 52);
        assert!(
            token
                .chars()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit())
        );
        assert_eq!(
            BASE32_NOPAD.decode(token.as_bytes()).unwrap().len(),
            PAIR_TOKEN_BYTES
        );
    }

    #[test]
    fn pair_tokens_expire_after_ten_minutes() {
        let manager = PairingManager::new();
        let before = now_ms();
        let (_, expires_at, _rx) = manager.begin_pairing().unwrap();
        let after = now_ms();

        assert!(expires_at >= before.saturating_add(PAIR_TOKEN_TTL_MS));
        assert!(expires_at <= after.saturating_add(PAIR_TOKEN_TTL_MS));
    }

    #[tokio::test]
    async fn pair_tokens_are_single_use_even_before_approval() {
        let manager = Arc::new(PairingManager::new());
        let (token, _, mut rx) = manager.begin_pairing().unwrap();

        let first_manager = Arc::clone(&manager);
        let first_token = token.clone();
        let first = tokio::spawn(async move {
            first_manager
                .request_approval(&first_token, "phone".to_string(), "node-a".to_string())
                .await
        });
        let event = rx.recv().await.expect("pair approval request");
        let second = manager
            .request_approval(&token, "phone".to_string(), "node-a".to_string())
            .await;

        assert!(second.is_err());
        manager.approve(event.request_id, false).unwrap();
        assert!(!first.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn pairing_succeeds_only_after_explicit_approval() {
        let manager = Arc::new(PairingManager::new());
        let (token, _, mut rx) = manager.begin_pairing().unwrap();

        let approval_manager = Arc::clone(&manager);
        let request = tokio::spawn(async move {
            approval_manager
                .request_approval(&token, "phone".to_string(), "node-a".to_string())
                .await
        });
        let event = rx.recv().await.expect("pair approval request");

        assert!(!request.is_finished());
        manager.approve(event.request_id, true).unwrap();
        assert!(request.await.unwrap().unwrap());
    }
}
