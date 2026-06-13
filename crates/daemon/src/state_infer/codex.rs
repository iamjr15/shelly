use serde::Deserialize;
use shelly_protocol::AgentState;

pub fn infer_from_structured_event(event_name: &str) -> Option<AgentState> {
    match event_name.trim().to_ascii_lowercase().as_str() {
        "awaiting_input" | "approval_requested" | "turn_waiting" => Some(AgentState::AwaitingInput),
        "turn_started" | "working" => Some(AgentState::Working),
        "turn_finished" | "idle" => Some(AgentState::Idle),
        "crashed" | "error" => Some(AgentState::Crashed),
        _ => None,
    }
}

pub fn infer_from_json_line(line: &str) -> Option<AgentState> {
    let event: CodexEvent = serde_json::from_str(line).ok()?;
    [
        event.event_type.as_deref(),
        event.event.as_deref(),
        event.status.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(infer_from_structured_event)
}

#[derive(Debug, Deserialize)]
struct CodexEvent {
    #[serde(rename = "type")]
    #[serde(default)]
    event_type: Option<String>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::infer_from_json_line;
    use shelly_protocol::AgentState;

    #[test]
    fn detects_state_sequence_from_remote_control_fixture() {
        let transcript = include_str!("../../tests/fixtures/codex_remote_control_redacted.jsonl");
        let states: Vec<_> = transcript
            .lines()
            .filter_map(infer_from_json_line)
            .collect();
        assert_eq!(
            states,
            vec![
                AgentState::Working,
                AgentState::Working,
                AgentState::AwaitingInput,
                AgentState::Idle,
            ]
        );
    }

    #[test]
    fn accepts_status_only_event_shapes() {
        let transcript = include_str!("../../tests/fixtures/codex_status_events_redacted.jsonl");
        let states: Vec<_> = transcript
            .lines()
            .filter_map(infer_from_json_line)
            .collect();
        assert_eq!(
            states,
            vec![
                AgentState::Working,
                AgentState::AwaitingInput,
                AgentState::Idle,
                AgentState::Crashed,
            ]
        );
    }
}
