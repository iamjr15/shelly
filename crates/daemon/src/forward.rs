use shelly_protocol::{ServerToClientMsg, SessionId};
use tokio::sync::broadcast;

#[derive(Debug)]
pub(crate) enum ForwardedEvent {
    Message(ServerToClientMsg),
    TerminalMessage(ServerToClientMsg),
    Closed,
}

pub(crate) async fn recv_attached_event(
    rx: &mut broadcast::Receiver<ServerToClientMsg>,
    session_id: SessionId,
) -> ForwardedEvent {
    match rx.recv().await {
        Ok(event) => ForwardedEvent::Message(event),
        Err(broadcast::error::RecvError::Lagged(skipped)) => {
            ForwardedEvent::TerminalMessage(ServerToClientMsg::Lag {
                session_id,
                skipped_bytes: skipped,
            })
        }
        Err(broadcast::error::RecvError::Closed) => ForwardedEvent::Closed,
    }
}

pub(crate) fn output_was_replayed(event: &ServerToClientMsg, attached_seq: u64) -> bool {
    matches!(event, ServerToClientMsg::Output { seq, .. } if *seq <= attached_seq)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shelly_protocol::ServerToClientMsg;

    #[tokio::test]
    async fn lag_is_a_terminal_forwarded_event() {
        let session_id = SessionId::new();
        let (tx, mut rx) = broadcast::channel(1);
        tx.send(ServerToClientMsg::Output {
            session_id,
            seq: 1,
            bytes: b"first".to_vec(),
        })
        .unwrap();
        tx.send(ServerToClientMsg::Output {
            session_id,
            seq: 2,
            bytes: b"second".to_vec(),
        })
        .unwrap();

        match recv_attached_event(&mut rx, session_id).await {
            ForwardedEvent::TerminalMessage(ServerToClientMsg::Lag {
                session_id: lag_session_id,
                skipped_bytes,
            }) => {
                assert_eq!(lag_session_id, session_id);
                assert_eq!(skipped_bytes, 1);
            }
            other => panic!("expected terminal lag event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn output_is_a_non_terminal_forwarded_event() {
        let session_id = SessionId::new();
        let (tx, mut rx) = broadcast::channel(2);
        tx.send(ServerToClientMsg::Output {
            session_id,
            seq: 5,
            bytes: b"live".to_vec(),
        })
        .unwrap();

        match recv_attached_event(&mut rx, session_id).await {
            ForwardedEvent::Message(ServerToClientMsg::Output { bytes, .. }) => {
                assert_eq!(bytes, b"live");
            }
            other => panic!("expected output event, got {other:?}"),
        }
    }

    #[test]
    fn replayed_output_detection_uses_attached_seq() {
        let session_id = SessionId::new();
        let replayed = ServerToClientMsg::Output {
            session_id,
            seq: 10,
            bytes: b"already sent".to_vec(),
        };
        let live = ServerToClientMsg::Output {
            session_id,
            seq: 11,
            bytes: b"new".to_vec(),
        };
        let state = ServerToClientMsg::AgentStateChanged {
            session_id,
            state: shelly_protocol::AgentState::Working,
            last_line: None,
        };

        assert!(output_was_replayed(&replayed, 10));
        assert!(!output_was_replayed(&live, 10));
        assert!(!output_was_replayed(&state, 10));
    }
}
