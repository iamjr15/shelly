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
    let config = config::Config::load()?;
    let _logging = logging::init(&config)?;

    ipc::serve(config).await
}
