fn main() {
    println!("cargo:rerun-if-env-changed=FLUKE_GITHUB_TOKEN");
}
