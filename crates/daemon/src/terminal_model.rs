use fieldwork_protocol::ClientSize;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use wezterm_term::{
    CellAttributes, Intensity, Terminal, TerminalConfiguration, TerminalSize, Underline,
    color::{ColorAttribute, ColorPalette},
};

#[derive(Debug)]
struct FieldworkTermConfig;

impl TerminalConfiguration for FieldworkTermConfig {
    fn color_palette(&self) -> ColorPalette {
        ColorPalette::default()
    }
}

#[derive(Clone)]
pub struct PtyResponseWriter {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl PtyResponseWriter {
    pub fn new(writer: Arc<Mutex<Box<dyn Write + Send>>>) -> Self {
        Self { writer }
    }
}

impl Write for PtyResponseWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("PTY writer lock poisoned"))?;
        writer.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("PTY writer lock poisoned"))?;
        writer.flush()
    }
}

pub struct TerminalModel {
    terminal: Terminal,
    response_writer: SharedWriter,
}

#[cfg(test)]
#[derive(Debug, PartialEq)]
pub(crate) struct TerminalTestState {
    pub(crate) alt_screen: bool,
    pub(crate) cursor: (usize, i64),
    pub(crate) visible_cells: Vec<Vec<(usize, String, CellAttributes)>>,
}

#[cfg(test)]
impl TerminalTestState {
    pub(crate) fn contains_text(&self, needle: &str) -> bool {
        self.visible_cells.iter().any(|line| {
            let text = line
                .iter()
                .map(|(_, text, _)| text.as_str())
                .collect::<String>();
            text.contains(needle)
        })
    }
}

#[derive(Clone)]
struct SharedWriter {
    inner: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl SharedWriter {
    fn new(writer: Box<dyn Write + Send>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(writer)),
        }
    }
}

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut writer = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("terminal response writer lock poisoned"))?;
        writer.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut writer = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("terminal response writer lock poisoned"))?;
        writer.flush()
    }
}

impl TerminalModel {
    pub fn new(size: ClientSize, writer: Box<dyn Write + Send>) -> Self {
        let response_writer = SharedWriter::new(writer);
        let terminal = Terminal::new(
            TerminalSize {
                rows: size.rows as usize,
                cols: size.cols as usize,
                pixel_width: 0,
                pixel_height: 0,
                dpi: 0,
            },
            Arc::new(FieldworkTermConfig),
            "Fieldwork",
            env!("CARGO_PKG_VERSION"),
            Box::new(response_writer.clone()),
        );
        Self {
            terminal,
            response_writer,
        }
    }

    pub fn advance_bytes(&mut self, bytes: &[u8]) {
        let mut remaining = bytes;
        while let Some(index) = find_dsr_cursor_query(remaining) {
            self.terminal.advance_bytes(&remaining[..index]);
            self.write_cursor_position_response();
            remaining = &remaining[index + DSR_CURSOR_QUERY.len()..];
        }
        self.terminal.advance_bytes(remaining);
    }

    pub fn resize(&mut self, size: ClientSize) {
        self.terminal.resize(TerminalSize {
            rows: size.rows as usize,
            cols: size.cols as usize,
            pixel_width: 0,
            pixel_height: 0,
            dpi: 0,
        });
    }

    pub fn render_snapshot(&self) -> Vec<u8> {
        let size = self.terminal.get_size();
        let screen = self.terminal.screen();
        let mut out = Vec::new();

        if self.terminal.is_alt_screen_active() {
            out.extend_from_slice(b"\x1b[?1049h");
        } else {
            out.extend_from_slice(b"\x1b[?1049l");
        }
        push_title(&mut out, self.terminal.get_title());
        out.extend_from_slice(b"\x1b[0m\x1b[H\x1b[2J");

        let start = screen.phys_row(0);
        let end = screen.phys_row(size.rows as i64);
        let lines = screen.lines_in_phys_range(start..end);
        for (row, line) in lines.iter().enumerate() {
            out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            let mut next_col = 0_usize;
            let mut current_attrs = CellAttributes::default();
            for cell in line.visible_cells() {
                let cell_col = cell.cell_index();
                while next_col < cell_col {
                    out.push(b' ');
                    next_col += 1;
                }

                let attrs = cell.attrs().clone();
                if attrs != current_attrs {
                    push_sgr(&mut out, &attrs);
                    current_attrs = attrs;
                }
                out.extend_from_slice(cell.str().as_bytes());
                next_col = cell_col.saturating_add(cell.width());
            }
            if current_attrs != CellAttributes::default() {
                out.extend_from_slice(b"\x1b[0m");
            }
        }

        let cursor = self.terminal.cursor_pos();
        out.extend_from_slice(format!("\x1b[{};{}H", cursor.y + 1, cursor.x + 1).as_bytes());
        out
    }

    pub fn last_non_empty_line(&self, max_chars: usize) -> Option<String> {
        let size = self.terminal.get_size();
        let screen = self.terminal.screen();
        let start = screen.phys_row(0);
        let end = screen.phys_row(size.rows as i64);
        screen
            .lines_in_phys_range(start..end)
            .into_iter()
            .rev()
            .find_map(|line| {
                let text = line.as_str().trim().to_string();
                (!text.is_empty()).then(|| text.chars().take(max_chars).collect())
            })
    }

