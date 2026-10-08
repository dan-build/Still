//! Replays fixtures/vault-behaviour-v1/scenarios.json, recorded from the
//! TypeScript backend, against the Rust one. The fixture's header documents
//! every rule this follows (operations, aliases, masking).
//!
//! The keys are the real v1 crypto except for the password step: a keyed
//! hash instead of Argon2id, so the many unlocks stay fast. Two scenarios
//! also run with the real `Unlocked`.

mod common;

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use common::vault::{FastKeys, Memory};
use serde_json::{json, Map, Value};
use still_core::session::{SecretText, Unlocked};
use still_core::vault::backend::{Backend, Keys, Storage};
use still_core::vault::time;

// ---- masking, as the fixture's header describes ----------------------------------------

#[derive(Default)]
struct Masker {
    names: Vec<(String, String)>,
    ids: usize,
    blobs: usize,
}

impl Masker {
    fn add(&mut self, value: Option<&Value>, id: bool) {
        let Some(value) = value.and_then(Value::as_str) else {
            return;
        };
        if value.is_empty() || self.names.iter().any(|(v, _)| v == value) {
            return;
        }
        let fits = if id {
            value.len() == 32
                && value
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        } else {
            let body = value.trim_end_matches('=');
            value.len() - body.len() <= 2
                && body.len() >= 16
                && body
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        };
        if !fits {
            return;
        }
        let name = if id {
            self.ids += 1;
            format!("<id-{}>", self.ids)
        } else {
            self.blobs += 1;
            format!("<blob-{}>", self.blobs)
        };
        self.names.push((value.to_owned(), name));
    }

    fn learn(&mut self, result: Option<&Value>, data: &BTreeMap<String, String>) {
        self.add(result, true);
        for (key, value) in data {
            if key.ends_with("still-encrypted-master-key") || key.ends_with("still-salt") {
                self.add(Some(&Value::String(value.clone())), false);
            }
            if !(key.ends_with("still-lenses") || key.ends_with("still-recycle-bin")) {
                continue;
            }
            let Ok(Value::Array(list)) = serde_json::from_str::<Value>(value) else {
                continue;
            };
            for lens in list.iter().filter(|l| l.is_object()) {
                self.add(lens.get("id"), true);
                self.add(lens.get("encryptedMasterKey"), false);
                let Some(items) = lens.get("items").and_then(Value::as_array) else {
                    continue;
                };
                for item in items.iter().filter(|i| i.is_object()) {
                    self.add(item.get("id"), true);
                    self.add(item.get("encryptedValue"), false);
                }
            }
        }
    }

    fn mask(&self, text: &str) -> String {
        if let Some((_, name)) = self.names.iter().find(|(v, _)| v == text) {
            return name.clone();
        }
        let mut out = text.to_owned();
        for (value, name) in &self.names {
            out = out.replace(&format!("\"{value}\""), &format!("\"{name}\""));
        }
        out
    }

    fn mask_deep(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.mask(s)),
            Value::Array(items) => Value::Array(items.iter().map(|v| self.mask_deep(v)).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), self.mask_deep(v)))
                    .collect::<Map<_, _>>(),
            ),
            other => other.clone(),
        }
    }
}

// ---- the replay ----------------------------------------------------------------------

const START: &str = "2026-10-08T12:00:00.000Z";

struct Run<K: Keys> {
    disk: Memory,
    clock: Arc<AtomicI64>,
    backend: Backend<Memory, K>,
    aliases: HashMap<String, String>,
}

impl<K: Keys> Run<K> {
    fn new() -> Self {
        let disk = Memory::default();
        let clock = Arc::new(AtomicI64::new(time::parse_iso(START).unwrap()));
        let backend = Self::open(&disk, &clock);
        Self {
            disk,
            clock,
            backend,
            aliases: HashMap::new(),
        }
    }

    fn open(disk: &Memory, clock: &Arc<AtomicI64>) -> Backend<Memory, K> {
        let clock = clock.clone();
        Backend::new(disk.clone(), Arc::new(move || clock.load(Ordering::SeqCst)))
    }

    fn lists(&self) -> Vec<Value> {
        ["still-lenses", "still-recycle-bin"]
            .iter()
            .flat_map(|key| {
                let raw = self.disk.get(key).unwrap_or_else(|| "[]".into());
                match serde_json::from_str(&raw) {
                    Ok(Value::Array(list)) => list,
                    _ => vec![],
                }
            })
            .collect()
    }

