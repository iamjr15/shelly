use shelly_protocol::ClientKind;

/// All paired clients may create or kill sessions.
///
/// This stays as the single named chokepoint for create/kill authorization, but
/// the meaningful boundaries live at the transports: the local Unix socket is
/// `0600` user-owned (CLI trust), and the iroh transport requires a paired
/// device identity before any create/kill plus the [`requires_shell_only_sessions`]
/// command override for mobile clients.
pub fn may_create_or_kill_session(_client_kind: ClientKind) -> bool {
    true
}

/// Only the desktop CLI may emit agent-state events.
///
/// Agent state inference is driven by local Claude/Codex hooks over the Unix
/// socket; mobile clients must never inject inferred state.
pub fn may_emit_agent_state_event(client_kind: ClientKind) -> bool {
    matches!(client_kind, ClientKind::LocalCli)
}

/// Mobile clients may not choose a session's command, working directory, or
/// environment; the daemon forces a default shell session. The desktop CLI may
/// run any command. This is the server-side half of the "shell only" mobile
/// boundary — enforced even if a modified client sends a different command.
pub fn requires_shell_only_sessions(client_kind: ClientKind) -> bool {
    matches!(client_kind, ClientKind::IosApp | ClientKind::AndroidApp)
}

#[cfg(test)]
mod tests {
    use super::{
        may_create_or_kill_session, may_emit_agent_state_event, requires_shell_only_sessions,
    };
    use shelly_protocol::ClientKind;

    #[test]
    fn all_client_kinds_may_create_or_kill_sessions() {
        for kind in [
            ClientKind::LocalCli,
            ClientKind::IosApp,
            ClientKind::AndroidApp,
        ] {
            assert!(may_create_or_kill_session(kind));
        }
    }

    #[test]
    fn only_local_cli_may_emit_agent_state_events() {
        assert!(may_emit_agent_state_event(ClientKind::LocalCli));
        assert!(!may_emit_agent_state_event(ClientKind::IosApp));
        assert!(!may_emit_agent_state_event(ClientKind::AndroidApp));
    }

    #[test]
    fn only_mobile_clients_are_restricted_to_shell_only() {
        assert!(!requires_shell_only_sessions(ClientKind::LocalCli));
        assert!(requires_shell_only_sessions(ClientKind::IosApp));
        assert!(requires_shell_only_sessions(ClientKind::AndroidApp));
    }
}
