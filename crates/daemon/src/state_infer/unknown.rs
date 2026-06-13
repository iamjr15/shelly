use shelly_protocol::AgentState;

pub fn infer_from_byte_count(bytes: usize) -> AgentState {
    if bytes == 0 {
        AgentState::Idle
    } else {
        AgentState::Working
    }
}
