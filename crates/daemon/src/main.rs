mod authz;
mod config;
mod forward;
mod ipc;
mod logging;
mod pairing;
mod paths;
mod persistence;
mod privacy_tracing;
mod push;
mod ring;
mod session;
mod state_infer;
mod terminal_model;
mod transport_iroh;

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    ensure_standard_fds_open()?;

    // Install the ring rustls CryptoProvider as the process default before any TLS work (the iroh
    // transport and the reqwest relay-control HTTPS client). reqwest is built rustls-no-provider,
    // so without an installed default the first HTTPS request to the relay control plane would fail.
    let _ = rustls::crypto::ring::default_provider().install_default();

    if handle_cli_args(std::env::args().skip(1))? {
        return Ok(());
    }

    let config = config::Config::load()?;
    let _logging = logging::init(&config)?;

    ipc::serve(config).await
}

#[cfg(unix)]
fn ensure_standard_fds_open() -> Result<()> {
    for fd in 0..=2 {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags != -1 {
            continue;
        }

        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EBADF) {
            return Err(error.into());
        }

        let path = c"/dev/null";
        let opened = unsafe { libc::open(path.as_ptr(), libc::O_RDWR) };
        if opened == -1 {
            return Err(std::io::Error::last_os_error().into());
        }
        if opened != fd {
            if unsafe { libc::dup2(opened, fd) } == -1 {
                let dup_error = std::io::Error::last_os_error();
                unsafe {
                    libc::close(opened);
                }
                return Err(dup_error.into());
            }
            unsafe {
                libc::close(opened);
            }
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_standard_fds_open() -> Result<()> {
    Ok(())
}

fn handle_cli_args(args: impl IntoIterator<Item = String>) -> Result<bool> {
    let args = args.into_iter().collect::<Vec<_>>();
    match args.as_slice() {
        [] => Ok(false),
        [flag] if flag == "-h" || flag == "--help" => {
            print_help();
            Ok(true)
        }
        [flag] if flag == "-V" || flag == "--version" => {
            println!("shellyd {}", env!("CARGO_PKG_VERSION"));
            Ok(true)
        }
        [arg, ..] => anyhow::bail!("unexpected argument {arg:?}; run shellyd --help"),
    }
}

fn print_help() {
    println!(
        "Shelly host daemon.\n\nUsage: shellyd [OPTIONS]\n\nOptions:\n  -h, --help       Print help\n  -V, --version    Print version"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_cli_args_start_by_default() {
        assert!(!handle_cli_args([]).unwrap());
    }

    #[test]
    fn daemon_cli_args_handle_help_and_version() {
        assert!(handle_cli_args(["--help".to_string()]).unwrap());
        assert!(handle_cli_args(["-h".to_string()]).unwrap());
        assert!(handle_cli_args(["--version".to_string()]).unwrap());
        assert!(handle_cli_args(["-V".to_string()]).unwrap());
    }

    #[test]
    fn daemon_cli_args_reject_unknown_arguments() {
        assert!(handle_cli_args(["--bogus".to_string()]).is_err());
    }
}
