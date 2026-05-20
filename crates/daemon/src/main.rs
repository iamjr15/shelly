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
    if handle_cli_args(std::env::args().skip(1))? {
        return Ok(());
    }

    let config = config::Config::load()?;
    let _logging = logging::init(&config)?;

    ipc::serve(config).await
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
            println!("fieldworkd {}", env!("CARGO_PKG_VERSION"));
            Ok(true)
        }
        [arg, ..] => anyhow::bail!("unexpected argument {arg:?}; run fieldworkd --help"),
    }
}

fn print_help() {
    println!(
        "Fieldwork host daemon.\n\nUsage: fieldworkd [OPTIONS]\n\nOptions:\n  -h, --help       Print help\n  -V, --version    Print version"
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
