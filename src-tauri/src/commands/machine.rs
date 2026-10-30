//! The machine a window works on (Remote Development's host status) and the
//! ports forwarded to it. In a remote window `machine_*` run on its server.

use crate::state::AppState;
use ide_core::IdeResult;
use ide_host::ops::machine::{ListeningPort, MachineStatus};
use ide_ssh::{ForwardRequest, PortForward};
use tauri::{State, Window};

/// CPU, memory, disk, load and uptime of the machine.
#[tauri::command]
#[specta::specta]
pub async fn machine_status(window: Window, state: State<'_, AppState>) -> IdeResult<MachineStatus> {
    ide_host::ops::machine::status(&state.host, AppState::owner_window(window.label())).await
}

/// The TCP ports the user's processes listen on.
#[tauri::command]
#[specta::specta]
pub async fn machine_ports(state: State<'_, AppState>) -> IdeResult<Vec<ListeningPort>> {
    ide_host::ops::machine::listening_ports(&state.host).await
}

/// The ports this window forwards.
#[tauri::command]
#[specta::specta]
pub fn ports_list(window: Window, state: State<'_, AppState>) -> Vec<PortForward> {
    state.ports.list(AppState::owner_window(window.label()))
}

/// Forwards a port of an SSH host to this machine (`ssh -L`), for this window.
#[tauri::command]
#[specta::specta]
pub async fn ports_forward(
    window: Window,
    state: State<'_, AppState>,
    request: ForwardRequest,
) -> IdeResult<PortForward> {
    state.ports.forward(AppState::owner_window(window.label()), request).await
}

#[tauri::command]
#[specta::specta]
pub fn ports_stop(window: Window, state: State<'_, AppState>, id: u32) {
    state.ports.stop(AppState::owner_window(window.label()), id);
}

/// Moves a forward to another local port (`None`: any free one).
#[tauri::command]
#[specta::specta]
pub async fn ports_change_local(
    window: Window,
    state: State<'_, AppState>,
    id: u32,
    local_port: Option<u16>,
) -> IdeResult<PortForward> {
    state.ports.change_local_port(AppState::owner_window(window.label()), id, local_port).await
}
