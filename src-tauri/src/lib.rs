use tauri::{Manager, RunEvent};

mod autolock;
mod clipboard;
mod commands;
mod vault;
mod watcher;

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            vault::init(app);
            app.manage(clipboard::ClipboardGuard::new(Box::new(
                clipboard::Arboard::default(),
            )));
            app.manage(autolock::AutoLock::new(autolock::idle_timeout()));
            watcher::start(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_touch,
            commands::lens_new_key,
            commands::item_encrypt,
            commands::item_decrypt,
            commands::item_copy,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, event| {
        // A copied secret doesn't outlive the app.
        if let RunEvent::Exit = event {
            app.state::<clipboard::ClipboardGuard>().clear_now();
        }
    });
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    fn config() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is valid JSON")
    }

    // The identifier names the WebKit/WebView2 data folder that holds every
    // existing vault. Changing it orphans them.
    #[test]
    fn identifier_is_unchanged() {
        assert_eq!(config()["identifier"], "com.still.app");
    }

    // tauri dev keeps its vault under this origin; a new port or host hides it.
    #[test]
    fn dev_url_is_unchanged() {
        assert_eq!(config()["build"]["devUrl"], "http://localhost:3000");
    }

    // Release builds bundle whatever Vite writes here.
    #[test]
    fn frontend_dist_is_vite_output() {
        assert_eq!(config()["build"]["frontendDist"], "../dist");
    }

    // Every source a policy allows, as (directive, source) pairs.
    fn sources(policy: &Value) -> Vec<(String, String)> {
        let directives = policy.as_object().expect("the policy is a map");
        assert!(!directives.is_empty(), "the policy has directives");
        directives
            .iter()
            .flat_map(|(directive, value)| {
                let value = value.as_str().expect("sources are one string");
                value
                    .split_whitespace()
                    .map(|source| (directive.clone(), source.to_owned()))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    const RELEASE_SOURCES: [&str; 4] = [
        "'self'",
        "'none'",
        // Tauri's IPC: the custom protocol, and its Windows/Android form.
        "ipc:",
        "http://ipc.localhost",
    ];

    // The release policy allows no remote origins, no inline code and no eval
    // of any kind: the crypto runs in Rust, so the page needs no WebAssembly.
    #[test]
    fn csp_allows_only_the_app_itself() {
        let config = config();
        let security = &config["app"]["security"];
        for (directive, source) in sources(&security["csp"]) {
            assert!(
                RELEASE_SOURCES.contains(&source.as_str()),
                "csp {directive} allows {source}"
            );
        }
        assert_eq!(security["csp"]["default-src"], "'self'");
        assert_eq!(security["csp"]["script-src"], "'self'");
        assert_eq!(security["csp"]["object-src"], "'none'");
    }

    // The dev policy adds only the Vite dev server and what its hot reload
    // needs.
    #[test]
    fn dev_csp_adds_only_the_dev_server() {
        let config = config();
        let dev_extra = [
            "'unsafe-inline'",
            "http://localhost:3000",
            "ws://localhost:3000",
        ];
        for (directive, source) in sources(&config["app"]["security"]["devCsp"]) {
            assert!(
                RELEASE_SOURCES.contains(&source.as_str()) || dev_extra.contains(&source.as_str()),
                "devCsp {directive} allows {source}"
            );
        }
    }

    // Only the main window may call anything, and only the vault commands:
    // no core:default, no plugins.
    #[test]
    fn capability_allows_only_the_vault_commands_in_main() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        let allowed: Vec<String> = crate::commands::ALL
            .iter()
            .map(|c| format!("allow-{}", c.replace('_', "-")))
            .collect();
        assert_eq!(capability["permissions"], serde_json::json!(allowed));
        let build_rs = include_str!("../build.rs");
        for command in crate::commands::ALL {
            assert!(
                build_rs.contains(&format!("\"{command}\"")),
                "build.rs declares {command}"
            );
        }
    }

    #[test]
    fn prototype_is_frozen() {
        assert_eq!(config()["app"]["security"]["freezePrototype"], true);
    }
}
