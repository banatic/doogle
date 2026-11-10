// Release builds on Windows have no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    doogle_desk_lib::run()
}
