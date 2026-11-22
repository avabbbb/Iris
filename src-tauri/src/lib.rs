//! Iris Tauri 库入口。
//!
//! 模块划分：
//! - `keyring` : 操作系统 Keyring 包装（API Key 持久化）
//! - `state`   : SQLite 状态库（asset / history / templates / kv）
//! - `bridge`  : S1 迁移完成前保留的内部 IPC 桥
//! - `runtime` : 唯一 Production Runtime 与安全本地 Control API
//! - `deeplink`: flovart:// 自定义协议
//!
//! 所有 Tauri command 都通过 `commands` 模块统一注册。

pub mod bridge;
pub mod deeplink;
pub mod desktop_files;
pub mod errors;
pub mod keyring;
pub mod managed_agent;
pub mod remote_media;
pub mod runtime;
pub mod state;

use std::sync::Arc;
use tauri::Manager;

use crate::bridge::BridgeQueue;
use crate::managed_agent::ManagedAgentHost;
use crate::runtime::{default_discovery_path, ControlServer, ProductionRuntime};
use crate::state::StateDb;

/// 跨 command 共享的运行时上下文。
pub struct IrisContext {
    pub state_db: Arc<StateDb>,
    pub bridge_queue: Arc<BridgeQueue>,
}

impl IrisContext {
    pub fn new(state_db: Arc<StateDb>, bridge_queue: Arc<BridgeQueue>) -> Self {
        Self {
            state_db,
            bridge_queue,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 二开实例：把 argv 里的 flovart:// 链接转到已运行实例
            for arg in argv.iter().skip(1) {
                if arg.starts_with("flovart://") || arg.starts_with("iris://") {
                    deeplink::handle_deeplink_url(app, arg);
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.show();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // ── 1. 初始化 SQLite ──
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("resolve app_data_dir: {e}"))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|e| format!("create app_data_dir: {e}"))?;
            let db_path = app_data_dir.join("flovart-state.db");
            let state_db =
                Arc::new(StateDb::open(&db_path).map_err(|e| format!("open state db: {e}"))?);
            let production_runtime = Arc::new(
                ProductionRuntime::open(env!("CARGO_PKG_VERSION"), &db_path)
                    .map_err(|e| format!("initialize Production Runtime: {e}"))?,
            );

            // ── 2. 初始化命令桥队列 ──
            let bridge_queue = Arc::new(BridgeQueue::new());

            // ── 3. 注册 deep link（每个平台不同）──
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register("iris");
                // 更名前的旧协议（现有链接都是 flovart://），过渡期继续注册。
                let _ = app.deep_link().register("flovart");
            }

            #[cfg(not(any(target_os = "linux", all(debug_assertions, windows))))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link();
            }

            // ── 4. 启动带启动期认证的 Production Runtime Control API ──
            let ctx = IrisContext::new(state_db.clone(), bridge_queue.clone());
            let app_handle = app.handle().clone();
            let ctx_arc = Arc::new(ctx);
            let discovery_path = default_discovery_path()
                .map_err(|error| format!("resolve Production Runtime discovery path: {error}"))?;
            let control_server =
                ControlServer::start(production_runtime.clone(), discovery_path.clone())
                    .map_err(|error| format!("start Production Runtime control server: {error}"))?;
            log::info!(
                "Production Runtime control server ready; discovery={}",
                discovery_path.display()
            );
            let managed_agent = Arc::new(ManagedAgentHost::from_environment());

            // ── 5. 处理启动时可能携带的 flovart:// 链接 ──
            if let Some(args) = std::env::args().nth(1) {
                if args.starts_with("flovart://") || args.starts_with("iris://") {
                    deeplink::handle_deeplink_url(&app_handle, &args);
                }
            }

            // ── 6. 注册 deep link 事件 ──
            use tauri_plugin_deep_link::DeepLinkExt;
            let app_for_deeplink = app_handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    deeplink::handle_deeplink_url(&app_for_deeplink, url.as_str());
                }
            });

            app.manage(ctx_arc);
            app.manage(production_runtime);
            app.manage(control_server);
            app.manage(managed_agent);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // keyring
            keyring::keyring_set,
            keyring::keyring_delete,
            keyring::keyring_list,
            keyring::keyring_report_sync,
            // production runtime
            runtime::runtime_status,
            runtime::runtime_execute,
            runtime::runtime_artifact_read,
            runtime::runtime_task_wait,
            runtime::browser_import_pairing_list_pending,
            runtime::browser_import_pairing_approve,
            runtime::browser_import_pairing_reject,
            runtime::browser_import_destination_set,
            runtime::browser_import_list_pending,
            runtime::browser_import_route_to_project,
            runtime::browser_import_mark_consumed,
            runtime::browser_import_artifact_read,
            managed_agent::managed_agent_connection,
            remote_media::desktop_fetch_remote_media,
            remote_media::desktop_open_remote_url,
            desktop_files::desktop_save_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Iris");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(host) = app_handle.try_state::<Arc<ManagedAgentHost>>() {
                host.shutdown();
            }
        }
    });
}
