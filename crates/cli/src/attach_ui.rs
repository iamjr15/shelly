use anyhow::{Context, Result};
use shelly_protocol::ClientSize;
use std::io::{self, Write};
use unicode_width::UnicodeWidthChar;

const STATUS_ROWS: u16 = 1;
const ANSI_RESET: &str = "\x1b[0m";

/// Owns the host terminal surface used while attached to a Shelly session.
///
/// The remote PTY is rendered into an outer alternate screen instead of being
/// passed through byte-for-byte. This gives Shelly a real client-owned status
/// row without injecting bytes into the session stream or corrupting ANSI
/// sequences that happen to be split across transport frames.
pub struct AttachScreenGuard;

impl AttachScreenGuard {
    pub fn enter() -> Result<Self> {
        let mut stdout = io::stdout();
        stdout
            .write_all(b"\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l")
            .and_then(|_| stdout.flush())
            .context("enter attached terminal screen")?;
        Ok(Self)
    }
}

impl Drop for AttachScreenGuard {
    fn drop(&mut self) {
        let mut stdout = io::stdout();
        // Reset input modes that the nested terminal may have enabled before
        // restoring the user's original terminal screen.
        let _ = stdout.write_all(
            b"\x1b[0m\x1b[r\x1b[?6l\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l",
        );
        let _ = stdout.flush();
    }
}

/// Stateful ANSI renderer for the desktop attach client.
///
/// `vt100::Parser` owns the nested terminal state. Rendering state diffs keeps
/// the status row outside that state, preserves application input modes, and
/// remains correct when escape sequences arrive across multiple reads.
pub struct AttachRenderer {
    parser: vt100::Parser,
    physical_size: ClientSize,
    session_name: String,
}

impl AttachRenderer {
    pub fn new(session_name: &str, physical_size: ClientSize) -> Self {
        let content_size = content_size(physical_size);
        Self {
            parser: vt100::Parser::new(content_size.rows, content_size.cols, 0),
            physical_size,
            session_name: sanitized_session_name(session_name),
        }
    }

    pub fn content_size(&self) -> ClientSize {
        content_size(self.physical_size)
    }

    pub fn initial_frame(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.parser.process(bytes);
        self.full_frame()
    }

    pub fn output_frame(&mut self, bytes: &[u8]) -> Vec<u8> {
        let previous = self.parser.screen().clone();
        self.parser.process(bytes);
        let screen = self.parser.screen();
        let mut frame = screen.contents_diff(&previous);
        frame.extend(screen.input_mode_diff(&previous));
        if frame_erases_status_row(&frame) {
            frame.extend(self.status_frame());
        }
        frame
    }

    pub fn resize(&mut self, physical_size: ClientSize) -> Vec<u8> {
        self.physical_size = physical_size;
        let content_size = self.content_size();
        self.parser
            .screen_mut()
            .set_size(content_size.rows, content_size.cols);
        self.full_frame()
    }

    fn full_frame(&self) -> Vec<u8> {
        let screen = self.parser.screen();
        let mut frame = b"\x1b[H\x1b[2J".to_vec();
        frame.extend_from_slice(format!("\x1b[?6l\x1b[1;{}r", self.content_size().rows).as_bytes());
        frame.extend(screen.contents_formatted());
        frame.extend(screen.input_mode_formatted());
        frame.extend(self.status_frame());
        frame
    }

    fn status_frame(&self) -> Vec<u8> {
        let screen = self.parser.screen();
        let mut frame = Vec::new();
        frame.extend_from_slice(b"\x1b[?25l");
        frame.extend_from_slice(format!("\x1b[{};1H", self.physical_size.rows.max(1)).as_bytes());
        frame.extend_from_slice(status_style().as_bytes());
        frame
            .extend_from_slice(status_line(&self.session_name, self.physical_size.cols).as_bytes());
        frame.extend_from_slice(ANSI_RESET.as_bytes());
        frame.extend(screen.cursor_state_formatted());
        frame.extend(screen.attributes_formatted());
        frame
    }

    #[cfg(test)]
    fn contents(&self) -> String {
        self.parser.screen().contents()
    }
}

/// One physical row belongs to the attach client; the daemon-owned PTY gets
/// the remaining rows so full-screen programs lay themselves out correctly.
pub fn content_size(physical_size: ClientSize) -> ClientSize {
    ClientSize {
        cols: physical_size.cols.max(1),
        rows: physical_size.rows.saturating_sub(STATUS_ROWS).max(1),
    }
}

pub fn status_bar_supported(physical_size: ClientSize) -> bool {
    physical_size.rows > STATUS_ROWS && physical_size.cols > 0
}

