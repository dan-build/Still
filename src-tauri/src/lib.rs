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
}
