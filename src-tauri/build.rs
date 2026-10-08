// The app's own commands. Declaring them makes Tauri refuse any command a
// capability doesn't allow; capabilities/default.json allows exactly these,
// for the main window only. Keep in step with commands::ALL.
const COMMANDS: &[&str] = &[
    "vault_create",
    "vault_unlock",
    "vault_lock",
    "vault_touch",
    "lens_new_key",
    "item_encrypt",
    "item_decrypt",
    "item_copy",
    "storage_load",
    "storage_write",
    "storage_import_legacy",
    "vault_state",
    "vault_set_aside",
    "lens_create",
    "lens_rename",
    "lens_forget",
    "lens_restore",
    "lens_delete",
    "item_add",
    "item_update",
    "item_delete",
    "item_reveal",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
