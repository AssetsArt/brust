#![deny(clippy::all)]

mod http;
mod io;
mod pool;
mod server;
mod shutdown;

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    "hello from brust".to_string()
}
