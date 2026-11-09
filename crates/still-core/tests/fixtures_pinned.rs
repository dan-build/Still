//! Every file under fixtures/ is pinned by its SHA-256 in fixtures/SHA256SUMS
//! (the format `shasum -a 256` writes and checks). The fixtures are the
//! evidence that existing vaults open, so a changed, added or removed file
//! fails here, and any change to them shows up in review twice: in the file
//! and in its pin. Never update a pin to make another test pass.

use std::collections::BTreeMap;
use std::path::Path;

use still_core::sodium;

fn files(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files(&path, root, out);
            continue;
        }
        let name = path
            .strip_prefix(root)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if name == "SHA256SUMS" || name.ends_with(".DS_Store") {
            continue;
        }
        let hash: String = sodium::sha256(&std::fs::read(&path).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        out.insert(name, hash);
    }
}

#[test]
fn every_fixture_matches_its_pinned_hash() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let pinned: BTreeMap<String, String> = std::fs::read_to_string(root.join("SHA256SUMS"))
        .unwrap()
        .lines()
        .map(|line| {
            let (hash, name) = line.split_once("  ").expect("`<hash>  <path>` lines");
            (name.to_owned(), hash.to_owned())
        })
        .collect();
    let mut found = BTreeMap::new();
    files(&root, &root, &mut found);

    for (name, hash) in &pinned {
        match found.get(name) {
            None => panic!("fixtures/{name} is pinned but missing"),
            Some(actual) => assert_eq!(actual, hash, "fixtures/{name} changed"),
        }
    }
    for name in found.keys() {
        assert!(pinned.contains_key(name), "fixtures/{name} isn't pinned");
    }
    assert!(pinned.len() >= 19);
}