    /// `$X`, `$X.key` and `$X.value`, as the fixture's header describes.
    fn resolve(&self, text: &str) -> String {
        let mut out = String::new();
        let mut rest = text;
        while let Some(at) = rest.find('$') {
            out.push_str(&rest[..at]);
            let after = &rest[at + 1..];
            let len = after
                .find(|c: char| !c.is_ascii_alphanumeric())
                .unwrap_or(after.len());
            let id = &self.aliases[&after[..len]];
            rest = &after[len..];
            let field = [(".key", "encryptedMasterKey"), (".value", "encryptedValue")]
                .into_iter()
                .find(|(suffix, _)| rest.starts_with(suffix));
            match field {
                None => out.push_str(id),
                Some((suffix, name)) => {
                    rest = &rest[suffix.len()..];
                    let lists = self.lists();
                    let found = if name == "encryptedMasterKey" {
                        lists
                            .iter()
                            .find(|l| l["id"] == *id)
                            .map(|l| l[name].clone())
                    } else {
                        lists
                            .iter()
                            .flat_map(|l| l["items"].as_array().cloned().unwrap_or_default())
                            .find(|i| i["id"] == *id)
                            .map(|i| i[name].clone())
                    };
                    out.push_str(
                        found
                            .and_then(|v| v.as_str().map(str::to_owned))
                            .as_deref()
                            .unwrap(),
                    );
                }
            }
        }
        out.push_str(rest);
        out
    }

    fn arg(&self, step: &Value, name: &str) -> String {
        self.resolve(
            step[name]
                .as_str()
                .unwrap_or_else(|| panic!("{name} in {step}")),
        )
    }

    fn secret(step: &Value, name: &str) -> SecretText {
        SecretText::from(step[name].as_str().unwrap().to_owned())
    }

    /// Runs one step; returns its result and what went to the clipboard.
    fn step(&mut self, step: &Value) -> (Value, Option<String>) {
        let error = |e: still_core::vault::backend::VaultError| json!({ "error": e.code() });
        let done = |r: Result<(), _>| r.map_or_else(error, |()| Value::Null);
        let op = step["op"].as_str().unwrap();
        let result = match op {
            "clock" => {
                let now = time::parse_iso(step["now"].as_str().unwrap()).unwrap();
                self.clock.store(now, Ordering::SeqCst);
                Value::Null
            }
            "reopen" => {
                self.backend = Self::open(&self.disk, &self.clock);
                Value::Null
            }
            "setStored" => {
                let key = step["key"].as_str().unwrap().to_owned();
                let value = step["value"].as_str().map(|value| self.resolve(value));
                let mut disk = self.disk.0.borrow_mut();
                match value {
                    Some(value) => disk.data.insert(key, value),
                    None => disk.data.remove(&key),
                };
                Value::Null
            }
            "failWrites" => {
                let mut disk = self.disk.0.borrow_mut();
                disk.fail_all = step["keys"] == "all";
                disk.fail_keys = step["keys"]
                    .as_array()
                    .map(|keys| {
                        keys.iter()
                            .map(|k| k.as_str().unwrap().to_owned())
                            .collect()
                    })
                    .unwrap_or_default();
                Value::Null
            }
            "status" => json!(self.backend.status().code()),
            "create" => done(self.backend.create(&Self::secret(step, "password"))),
            "unlock" => match self.backend.unlock(&Self::secret(step, "password")) {
                Ok(()) => json!({ "ok": true }),
                Err(reason) => json!({ "ok": false, "reason": reason.code() }),
            },
            "lock" => {
                self.backend.lock();
                Value::Null
            }
            "setAside" => self.backend.set_aside().map_or_else(error, Value::String),
            "createLens" => match self.backend.create_lens(&self.arg(step, "name")) {
                Ok(id) => {
                    if let Some(alias) = step["as"].as_str() {
                        self.aliases.insert(alias.to_owned(), id.clone());
                    }
                    Value::String(id)
                }
                Err(e) => error(e),
            },
            "addItem" => {
                let lens = self.arg(step, "lens");
                let result = self.backend.add_item(
                    &lens,
                    &self.arg(step, "label"),
                    step["type"].as_str().unwrap(),
                    &Self::secret(step, "value"),
                );
                if let (Ok(()), Some(alias)) = (result, step["as"].as_str()) {
                    let view = self.backend.view();
                    let lens = view.lenses.iter().find(|l| l["id"] == *lens).unwrap();
                    let last = lens["items"].as_array().unwrap().last().unwrap();
                    self.aliases
                        .insert(alias.to_owned(), last["id"].as_str().unwrap().to_owned());
                }
                done(result)
            }
            "updateItem" => {
                let value = step.get("value").map(|_| Self::secret(step, "value"));
                done(self.backend.update_item(
                    &self.arg(step, "lens"),
                    &self.arg(step, "item"),
                    &self.arg(step, "label"),
                    step["type"].as_str().unwrap(),
                    value.as_ref(),
                ))
            }
            "deleteItem" => done(
                self.backend
                    .delete_item(&self.arg(step, "lens"), &self.arg(step, "item")),
            ),
            "renameLens" => done(
                self.backend
                    .rename_lens(&self.arg(step, "lens"), &self.arg(step, "name")),
            ),
            "revealItem" | "copyItem" => {
                match self
                    .backend
                    .reveal_item(&self.arg(step, "lens"), &self.arg(step, "item"))
                {
                    Ok(value) if op == "copyItem" => {
                        return (Value::Null, Some(value.expose().to_owned()))
                    }
                    Ok(value) => Value::String(value.expose().to_owned()),
                    Err(e) => error(e),
                }
            }
            "forgetLens" => done(self.backend.forget_lens(&self.arg(step, "lens"))),
            "restoreLens" => done(self.backend.restore_lens(&self.arg(step, "lens"))),
            "deleteLensForever" => done(self.backend.delete_lens_forever(&self.arg(step, "lens"))),
            other => panic!("unknown operation {other}"),
        };
        (result, None)
    }
}

