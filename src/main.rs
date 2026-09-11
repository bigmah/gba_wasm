//! Static web server for the browser-based mGBA front end.
//!
//! It serves the emulator app and nothing else — ROMs are supplied by the user
//! in the browser and live in the browser's own storage, so no game data ever
//! touches this server.
//!
//! The mGBA build we ship is threaded, so every response carries the
//! cross-origin isolation headers that `SharedArrayBuffer` requires. Without
//! them the core refuses to start.

use axum::{http::{header, HeaderValue}, Router};
use std::{net::IpAddr, path::PathBuf};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

struct Config {
    host: IpAddr,
    port: u16,
    web_dir: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".parse().unwrap(),
            port: 8080,
            web_dir: PathBuf::from("web"),
        }
    }
}

fn usage() -> ! {
    eprintln!(
        "gba-wasm

USAGE:
    cargo run --release -- [OPTIONS]

OPTIONS:
    -p, --port <PORT>      Port to listen on            [default: 8080]
        --host <ADDR>      Address to bind              [default: 127.0.0.1]
        --web-dir <DIR>    Directory of static assets   [default: web]
    -h, --help             Show this message"
    );
    std::process::exit(0)
}

fn parse_args() -> Config {
    let mut cfg = Config::default();
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        let mut value = |flag: &str| -> String {
            args.next().unwrap_or_else(|| {
                eprintln!("error: {flag} requires a value");
                std::process::exit(2)
            })
        };

        match arg.as_str() {
            "-p" | "--port" => {
                let raw = value("--port");
                cfg.port = raw.parse().unwrap_or_else(|_| {
                    eprintln!("error: invalid port {raw:?}");
                    std::process::exit(2)
                });
            }
            "--host" => {
                let raw = value("--host");
                cfg.host = raw.parse().unwrap_or_else(|_| {
                    eprintln!("error: invalid host {raw:?}");
                    std::process::exit(2)
                });
            }
            "--web-dir" => cfg.web_dir = PathBuf::from(value("--web-dir")),
            "-h" | "--help" => usage(),
            other => {
                eprintln!("error: unrecognized argument {other:?}\n");
                usage()
            }
        }
    }
    cfg
}

#[tokio::main]
async fn main() {
    let cfg = parse_args();

    if !cfg.web_dir.join("vendor/mgba.wasm").exists() {
        eprintln!(
            "error: {} does not contain vendor/mgba.wasm\n\
             hint: run this from the project root, or pass --web-dir",
            cfg.web_dir.display()
        );
        std::process::exit(1);
    }

    let static_files = ServeDir::new(&cfg.web_dir)
        .append_index_html_on_directories(true)
        .precompressed_gzip();

    let app = Router::new()
        .fallback_service(static_files)
        // Cross-origin isolation: required for the threaded mGBA core to get
        // SharedArrayBuffer. These must be present on every response.
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        // Local dev: always revalidate so edits to web/ show up on reload.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ));

    let addr = std::net::SocketAddr::new(cfg.host, cfg.port);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("error: cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    println!("gba-wasm");
    println!("  serving  {}", cfg.web_dir.display());
    println!("  ready at http://{addr}/");
    println!("  (add ROMs from the page; ctrl-c to stop)");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            println!("\nshutting down");
        })
        .await
        .unwrap();
}
