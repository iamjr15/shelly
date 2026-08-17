use crate::session::{PtyWriteError, PtyWriteSender};
use alacritty_terminal::{
    event::{Event, EventListener, WindowSize},
    grid::{Dimensions, GridCell, Row},
    index::{Column, Line},
    term::{
        Config, Term, TermMode,
        cell::{Cell, Flags},
    },
    vte::ansi::{Color, NamedColor, Processor, Rgb},
};
use shelly_protocol::ClientSize;
use std::io::{self, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

const DEFAULT_TITLE: &str = "Shelly";

#[derive(Clone)]
pub struct PtyResponseWriter {
    writer: PtyWriteSender,
}

impl PtyResponseWriter {
    pub(crate) fn new(writer: PtyWriteSender) -> Self {
        Self { writer }
    }
}

impl Write for PtyResponseWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.writer.try_send(buf).map_err(|error| match error {
            PtyWriteError::Backpressure => io::Error::new(io::ErrorKind::WouldBlock, error),
            PtyWriteError::Closed => io::Error::new(io::ErrorKind::BrokenPipe, error),
        })?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub struct TerminalModel {
    terminal: Term<TermListener>,
    parser: Processor,
    title: Arc<Mutex<String>>,
    size: Arc<Mutex<ClientSize>>,
}

struct TermListener {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    title: Arc<Mutex<String>>,
    size: Arc<Mutex<ClientSize>>,
}

impl TermListener {
    fn respond(&self, bytes: &[u8]) {
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writer.write_all(bytes);
        }
    }

    fn set_title(&self, title: String) {
        if let Ok(mut current_title) = self.title.lock() {
            *current_title = title;
        }
    }
}

impl EventListener for TermListener {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(text) => self.respond(text.as_bytes()),
            Event::Title(title) => self.set_title(title),
            Event::ResetTitle => self.set_title(DEFAULT_TITLE.to_owned()),
            Event::ColorRequest(index, formatter) => {
                if let Some(color) = default_palette_color(index) {
                    self.respond(formatter(color).as_bytes());
                }
            }
            Event::TextAreaSizeRequest(formatter) => {
                let window_size = self.size.lock().ok().map(|size| WindowSize {
                    num_lines: size.rows,
                    num_cols: size.cols,
                    cell_width: 0,
                    cell_height: 0,
                });
                if let Some(window_size) = window_size {
                    self.respond(formatter(window_size).as_bytes());
                }
            }
            Event::ClipboardLoad(_, formatter) => self.respond(formatter("").as_bytes()),
            _ => {}
        }
    }
}

#[derive(Clone, Copy)]
struct TerminalDimensions {
    columns: usize,
    screen_lines: usize,
}

impl From<ClientSize> for TerminalDimensions {
    fn from(size: ClientSize) -> Self {
        Self {
            columns: size.cols as usize,
            screen_lines: size.rows as usize,
        }
    }
}

