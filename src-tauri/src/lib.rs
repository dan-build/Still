use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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

    const RELEASE_SOURCES: [&str; 5] = [
        "'self'",
        "'none'",
        // libsodium compiles its embedded wasm at runtime.
        "'wasm-unsafe-eval'",
        // Tauri's IPC: the custom protocol, and its Windows/Android form.
        "ipc:",
        "http://ipc.localhost",
    ];

    // The release policy allows no remote origins, no inline code and no eval.
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

    #[test]
    fn prototype_is_frozen() {
        assert_eq!(config()["app"]["security"]["freezePrototype"], true);
    }
}
