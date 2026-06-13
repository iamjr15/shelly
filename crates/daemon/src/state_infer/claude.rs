use shelly_protocol::AgentState;

pub fn infer_from_line(line: &str) -> Option<AgentState> {
    let normalized = line.trim();
    let lower = normalized.to_ascii_lowercase();
    if [
        "do you want",
        "would you like",
        "should i",
        "shall i",
        "proceed?",
        "continue?",
        "is this okay",
        "is that okay",
        "approve",
        "allow",
        "permission",
        "yes/no",
        "[y/n]",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return Some(AgentState::AwaitingInput);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::infer_from_line;
    use shelly_protocol::AgentState;

    #[test]
    fn detects_awaiting_input_from_fixture() {
        let transcript = include_str!("../../tests/fixtures/claude_code_turn_redacted.txt");
        let states: Vec<_> = transcript.lines().filter_map(infer_from_line).collect();
        assert_eq!(states, vec![AgentState::AwaitingInput]);
    }

    #[test]
    fn ignores_question_marks_that_are_not_claude_prompts() {
        let transcript = include_str!("../../tests/fixtures/claude_code_no_prompt_redacted.txt");
        let states: Vec<_> = transcript.lines().filter_map(infer_from_line).collect();
        assert!(states.is_empty());
    }
}
