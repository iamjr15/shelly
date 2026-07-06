pub mod claude;
pub mod codex;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandKind {
    Claude,
    Codex,
    Unknown,
}

pub fn classify(command: &[String]) -> CommandKind {
    let Some(program) = command.first() else {
        return CommandKind::Unknown;
    };

    let name = std::path::Path::new(program)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(program);

    match name {
        "claude" | "claude-code" => CommandKind::Claude,
        "codex" | "codex-exec" => CommandKind::Codex,
        _ => CommandKind::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandKind, classify};

    #[test]
    fn classifies_known_agents() {
        assert_eq!(classify(&["claude".to_string()]), CommandKind::Claude);
        assert_eq!(classify(&["codex".to_string()]), CommandKind::Codex);
        assert_eq!(classify(&["bash".to_string()]), CommandKind::Unknown);
    }
}
