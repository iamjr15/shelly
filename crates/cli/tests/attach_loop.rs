use shelly_cli::attach_loop::{
    AttachIo, AttachOutcome, DetachState, InputEvent, TerminalRenderer, read_message,
    run_attach_session, write_message,
};
use shelly_protocol::{
    ClientSize, ClientToServerMsg, ServerToClientMsg, SessionId, encode_bincode,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

struct RawRenderer;

impl TerminalRenderer for RawRenderer {
    fn initial_frame(&mut self, bytes: &[u8]) -> Vec<u8> {
        bytes.to_vec()
    }

    fn output_frame(&mut self, bytes: &[u8]) -> Vec<u8> {
        bytes.to_vec()
    }

    fn resize_frame(&mut self, physical_size: ClientSize) -> (ClientSize, Vec<u8>) {
        (physical_size, Vec::new())
    }
}

fn terminal_size() -> ClientSize {
    ClientSize { cols: 80, rows: 24 }
}

#[tokio::test]
async fn partial_frame_survives_interleaved_input() {
    // The small duplex capacity makes the partial-frame write wait until the
    // client has consumed bytes, so stdin is guaranteed to arrive mid-frame.
    let (client, server) = tokio::io::duplex(5);
    let (mut server_reader, mut server_writer) = tokio::io::split(server);
    let (output_writer, mut output_reader) = tokio::io::duplex(256);
    let (input_tx, mut input_rx) = mpsc::channel(4);
    let (_resize_tx, mut resize_rx) = mpsc::channel(1);
    let session_id = SessionId::new();

    let attach = tokio::spawn(async move {
        run_attach_session(
            client,
            session_id,
            terminal_size(),
            AttachIo::new(
                &mut input_rx,
                &mut resize_rx,
                &mut { output_writer },
                &mut RawRenderer,
                &mut DetachState::new(0x02),
            ),
        )
        .await
    });

    assert!(matches!(
        read_message::<_, ClientToServerMsg>(&mut server_reader)
            .await
            .unwrap(),
        ClientToServerMsg::AttachSession {
            last_seen_seq: None,
            ..
        }
    ));
    write_message(
        &mut server_writer,
        &ServerToClientMsg::Attached {
            session_id,
            initial_bytes: b"initial:".to_vec(),
            seq: 8,
        },
    )
    .await
    .unwrap();

    let output_message = ServerToClientMsg::Output {
        session_id,
        seq: 23,
        bytes: b"complete-frame".as_slice().into(),
    };
    let payload = encode_bincode(&output_message).unwrap();
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    server_writer.write_all(&frame[..7]).await.unwrap();

    input_tx
        .send(InputEvent::Bytes(b"x".to_vec()))
        .await
        .unwrap();
    assert!(matches!(
        read_message::<_, ClientToServerMsg>(&mut server_reader)
            .await
            .unwrap(),
        ClientToServerMsg::Input { bytes, .. } if bytes == b"x"
    ));

    server_writer.write_all(&frame[7..]).await.unwrap();
    write_message(
        &mut server_writer,
        &ServerToClientMsg::SessionExited {
            session_id,
            exit_code: 0,
        },
    )
    .await
    .unwrap();

    assert_eq!(
        attach.await.unwrap().unwrap(),
        AttachOutcome::SessionExited(0)
    );
    let mut rendered = Vec::new();
    output_reader.read_to_end(&mut rendered).await.unwrap();
    assert_eq!(rendered, b"initial:complete-frame");
}

#[tokio::test]
async fn ctrl_b_then_d_detaches() {
    let (client, mut server) = tokio::io::duplex(256);
    let (output_writer, _output_reader) = tokio::io::duplex(256);
    let (input_tx, mut input_rx) = mpsc::channel(4);
    let (_resize_tx, mut resize_rx) = mpsc::channel(1);
    let session_id = SessionId::new();

    let attach = tokio::spawn(async move {
        run_attach_session(
            client,
            session_id,
            terminal_size(),
            AttachIo::new(
                &mut input_rx,
                &mut resize_rx,
                &mut { output_writer },
                &mut RawRenderer,
                &mut DetachState::new(0x02),
            ),
        )
        .await
    });

    let _: ClientToServerMsg = read_message(&mut server).await.unwrap();
    write_message(
        &mut server,
        &ServerToClientMsg::Attached {
            session_id,
            initial_bytes: Vec::new(),
            seq: 0,
        },
    )
    .await
    .unwrap();

    input_tx.send(InputEvent::Bytes(vec![0x02])).await.unwrap();
    input_tx.send(InputEvent::Bytes(vec![b'D'])).await.unwrap();

    assert_eq!(
        read_message::<_, ClientToServerMsg>(&mut server)
            .await
            .unwrap(),
        ClientToServerMsg::DetachSession
    );
    assert_eq!(attach.await.unwrap().unwrap(), AttachOutcome::Detached);
}

#[tokio::test]
async fn lag_reattaches_from_last_seen_sequence() {
    let (client, mut server) = tokio::io::duplex(512);
    let (output_writer, mut output_reader) = tokio::io::duplex(512);
    let (_input_tx, mut input_rx) = mpsc::channel(1);
    let (_resize_tx, mut resize_rx) = mpsc::channel(1);
    let session_id = SessionId::new();

    let attach = tokio::spawn(async move {
        run_attach_session(
            client,
            session_id,
            terminal_size(),
            AttachIo::new(
                &mut input_rx,
                &mut resize_rx,
                &mut { output_writer },
                &mut RawRenderer,
                &mut DetachState::new(0x02),
            ),
        )
        .await
    });

    assert!(matches!(
        read_message::<_, ClientToServerMsg>(&mut server)
            .await
            .unwrap(),
        ClientToServerMsg::AttachSession {
            last_seen_seq: None,
            ..
        }
    ));
    write_message(
        &mut server,
        &ServerToClientMsg::Attached {
            session_id,
            initial_bytes: b"snapshot".to_vec(),
            seq: 8,
        },
    )
    .await
    .unwrap();
    write_message(
        &mut server,
        &ServerToClientMsg::Output {
            session_id,
            seq: 13,
            bytes: b"-live".as_slice().into(),
        },
    )
    .await
    .unwrap();
    write_message(
        &mut server,
        &ServerToClientMsg::Lag {
            session_id,
            skipped_bytes: 2,
        },
    )
    .await
    .unwrap();

    assert!(matches!(
        read_message::<_, ClientToServerMsg>(&mut server)
            .await
            .unwrap(),
        ClientToServerMsg::AttachSession {
            last_seen_seq: Some(13),
            ..
        }
    ));
    write_message(
        &mut server,
        &ServerToClientMsg::Attached {
            session_id,
            initial_bytes: b"-replay".to_vec(),
            seq: 20,
        },
    )
    .await
    .unwrap();
    write_message(
        &mut server,
        &ServerToClientMsg::SessionExited {
            session_id,
            exit_code: 0,
        },
    )
    .await
    .unwrap();

    assert_eq!(
        attach.await.unwrap().unwrap(),
        AttachOutcome::SessionExited(0)
    );
    let mut rendered = Vec::new();
    output_reader.read_to_end(&mut rendered).await.unwrap();
    assert_eq!(rendered, b"snapshot-live-replay");
}