/// Replays one scenario, comparing every step. Stops early, and returns the
/// step number, at a step `stop_at` accepts (a documented Rust difference).
fn replay<K: Keys>(scenario: &Value, stop_at: impl Fn(&Value, &Value) -> bool) -> Option<usize> {
    let name = scenario["name"].as_str().unwrap();
    let mut run = Run::<K>::new();
    let mut masker = Masker::default();
    let (mut last_view, mut last_stored) = (Value::Null, Value::Null);
    for (n, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        run.disk.0.borrow_mut().writes.clear();
        let (result, clipboard) = run.step(step);
        let data = run.disk.0.borrow().data.clone();
        masker.learn((step["op"] == "createLens").then_some(&result), &data);
        let view = masker.mask_deep(&run.backend.view().to_json());
        let stored = masker.mask_deep(&json!(data));
        let mut actual = Map::new();
        actual.insert("result".into(), masker.mask_deep(&result));
        actual.insert("status".into(), json!(run.backend.status().code()));
        if view != last_view {
            actual.insert("view".into(), view.clone());
        }
        if stored != last_stored {
            actual.insert("stored".into(), stored.clone());
        }
        actual.insert("writes".into(), json!(run.disk.0.borrow().writes));
        if let Some(clipboard) = clipboard {
            actual.insert("clipboard".into(), json!(clipboard));
        }
        let actual = Value::Object(actual);
        if stop_at(step, &actual) {
            return Some(n + 1);
        }
        assert_eq!(actual, step["expect"], "{name}, step {}: {}", n + 1, {
            let mut shown = step.clone();
            shown.as_object_mut().unwrap().remove("expect");
            shown
        });
        (last_view, last_stored) = (view, stored);
    }
    None
}

fn scenarios() -> Vec<Value> {
    let path = format!(
        "{}/../../fixtures/vault-behaviour-v1/scenarios.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = without_lone_surrogates(&std::fs::read_to_string(path).unwrap());
    let fixture: Value = serde_json::from_str(&text).unwrap();
    fixture["scenarios"].as_array().unwrap().clone()
}

/// serde_json can't read a lone UTF-16 surrogate escape. The fixture has
/// some only where the lone-surrogate scenario shows what JavaScript read,
/// past the step where Rust stops, so they become U+FFFD here.
fn without_lone_surrogates(json: &str) -> String {
    let surrogate = |hex: &str| {
        u16::from_str_radix(hex, 16)
            .ok()
            .filter(|u| (0xD800..0xE000).contains(u))
    };
    let mut out = String::with_capacity(json.len());
    let mut rest = json;
    while let Some(at) = rest.find('\\') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let escape = rest.get(..6).filter(|e| e.starts_with("\\u"));
        let Some(unit) = escape.and_then(|e| surrogate(&e[2..])) else {
            // Any other escape is two characters; copy it whole.
            out.push_str(&rest[..2]);
            rest = &rest[2..];
            continue;
        };
        let pair = (0xD800..0xDC00).contains(&unit)
            && rest
                .get(6..12)
                .filter(|e| e.starts_with("\\u"))
                .and_then(|e| surrogate(&e[2..]))
                .is_some_and(|low| low >= 0xDC00);
        if pair {
            out.push_str(&rest[..12]);
            rest = &rest[12..];
        } else {
            out.push_str("\\ufffd");
            rest = &rest[6..];
        }
    }
    out.push_str(rest);
    out
}

fn scenario(name: &str) -> Value {
    scenarios().into_iter().find(|s| s["name"] == name).unwrap()
}

#[test]
fn replays_every_scenario_the_typescript_backend_recorded() {
    let mut replayed = 0;
    for scenario in scenarios() {
        // These differ on purpose; their own tests below cover them.
        if scenario.get("rust").is_some() {
            continue;
        }
        assert_eq!(replay::<FastKeys>(&scenario, |_, _| false), None);
        replayed += 1;
    }
    assert_eq!(replayed, 15);
}

#[test]
fn replays_scenarios_with_the_real_keys_too() {
    for name in ["lenses-and-items", "unreadable-lenses"] {
        assert_eq!(replay::<Unlocked>(&scenario(name), |_, _| false), None);
    }
}

// TypeScript could read back a lone UTF-16 surrogate and write it again;
// serde_json can't hold one, so Rust refuses the list instead of changing it.
#[test]
fn refuses_a_list_with_a_lone_surrogate_instead_of_changing_it() {
    let stopped = replay::<FastKeys>(&scenario("lone-surrogate"), |step, actual| {
        step["op"] == "unlock" && step["expect"]["result"]["ok"] == true && {
            assert_eq!(
                actual["result"],
                json!({ "ok": false, "reason": "unreadable-data" })
            );
            assert_eq!(actual["status"], "locked");
            assert_eq!(actual["writes"], json!([]));
            assert!(actual.get("stored").is_none());
            true
        }
    });
    assert_eq!(stopped, Some(6));
}
