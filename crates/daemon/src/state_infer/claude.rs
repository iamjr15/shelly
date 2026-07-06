use shelly_protocol::AgentState;

// Phrases that only appear when Claude is asking the user something.
const STRONG_PROMPTS: [&str; 8] = [
    "do you want",
    "would you like",
    "proceed?",
    "continue?",
    "is this okay",
    "is that okay",
    "yes/no",
    "[y/n]",
];

// Words that also show up in ordinary streamed narration ("allow edits",
// "permission denied"), so alone they are not evidence of a prompt.
const LOOSE_KEYWORDS: [&str; 3] = ["approve", "allow", "permission"];

pub fn infer_from_line(line: &str) -> Option<AgentState> {
    let normalized = line.trim();
    let lower = normalized.to_ascii_lowercase();
    if STRONG_PROMPTS.iter().any(|needle| lower.contains(needle))
        || asks_first_person_question(&lower)
        || (LOOSE_KEYWORDS.iter().any(|needle| lower.contains(needle)) && has_prompt_marker(&lower))
    {
        return Some(AgentState::AwaitingInput);
    }
    None
}

// "should i"/"shall i" need a word boundary after the "i" so mid-sentence
// text like "should increase" does not match.
fn asks_first_person_question(lower: &str) -> bool {
    ["should i", "shall i"].iter().any(|phrase| {
        lower.match_indices(phrase).any(|(index, _)| {
            !lower[index + phrase.len()..]
                .chars()
                .next()
                .is_some_and(|next| next.is_ascii_alphanumeric())
        })
    })
}

fn has_prompt_marker(lower: &str) -> bool {
    lower.ends_with('?')
        || lower.contains("[y/n]")
        || lower.contains("yes/no")
        || is_numbered_option(lower)
}

// Permission dialogs usually leave a numbered option list as the last visible
// line ("❯ 1. Yes" / "2. Yes, allow all edits ..."), not the question itself.
fn is_numbered_option(lower: &str) -> bool {
    let rest = lower.trim_start_matches('❯').trim_start();
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && rest[digits..].starts_with(". ")
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

    #[test]
    fn ignores_streamed_narration_containing_loose_keywords() {
        assert_eq!(
            infer_from_line("Updated settings to allow edits in this directory"),
            None
        );
        assert_eq!(
            infer_from_line("tail: /var/log/secure: Permission denied"),
            None
        );
        assert_eq!(infer_from_line("I approve of this API shape."), None);
        assert_eq!(
            infer_from_line("We should increase the timeout to 30s"),
            None
        );
    }

    #[test]
    fn detects_permission_dialog_option_lists() {
        assert_eq!(
            infer_from_line("❯ 1. Yes, allow all edits during this session"),
            Some(AgentState::AwaitingInput)
        );
        assert_eq!(
            infer_from_line("  2. Yes, approve this command"),
            Some(AgentState::AwaitingInput)
        );
        assert_eq!(
            infer_from_line("Grant permission to read ~/.ssh/config?"),
            Some(AgentState::AwaitingInput)
        );
    }

    #[test]
    fn detects_first_person_questions_at_word_boundaries() {
        assert_eq!(
            infer_from_line("Should I create the migration now?"),
            Some(AgentState::AwaitingInput)
        );
        assert_eq!(infer_from_line("Shall I"), Some(AgentState::AwaitingInput));
    }
}