impl Dimensions for TerminalDimensions {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }

    fn screen_lines(&self) -> usize {
        self.screen_lines
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CellAttributes {
    foreground: Color,
    background: Color,
    flags: Flags,
    underline_color: Option<Color>,
}

impl CellAttributes {
    fn from_cell(cell: &Cell) -> Self {
        let style_flags = Flags::BOLD
            | Flags::DIM
            | Flags::ITALIC
            | Flags::ALL_UNDERLINES
            | Flags::INVERSE
            | Flags::HIDDEN
            | Flags::STRIKEOUT;
        Self {
            foreground: cell.fg,
            background: cell.bg,
            flags: cell.flags & style_flags,
            underline_color: cell.underline_color(),
        }
    }
}

impl Default for CellAttributes {
    fn default() -> Self {
        Self::from_cell(&Cell::default())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalProjectionFailure {
    ParserPanicked,
    InspectionPanicked,
    Unavailable,
}

impl TerminalProjectionFailure {
    pub fn invalidated_model(self) -> bool {
        matches!(self, Self::ParserPanicked | Self::Unavailable)
    }
}

/// Best-effort terminal state derived from the authoritative PTY byte stream.
///
/// Parser failures invalidate only this projection. The session reader, raw
/// scrollback, and attached clients remain live while the projection is rebuilt.
pub struct TerminalProjection {
    model: Option<TerminalModel>,
    size: ClientSize,
    last_line: Option<String>,
    last_line_dirty: bool,
    last_line_max_chars: usize,
    #[cfg(test)]
    last_line_scans: usize,
}

impl TerminalProjection {
    pub fn new(size: ClientSize, writer: Box<dyn Write + Send>) -> Self {
        Self {
            model: Some(TerminalModel::new(size, writer)),
            size,
            last_line: None,
            last_line_dirty: false,
            last_line_max_chars: 0,
            #[cfg(test)]
            last_line_scans: 0,
        }
    }

    pub fn ingest(&mut self, bytes: &[u8]) -> Result<(), TerminalProjectionFailure> {
        let Some(model) = self.model.as_mut() else {
            return Err(TerminalProjectionFailure::Unavailable);
        };
        if catch_unwind(AssertUnwindSafe(|| model.advance_bytes(bytes))).is_err() {
            self.model = None;
            return Err(TerminalProjectionFailure::ParserPanicked);
        }
        self.last_line_dirty = true;
        Ok(())
    }

    pub fn last_non_empty_line(
        &mut self,
        max_chars: usize,
    ) -> Result<Option<String>, TerminalProjectionFailure> {
        if !self.last_line_dirty && self.last_line_max_chars == max_chars {
            return Ok(self.last_line.clone());
        }
        let Some(model) = self.model.as_ref() else {
            return Err(TerminalProjectionFailure::Unavailable);
        };
        let last_line = catch_unwind(AssertUnwindSafe(|| model.last_non_empty_line(max_chars)))
            .map_err(|_| TerminalProjectionFailure::InspectionPanicked)?;
        self.last_line = last_line;
        self.last_line_dirty = false;
        self.last_line_max_chars = max_chars;
        #[cfg(test)]
        {
            self.last_line_scans += 1;
        }
        Ok(self.last_line.clone())
    }

    pub fn cache_last_non_empty_line(&mut self, last_line: String, max_chars: usize) {
        self.last_line_max_chars = max_chars;
        self.last_line = Some(last_line);
        self.last_line_dirty = false;
    }

    pub fn resize(&mut self, size: ClientSize) -> Result<(), TerminalProjectionFailure> {
        self.size = size;
        let Some(model) = self.model.as_mut() else {
            return Err(TerminalProjectionFailure::Unavailable);
        };
        match catch_unwind(AssertUnwindSafe(|| model.resize(size))) {
            Ok(()) => {
                self.last_line_dirty = true;
                Ok(())
            }
            Err(_) => {
                self.model = None;
                Err(TerminalProjectionFailure::ParserPanicked)
            }
        }
    }

    pub fn snapshot(&mut self) -> Result<Vec<u8>, TerminalProjectionFailure> {
        let Some(model) = self.model.as_ref() else {
            return Err(TerminalProjectionFailure::Unavailable);
        };
        match catch_unwind(AssertUnwindSafe(|| model.render_snapshot())) {
            Ok(snapshot) => Ok(snapshot),
            Err(_) => Err(TerminalProjectionFailure::InspectionPanicked),
        }
    }

    pub fn rebuild(
        &mut self,
        scrollback: &[u8],
        writer: Box<dyn Write + Send>,
    ) -> Result<(), TerminalProjectionFailure> {
        let size = self.size;
        match catch_unwind(AssertUnwindSafe(|| {
            let mut model = TerminalModel::new(size, writer);
            model.advance_bytes(scrollback);
            model
        })) {
            Ok(model) => {
                self.model = Some(model);
                self.last_line = None;
                self.last_line_dirty = true;
                self.last_line_max_chars = 0;
                Ok(())
            }
            Err(_) => {
                self.model = None;
                Err(TerminalProjectionFailure::ParserPanicked)
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn test_state(&self) -> TerminalTestState {
        self.model
            .as_ref()
            .expect("terminal projection unavailable")
            .test_state()
    }

    #[cfg(test)]
    pub(crate) fn render_snapshot(&self) -> Vec<u8> {
        self.model
            .as_ref()
            .expect("terminal projection unavailable")
            .render_snapshot()
    }

    #[cfg(test)]
    pub(crate) fn last_line_scans(&self) -> usize {
        self.last_line_scans
    }
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
        self.visible_text().iter().any(|line| line.contains(needle))
    }

    pub(crate) fn visible_text(&self) -> Vec<String> {
        self.visible_cells
            .iter()
            .map(|line| {
                let mut text = String::new();
                for (cell_index, cell_text, _) in line {
                    while text.chars().count() < *cell_index {
                        text.push(' ');
                    }
                    text.push_str(cell_text);
                }
                text.trim_end().to_string()
            })
            .collect()
    }
}

impl TerminalModel {
    pub fn new(size: ClientSize, writer: Box<dyn Write + Send>) -> Self {
        let title = Arc::new(Mutex::new(DEFAULT_TITLE.to_owned()));
        let shared_size = Arc::new(Mutex::new(size));
        let listener = TermListener {
            writer: Arc::new(Mutex::new(writer)),
            title: Arc::clone(&title),
            size: Arc::clone(&shared_size),
        };
        let dimensions = TerminalDimensions::from(size);
        let terminal = Term::new(Config::default(), &dimensions, listener);
        Self {
            terminal,
            parser: Processor::new(),
            title,
            size: shared_size,
        }
    }

    // Alacritty emits terminal query replies as events; `TermListener` routes
    // those events back through the session's bounded PTY writer.
    pub fn advance_bytes(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.terminal, bytes);
    }

    pub fn resize(&mut self, size: ClientSize) {
        if let Ok(mut current_size) = self.size.lock() {
            *current_size = size;
        }
        self.terminal.resize(TerminalDimensions::from(size));
    }

    pub fn render_snapshot(&self) -> Vec<u8> {
        let mut out = Vec::new();

        if self.is_alt_screen_active() {
            out.extend_from_slice(b"\x1b[?1049h");
        } else {
            out.extend_from_slice(b"\x1b[?1049l");
        }
        push_title(&mut out, &self.title());
        out.extend_from_slice(b"\x1b[0m\x1b[H\x1b[2J");

        let grid = self.terminal.grid();
        for row in 0..grid.screen_lines() {
            out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            let mut current_attrs = CellAttributes::default();
            let line = &grid[Line(row as i32)];
            let occupied = occupied_columns(line);
            for cell in &line[..Column(occupied)] {
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }

                let attrs = CellAttributes::from_cell(cell);
                if attrs != current_attrs {
                    push_sgr(&mut out, &attrs);
                    current_attrs = attrs;
                }
                push_cell_text(&mut out, cell);
            }
            if current_attrs != CellAttributes::default() {
                out.extend_from_slice(b"\x1b[0m");
            }
        }

        let (column, line) = self.cursor_pos();
        out.extend_from_slice(format!("\x1b[{};{}H", line + 1, column + 1).as_bytes());
        out
    }

    pub fn last_non_empty_line(&self, max_chars: usize) -> Option<String> {
        let grid = self.terminal.grid();
        (0..grid.screen_lines()).rev().find_map(|row| {
            let line = &grid[Line(row as i32)];
            let mut text = String::new();
            for cell in &line[..Column(occupied_columns(line))] {
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                push_cell_string(&mut text, cell);
            }
            let text = text.trim();
            (!text.is_empty()).then(|| text.chars().take(max_chars).collect())
        })
    }

    #[cfg(test)]
    pub(crate) fn test_state(&self) -> TerminalTestState {
        TerminalTestState {
            alt_screen: self.is_alt_screen_active(),
            cursor: self.cursor_pos(),
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
        let grid = self.terminal.grid();
        (0..grid.screen_lines())
            .map(|row| {
                let line = &grid[Line(row as i32)];
                line[..Column(occupied_columns(line))]
                    .iter()
                    .enumerate()
                    .filter(|(_, cell)| {
                        !cell
                            .flags
                            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                    })
                    .map(|(column, cell)| {
                        let mut text = String::new();
                        push_cell_string(&mut text, cell);
                        (column, text, CellAttributes::from_cell(cell))
                    })
                    .collect()
            })
            .collect()
    }

    fn is_alt_screen_active(&self) -> bool {
        self.terminal.mode().contains(TermMode::ALT_SCREEN)
    }

    fn title(&self) -> String {
        self.title
            .lock()
            .map(|title| title.clone())
            .unwrap_or_else(|_| DEFAULT_TITLE.to_owned())
    }

    fn cursor_pos(&self) -> (usize, i64) {
        let point = self.terminal.grid().cursor.point;
        (point.column.0, i64::from(point.line.0))
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

fn push_title(out: &mut Vec<u8>, title: &str) {
    out.extend_from_slice(b"\x1b]0;");
    out.extend(
        title
            .bytes()
            .filter(|byte| !matches!(byte, b'\x1b' | b'\x07')),
    );
    out.extend_from_slice(b"\x1b\\");
}

fn occupied_columns(line: &Row<Cell>) -> usize {
    line[..]
        .iter()
        .rposition(|cell| !cell.is_empty())
        .map_or(0, |column| column + 1)
}

fn push_cell_text(out: &mut Vec<u8>, cell: &Cell) {
    let mut encoded = [0; 4];
    out.extend_from_slice(cell.c.encode_utf8(&mut encoded).as_bytes());
    if let Some(zerowidth) = cell.zerowidth() {
        for character in zerowidth {
            out.extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
        }
    }
}

fn push_cell_string(out: &mut String, cell: &Cell) {
    out.push(cell.c);
    if let Some(zerowidth) = cell.zerowidth() {
        out.extend(zerowidth);
    }
}

fn push_sgr(out: &mut Vec<u8>, attrs: &CellAttributes) {
    out.extend_from_slice(b"\x1b[");
    let mut first = true;
    push_sgr_param(out, &mut first, 0);
    if attrs.flags.contains(Flags::BOLD) {
        push_sgr_param(out, &mut first, 1);
    }
    if attrs.flags.contains(Flags::DIM) {
        push_sgr_param(out, &mut first, 2);
    }
    if attrs.flags.contains(Flags::ITALIC) {
        push_sgr_param(out, &mut first, 3);
    }
    if attrs.flags.contains(Flags::UNDERLINE) {
        push_sgr_param(out, &mut first, 4);
    } else if attrs.flags.contains(Flags::DOUBLE_UNDERLINE) {
        push_sgr_subparams(out, &mut first, &[4, 2]);
    } else if attrs.flags.contains(Flags::UNDERCURL) {
        push_sgr_subparams(out, &mut first, &[4, 3]);
    } else if attrs.flags.contains(Flags::DOTTED_UNDERLINE) {
        push_sgr_subparams(out, &mut first, &[4, 4]);
    } else if attrs.flags.contains(Flags::DASHED_UNDERLINE) {
        push_sgr_subparams(out, &mut first, &[4, 5]);
    }
    if attrs.flags.contains(Flags::INVERSE) {
        push_sgr_param(out, &mut first, 7);
    }
    if attrs.flags.contains(Flags::HIDDEN) {
        push_sgr_param(out, &mut first, 8);
    }
    if attrs.flags.contains(Flags::STRIKEOUT) {
        push_sgr_param(out, &mut first, 9);
    }
    push_color_param(out, &mut first, attrs.foreground, 38, true);
    push_color_param(out, &mut first, attrs.background, 48, false);
    if let Some(underline_color) = attrs.underline_color {
        push_color_param(out, &mut first, underline_color, 58, false);
    }

    out.push(b'm');
}

fn push_color_param(
    out: &mut Vec<u8>,
    first: &mut bool,
    color: Color,
    extended_code: u16,
    foreground: bool,
) {
    match color {
        Color::Named(NamedColor::Foreground) if foreground => {}
        Color::Named(NamedColor::Background) if !foreground => {}
        Color::Named(named) if (named as u16) < 8 => {
            let base = if foreground { 30 } else { 40 };
            push_sgr_param(out, first, base + named as u16);
        }
        Color::Named(named) if (named as u16) < 16 => {
            let base = if foreground { 90 } else { 100 };
            push_sgr_param(out, first, base + named as u16 - 8);
        }
        Color::Indexed(index) => {
            push_sgr_param(out, first, extended_code);
            push_sgr_param(out, first, 5);
            push_sgr_param(out, first, index as u16);
        }
        Color::Spec(color) => {
            push_sgr_param(out, first, extended_code);
            push_sgr_param(out, first, 2);
            push_sgr_param(out, first, color.r as u16);
            push_sgr_param(out, first, color.g as u16);
            push_sgr_param(out, first, color.b as u16);
        }
        Color::Named(_) => {}
    }
}

fn push_sgr_param(out: &mut Vec<u8>, first: &mut bool, value: u16) {
    if !*first {
        out.push(b';');
    }
    *first = false;

    push_u16(out, value);
}

fn push_sgr_subparams(out: &mut Vec<u8>, first: &mut bool, values: &[u16]) {
    if !*first {
        out.push(b';');
    }
    *first = false;
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            out.push(b':');
        }
        push_u16(out, *value);
    }
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    let mut digits = [0_u8; 5];
    let mut cursor = digits.len();
    let mut remaining = value;
    loop {
        cursor -= 1;
        digits[cursor] = b'0' + (remaining % 10) as u8;
        remaining /= 10;
        if remaining == 0 {
            break;
        }
    }
    out.extend_from_slice(&digits[cursor..]);
}

const fn rgb(r: u8, g: u8, b: u8) -> Rgb {
    Rgb { r, g, b }
}

fn default_palette_color(index: usize) -> Option<Rgb> {
    const ANSI: [Rgb; 16] = [
        rgb(0x00, 0x00, 0x00),
        rgb(0xcc, 0x55, 0x55),
        rgb(0x55, 0xcc, 0x55),
        rgb(0xcd, 0xcd, 0x55),
        rgb(0x54, 0x55, 0xcb),
        rgb(0xcc, 0x55, 0xcc),
        rgb(0x7a, 0xca, 0xca),
        rgb(0xcc, 0xcc, 0xcc),
        rgb(0x55, 0x55, 0x55),
        rgb(0xff, 0x55, 0x55),
        rgb(0x55, 0xff, 0x55),
        rgb(0xff, 0xff, 0x55),
        rgb(0x55, 0x55, 0xff),
        rgb(0xff, 0x55, 0xff),
        rgb(0x55, 0xff, 0xff),
        rgb(0xff, 0xff, 0xff),
    ];

    match index {
        0..=15 => Some(ANSI[index]),
        16..=231 => {
            const RAMP: [u8; 6] = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
            let cube = index - 16;
            Some(rgb(RAMP[cube / 36], RAMP[cube / 6 % 6], RAMP[cube % 6]))
        }
        232..=255 => {
            let grey = 8 + (index as u8 - 232) * 10;
            Some(rgb(grey, grey, grey))
        }
        256 | 267 => Some(rgb(0xb2, 0xb2, 0xb2)),
        257 | 268 => Some(ANSI[0]),
        258 => Some(rgb(0x52, 0xad, 0x70)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{TerminalModel, TerminalProjection};
    use shelly_protocol::ClientSize;
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

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
        assert_eq!(client.cursor_pos(), source.cursor_pos());
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
    fn projection_materializes_last_line_lazily_and_caches_it() {
        let _guard = TERMINAL_TEST_LOCK
            .lock()
            .expect("terminal test lock poisoned");
        let mut projection = TerminalProjection::new(ClientSize::default(), Box::new(Sink));

        projection.ingest(b"one\r\ntwo").unwrap();
        assert_eq!(projection.last_line_scans(), 0);
        assert_eq!(
            projection.last_non_empty_line(80).unwrap().as_deref(),
            Some("two")
        );
        assert_eq!(projection.last_line_scans(), 1);

        assert_eq!(
            projection.last_non_empty_line(80).unwrap().as_deref(),
            Some("two")
        );
        assert_eq!(projection.last_line_scans(), 1);

        projection.ingest(b"\r\nthree").unwrap();
        assert_eq!(projection.last_line_scans(), 1);
        assert_eq!(
            projection.last_non_empty_line(80).unwrap().as_deref(),
            Some("three")
        );
        assert_eq!(projection.last_line_scans(), 2);
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

        // Keep a bounded poll so this remains safe if response dispatch becomes
        // asynchronous in a future terminal backend revision.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let bytes = captured.lock().expect("capture lock poisoned").clone();
            if bytes == b"\x1b[1;1R" {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "DSR response not written before timeout: {bytes:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn tracks_last_line_after_codex_reverse_index_scrolling() {
        let _guard = TERMINAL_TEST_LOCK
            .lock()
            .expect("terminal test lock poisoned");
        let mut model = model();
        model.advance_bytes(b"\x1b[1;24r\x1b[1;1H\x1bM\x1bM\x1bM\x1bM\x1bM\x1bM\x1bM\x1bM\x1bM");
        let _ = model.last_non_empty_line(80);
    }
}
