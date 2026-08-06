fn main() {
    // sqlx::migrate! embeds the migrations directory at compile time, but
    // proc macros cannot register new files as build inputs, so a freshly
    // added migration does not trigger a recompile on cached builds.
    println!("cargo:rerun-if-changed=migrations");
}