    #[cfg(test)]
    pub(crate) fn test_state(&self) -> TerminalTestState {
        let cursor = self.terminal.cursor_pos();
        TerminalTestState {
            alt_screen: self.terminal.is_alt_screen_active(),
            cursor: (cursor.x, cursor.y),
            visible_cells: self.visible_cells(),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_state_after_snapshot(
        size: ClientSize,
        snapshot: &[u8],
    ) -> TerminalTestState {
        let mut client = TerminalModel::new(size, Box::new(TestSink));
        client.advance_bytes(snapshot);
        client.test_state()
    }

    #[cfg(test)]
    pub(crate) fn visible_cells(&self) -> Vec<Vec<(usize, String, CellAttributes)>> {
        let size = self.terminal.get_size();
        let screen = self.terminal.screen();
        let start = screen.phys_row(0);
        let end = screen.phys_row(size.rows as i64);
        screen
            .lines_in_phys_range(start..end)
            .into_iter()
            .map(|line| {
                line.visible_cells()
                    .map(|cell| {
                        (
                            cell.cell_index(),
                            cell.str().to_string(),
                            cell.attrs().clone(),
                        )
                    })
                    .collect()
            })
            .collect()
    }
}

#[cfg(test)]
struct TestSink;

#[cfg(test)]
impl Write for TestSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

const DSR_CURSOR_QUERY: &[u8] = b"\x1b[6n";

fn find_dsr_cursor_query(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(DSR_CURSOR_QUERY.len())
        .position(|window| window == DSR_CURSOR_QUERY)
}

impl TerminalModel {
    fn write_cursor_position_response(&mut self) {
        let cursor = self.terminal.cursor_pos();
        let response = format!("\x1b[{};{}R", cursor.y + 1, cursor.x + 1);
        let _ = self.response_writer.write_all(response.as_bytes());
        let _ = self.response_writer.flush();
    }
}

fn push_title(out: &mut Vec<u8>, title: &str) {
    out.extend_from_slice(b"\x1b]0;");
    out.extend(
        title
            .bytes()
            .filter(|byte| !matches!(byte, b'\x1b' | b'\x07')),
    );
    out.extend_from_slice(b"\x1b\\");
}

fn push_sgr(out: &mut Vec<u8>, attrs: &CellAttributes) {
    let mut params = vec!["0".to_string()];
    match attrs.intensity() {
        Intensity::Bold => params.push("1".to_string()),
        Intensity::Half => params.push("2".to_string()),
        Intensity::Normal => {}
    }
    if attrs.italic() {
        params.push("3".to_string());
    }
    if attrs.underline() != Underline::None {
        params.push("4".to_string());
    }
    if attrs.reverse() {
        params.push("7".to_string());
    }
    if attrs.strikethrough() {
        params.push("9".to_string());
    }
    push_color_param(&mut params, attrs.foreground(), true);
    push_color_param(&mut params, attrs.background(), false);

    out.extend_from_slice(b"\x1b[");
    out.extend_from_slice(params.join(";").as_bytes());
    out.push(b'm');
}

fn push_color_param(params: &mut Vec<String>, color: ColorAttribute, foreground: bool) {
    let base = if foreground { 30 } else { 40 };
    let bright_base = if foreground { 90 } else { 100 };
    match color {
        ColorAttribute::Default => {}
        ColorAttribute::PaletteIndex(index) if index < 8 => {
            params.push((base + index as u16).to_string());
        }
        ColorAttribute::PaletteIndex(index) if index < 16 => {
            params.push((bright_base + (index as u16 - 8)).to_string());
        }
        ColorAttribute::PaletteIndex(index) => {
            params.push(format!("{};5;{index}", if foreground { 38 } else { 48 }));
        }
        ColorAttribute::TrueColorWithPaletteFallback(color, _)
        | ColorAttribute::TrueColorWithDefaultFallback(color) => {
            let (red, green, blue, _) = color.to_srgb_u8();
            params.push(format!(
                "{};2;{red};{green};{blue}",
                if foreground { 38 } else { 48 }
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalModel;
    use fieldwork_protocol::ClientSize;
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};

    static TERMINAL_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct Sink;

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn model() -> TerminalModel {
        TerminalModel::new(ClientSize::default(), Box::new(Sink))
    }

    #[derive(Clone)]
    struct Capture {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.bytes
                .lock()
                .expect("capture lock poisoned")
                .extend(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn snapshot_rehydrates_visible_cells_attrs_and_cursor() {
        let _guard = TERMINAL_TEST_LOCK
            .lock()
            .expect("terminal test lock poisoned");
        let mut source = model();
        source.advance_bytes(b"hello\r\n\x1b[1;31mred\x1b[0m\r\ncursor");

        let snapshot = source.render_snapshot();
        let mut client = model();
        client.advance_bytes(&snapshot);

        assert_eq!(client.visible_cells(), source.visible_cells());
        assert_eq!(client.terminal.cursor_pos(), source.terminal.cursor_pos());
    }

    #[test]
    fn tracks_last_non_empty_line_from_terminal_state() {
        let _guard = TERMINAL_TEST_LOCK
            .lock()
            .expect("terminal test lock poisoned");
        let mut model = model();
        model.advance_bytes(b"one\r\ntwo\r\n\x1b[2Kthree");

        assert_eq!(model.last_non_empty_line(80).as_deref(), Some("three"));
    }

    #[test]
    fn writes_device_status_responses_back_to_pty() {
        let _guard = TERMINAL_TEST_LOCK
            .lock()
            .expect("terminal test lock poisoned");
        let captured = Arc::new(Mutex::new(Vec::new()));
        let mut model = TerminalModel::new(
            ClientSize::default(),
            Box::new(Capture {
                bytes: Arc::clone(&captured),
            }),
        );

        model.advance_bytes(b"\x1b[6n");

        let bytes = captured.lock().expect("capture lock poisoned").clone();
        assert_eq!(bytes, b"\x1b[1;1R");
    }
}
