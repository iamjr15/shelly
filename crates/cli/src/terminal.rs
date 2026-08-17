use crossterm::terminal::disable_raw_mode;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};

const TERMINAL_RESTORE: &str = "\x1b[0m\x1b[r\x1b[?6l\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l";

static RAW_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);
static ALT_SCREEN_ACTIVE: AtomicBool = AtomicBool::new(false);

pub(crate) fn install_panic_restore_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        restore_for_exit();
        default_hook(panic_info);
    }));
}

pub(crate) fn mark_raw_mode_active() {
    RAW_MODE_ACTIVE.store(true, Ordering::Release);
}

pub(crate) fn restore_raw_mode() {
    if RAW_MODE_ACTIVE.swap(false, Ordering::AcqRel) {
        let _ = disable_raw_mode();
    }
}

pub(crate) fn mark_alt_screen_active() {
    ALT_SCREEN_ACTIVE.store(true, Ordering::Release);
}

pub(crate) fn restore_alt_screen() {
    if ALT_SCREEN_ACTIVE.swap(false, Ordering::AcqRel) {
        let mut stdout = io::stdout();
        let _ = write!(stdout, "{TERMINAL_RESTORE}");
        let _ = stdout.flush();
    }
}

pub(crate) fn restore_for_exit() {
    restore_raw_mode();
    restore_alt_screen();
}

pub(crate) struct TerminationSignals {
    sigterm: tokio::signal::unix::Signal,
    sighup: tokio::signal::unix::Signal,
}

impl TerminationSignals {
    pub(crate) fn new() -> io::Result<Self> {
        Ok(Self {
            sigterm: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?,
            sighup: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())?,
        })
    }

    pub(crate) async fn recv(&mut self) -> libc::c_int {
        tokio::select! {
            _ = self.sigterm.recv() => libc::SIGTERM,
            _ = self.sighup.recv() => libc::SIGHUP,
        }
    }
}

pub(crate) fn restore_and_reraise(signal: libc::c_int) -> ! {
    restore_for_exit();
    // Tokio installs a process-wide Unix handler. Restore the default action so
    // supervisors still observe termination by the original signal.
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
        libc::raise(signal);
        libc::_exit(128 + signal);
    }
}