fn sanitized_session_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed.to_string()
    }
}

fn status_line(session_name: &str, cols: u16) -> String {
    let width = usize::from(cols.max(1));
    let session_name = sanitized_session_name(session_name);
    let full = format!("shelly -> {session_name}");
    let mut line = truncate_to_width(&full, width);
    let used = display_width(&line);
    line.push_str(&" ".repeat(width.saturating_sub(used)));
    line
}

fn truncate_to_width(text: &str, max_width: usize) -> String {
    if display_width(text) <= max_width {
        return text.to_string();
    }
    if max_width == 0 {
        return String::new();
    }

    let target = max_width.saturating_sub(1);
    let mut width = 0usize;
    let mut output = String::new();
    for character in text.chars() {
        let character_width = character.width().unwrap_or(0);
        if width + character_width > target {
            break;
        }
        output.push(character);
        width += character_width;
    }
    output.push('…');
    output
}

fn display_width(text: &str) -> usize {
    text.chars()
        .map(|character| character.width().unwrap_or(0))
        .sum()
}

/// The renderer's cursor addresses are bounded to the PTY viewport and its
/// scrolling region excludes the status row. Only erase-display operations
/// can cross that boundary, so those frames repaint the bar afterward.
fn frame_erases_status_row(frame: &[u8]) -> bool {
    [b"\x1b[J".as_slice(), b"\x1b[0J", b"\x1b[2J", b"\x1b[3J"]
        .iter()
        .any(|sequence| {
            frame
                .windows(sequence.len())
                .any(|window| window == *sequence)
        })
}

fn status_style() -> &'static str {
    if std::env::var("COLORTERM").is_ok_and(|value| {
        value.eq_ignore_ascii_case("truecolor") || value.eq_ignore_ascii_case("24bit")
    }) {
        "\x1b[1;38;2;17;21;18;48;2;131;175;120m"
    } else if std::env::var("TERM").is_ok_and(|value| value.contains("256color")) {
        "\x1b[1;38;5;16;48;5;108m"
    } else {
        "\x1b[1;30;42m"
    }
}

#[cfg(test)]
mod tests {
    use super::{AttachRenderer, content_size, display_width, status_bar_supported, status_line};
    use shelly_protocol::ClientSize;

    #[test]
    fn reserves_exactly_one_status_row() {
        assert_eq!(
            content_size(ClientSize {
                cols: 100,
                rows: 40
            }),
            ClientSize {
                cols: 100,
                rows: 39
            },
        );
        assert_eq!(
            content_size(ClientSize { cols: 0, rows: 1 }),
            ClientSize { cols: 1, rows: 1 },
        );
        assert!(status_bar_supported(ClientSize { cols: 80, rows: 2 }));
        assert!(!status_bar_supported(ClientSize { cols: 80, rows: 1 }));
    }

    #[test]
    fn status_line_is_sanitized_and_exactly_terminal_width() {
        let line = status_line("waffle\nignored", 40);
        assert!(line.contains("waffleignored"));
        assert_eq!(display_width(&line), 40);

        let narrow = status_line("a very long session name", 10);
        assert_eq!(display_width(&narrow), 10);
        assert!(narrow.contains('…'));
    }

    #[test]
    fn split_escape_sequences_are_parsed_before_rendering() {
        let mut renderer = AttachRenderer::new("waffle", ClientSize { cols: 40, rows: 10 });
        renderer.initial_frame(b"");
        renderer.output_frame(b"\x1b[31");
        assert!(renderer.contents().is_empty());

        renderer.output_frame(b"mred");
        assert_eq!(renderer.contents(), "red");
    }

    #[test]
    fn rendered_status_identifies_the_attached_session() {
        let mut renderer = AttachRenderer::new("waffle", ClientSize { cols: 40, rows: 10 });
        let frame = renderer.initial_frame(b"ready");
        let rendered = String::from_utf8(frame).expect("renderer emits UTF-8 plus ANSI");
        assert!(rendered.contains("shelly -> waffle"));
        assert!(rendered.contains("\x1b[10;1H"));
    }

    #[test]
    fn ordinary_output_does_not_repaint_the_stable_status_row() {
        let mut renderer = AttachRenderer::new("waffle", ClientSize { cols: 40, rows: 10 });
        renderer.initial_frame(b"");
        let frame = renderer.output_frame(b"hello");
        let rendered = String::from_utf8(frame).expect("renderer emits UTF-8 plus ANSI");
        assert!(!rendered.contains("shelly ->"));
    }
}
