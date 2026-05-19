use fieldwork_protocol::ClientKind;

pub fn may_create_or_kill_session(client_kind: ClientKind) -> bool {
    matches!(client_kind, ClientKind::LocalCli)
}

#[cfg(test)]
mod tests {
    use super::may_create_or_kill_session;
    use fieldwork_protocol::ClientKind;

    #[test]
    fn only_local_cli_can_create_or_kill_sessions() {
        assert!(may_create_or_kill_session(ClientKind::LocalCli));
        assert!(!may_create_or_kill_session(ClientKind::IosApp));
        assert!(!may_create_or_kill_session(ClientKind::AndroidApp));
    }
}
