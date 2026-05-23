#![deny(clippy::all)]

mod http;

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    "hello from brust".to_string()
}
