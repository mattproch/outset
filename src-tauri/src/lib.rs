//! Outset — Tauri backend.
//!
//! Multi-project, multi-session. The frontend hands us an Outset-side
//! `session_id` on every send; we spawn a Node sidecar per call, pipe its
//! NDJSON output back tagged with that id, and store the Child in a HashMap
//! so we can preempt the same session's in-flight run on the next send
//! without affecting other sessions.
//!
//! Two sidecar invocations share the spawn plumbing:
//!   - `send_message` — kicks off a chat turn (free or spec mode)
//!   - `load_session_history` — replays an SDK session's persisted messages
//!     so we can rehydrate a tab after an app restart
//!
//! Persistence is a single JSON file (`state.json`) in the OS-standard app
//! data directory, holding the project list and session metadata.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use notify::{Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc as tmpsc, Mutex};

// ---------- session state ----------

/// A live sidecar process plus its stdin handle. Stdin stays open for the
/// lifetime of the session so the host can write permission responses back
/// during a query (canUseTool round-trip).
struct SessionEntry {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct SessionState {
    /// Map of Outset session_id → currently-running sidecar entry. Each
    /// Outset session has at most one sidecar process at a time.
    children: Mutex<HashMap<String, SessionEntry>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SidecarEventPayload {
    session_id: String,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionExitPayload {
    session_id: String,
}

// ---------- spec file watcher ----------
//
// One active watcher at a time — we only show one project's spec at a time,
// so there's no reason to keep watchers running for projects the user
// switched away from. `watch_spec` replaces the previous entry; the Drop
// impl on WatcherEntry tears down the notify watcher and aborts the
// debounce task.
//
// Event flow:
//   notify thread -> std mpsc -> debounce task -> Tauri "spec-files-changed"
// The debounce task waits SPEC_DEBOUNCE_MS after the first event in a burst
// before emitting, then drains anything else queued. Editors that save by
// renaming a temp file (Vim, etc.) generate a flurry of events; coalescing
// keeps the frontend from re-reading the .spec tree four times per save.

const SPEC_DEBOUNCE_MS: u64 = 250;

#[allow(dead_code)]
struct WatcherEntry {
    /// Project root the watcher is bound to. Stored for debug visibility.
    cwd: String,
    /// Active notify watcher. Dropped on entry replacement, which closes
    /// the underlying FSEvents (or platform equivalent) stream.
    watcher: RecommendedWatcher,
    /// Aborts the debounce task that bridges notify events to Tauri events.
    abort: tokio::task::AbortHandle,
}

impl Drop for WatcherEntry {
    fn drop(&mut self) {
        self.abort.abort();
    }
}

#[derive(Default)]
struct WatcherState {
    /// At most one active spec watcher across the app.
    active: Mutex<Option<WatcherEntry>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SpecChangedPayload {
    /// Project root whose .spec/ tree changed. The frontend filters on this
    /// so a stale watcher (between switch and unwatch) can't trigger a
    /// refresh on the wrong project.
    cwd: String,
}

/// Start watching `<cwd>/.spec/` for changes. Replaces any prior watcher.
/// If `.spec/` doesn't exist yet, this is a no-op — the next refresh after
/// a Claude turn will create it, and the next call to `watch_spec`
/// (typically on project re-select) will pick it up.
#[tauri::command]
async fn watch_spec(
    app: AppHandle,
    state: State<'_, WatcherState>,
    cwd: String,
) -> Result<(), String> {
    let spec_dir = PathBuf::from(&cwd).join(".spec");

    // Idempotent: if we're already watching this exact cwd, do nothing.
    // Lets the frontend call watch_spec on every Claude `result` event
    // (covers the .spec-just-created case) without thrashing the watcher
    // on every turn. We also drop any watcher that's bound to a different
    // cwd here so we don't briefly run two for the project being torn
    // down.
    {
        let mut active = state.active.lock().await;
        if let Some(entry) = active.as_ref() {
            if entry.cwd == cwd && spec_dir.exists() {
                return Ok(());
            }
        }
        *active = None;
    }

    if !spec_dir.exists() {
        return Ok(());
    }

    let (tx, mut rx) = tmpsc::unbounded_channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<NotifyEvent>| {
        if let Ok(event) = res {
            // Filter to file-content-affecting events. Access-only events
            // (atime updates from Spotlight, etc.) would otherwise wake the
            // debounce loop for nothing.
            if matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("init spec watcher: {e}"))?;

    watcher
        .watch(&spec_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {e}", spec_dir.display()))?;

    let app_clone = app.clone();
    let cwd_clone = cwd.clone();
    let handle = tokio::spawn(async move {
        use tokio::time::{sleep, Duration};
        // recv() returns None when all senders are dropped (i.e. the
        // notify watcher itself is dropped on entry replacement). That's
        // our cue to exit gracefully — though abort() typically gets
        // there first.
        while rx.recv().await.is_some() {
            sleep(Duration::from_millis(SPEC_DEBOUNCE_MS)).await;
            // Drain everything else that piled up during the debounce
            // window so we emit exactly once per burst.
            while rx.try_recv().is_ok() {}
            let _ = app_clone.emit(
                "spec-files-changed",
                SpecChangedPayload {
                    cwd: cwd_clone.clone(),
                },
            );
        }
    });

    let mut active = state.active.lock().await;
    *active = Some(WatcherEntry {
        cwd,
        watcher,
        abort: handle.abort_handle(),
    });
    Ok(())
}

/// Stop the active spec watcher, if any. Called when the selected project
/// is cleared (no project open) and on app shutdown via React effect cleanup.
#[tauri::command]
async fn unwatch_spec(state: State<'_, WatcherState>) -> Result<(), String> {
    let mut active = state.active.lock().await;
    *active = None;
    Ok(())
}

// ---------- persistence ----------

const STATE_FILE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct AppPersistedState {
    version: u32,
    projects: Vec<Project>,
    sessions: Vec<SessionMeta>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    path: String,
    last_opened_at: Option<String>,
    /// "ask" | "acceptEdits" | "bypassAll". Defaulted to "acceptEdits" when
    /// loading old state files that didn't have this field.
    #[serde(default = "default_permission_mode")]
    permission_mode: String,
    /// Project color identifier (matches the TS ProjectColor union). Defaulted
    /// to "zinc" for older state files that predate the field.
    #[serde(default = "default_color")]
    color: String,
}

fn default_permission_mode() -> String {
    "acceptEdits".to_string()
}

fn default_color() -> String {
    "zinc".to_string()
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    id: String,
    project_id: String,
    sdk_session_id: Option<String>,
    title: String,
    mode: String,
    started_at: Option<String>,
    last_message_at: Option<String>,
}

fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
async fn load_app_state(app: AppHandle) -> Result<AppPersistedState, String> {
    let path = state_file_path(&app)?;
    if !path.exists() {
        return Ok(AppPersistedState {
            version: STATE_FILE_VERSION,
            ..Default::default()
        });
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: AppPersistedState = serde_json::from_str(&content)
        .map_err(|e| format!("invalid state.json ({}): {e}", path.display()))?;
    Ok(parsed)
}

#[tauri::command]
async fn save_app_state(app: AppHandle, state: AppPersistedState) -> Result<(), String> {
    let path = state_file_path(&app)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, json)
        .await
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(())
}

// ---------- project introspection ----------

/// Quick check the frontend uses to decide whether to show the "Map this
/// codebase first?" affordance on a fresh spec session. Looks at top-level
/// entries only; doesn't recurse.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct ProjectKind {
    /// True if the folder has any non-hidden, non-`.spec` content.
    has_existing_code: bool,
    /// A human-friendly label like "Node.js", "Rust", "Python" if a known
    /// marker file is present at the root. None otherwise.
    kind: Option<String>,
}

#[tauri::command]
async fn detect_project_kind(cwd: String) -> Result<ProjectKind, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Ok(ProjectKind::default());
    }
    let mut entries = match tokio::fs::read_dir(&path).await {
        Ok(e) => e,
        Err(_) => return Ok(ProjectKind::default()),
    };
    let mut has_existing = false;
    let mut kind: Option<String> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let n = name.to_string_lossy();
        if n.starts_with('.') || n == ".spec" {
            continue;
        }
        has_existing = true;
        if kind.is_none() {
            kind = match n.as_ref() {
                "package.json" => Some("Node.js".to_string()),
                "Cargo.toml" => Some("Rust".to_string()),
                "go.mod" => Some("Go".to_string()),
                "pyproject.toml" | "requirements.txt" | "Pipfile" => {
                    Some("Python".to_string())
                }
                "Gemfile" => Some("Ruby".to_string()),
                "build.gradle" | "build.gradle.kts" | "pom.xml" => {
                    Some("JVM".to_string())
                }
                "composer.json" => Some("PHP".to_string()),
                _ => None,
            };
        }
    }
    Ok(ProjectKind {
        has_existing_code: has_existing,
        kind,
    })
}

// ---------- spec file reading ----------

/// Product specification (.spec/product/*.md) — what we're building, in
/// plain language for non-developers.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct ProductSpec {
    overview: String,
    users: String,
    goals: String,
    decisions: String,
}

/// Codebase specification (.spec/codebase/*.md) — how the system is built,
/// for developers onboarding the codebase. Features are listed separately
/// via list_features.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct CodebaseSpec {
    overview: String,
    architecture: String,
    decisions: String,
}

/// One existing feature, file at `.spec/codebase/features/FEAT-NNN.md`.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Feature {
    id: String,
    content: String,
}

/// One in-flight task, folder at `.spec/tasks/TASK-NNN/`. Each has its own
/// requirements, open questions, and a checklist of subtasks.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    requirements: String,
    questions: String,
    subtasks: String,
}

#[tauri::command]
async fn read_product(cwd: String) -> Result<ProductSpec, String> {
    let base = PathBuf::from(&cwd).join(".spec").join("product");
    let overview = read_optional(&base.join("overview.md")).await?;
    let users = read_optional(&base.join("users.md")).await?;
    let goals = read_optional(&base.join("goals.md")).await?;
    let decisions = read_optional(&base.join("decisions.md")).await?;
    Ok(ProductSpec {
        overview,
        users,
        goals,
        decisions,
    })
}

#[tauri::command]
async fn read_codebase(cwd: String) -> Result<CodebaseSpec, String> {
    let base = PathBuf::from(&cwd).join(".spec").join("codebase");
    let overview = read_optional(&base.join("overview.md")).await?;
    let architecture = read_optional(&base.join("architecture.md")).await?;
    let decisions = read_optional(&base.join("decisions.md")).await?;
    Ok(CodebaseSpec {
        overview,
        architecture,
        decisions,
    })
}

#[tauri::command]
async fn list_features(cwd: String) -> Result<Vec<Feature>, String> {
    let features_dir = PathBuf::from(&cwd)
        .join(".spec")
        .join("codebase")
        .join("features");
    if !features_dir.exists() {
        return Ok(vec![]);
    }
    let mut entries = match tokio::fs::read_dir(&features_dir).await {
        Ok(e) => e,
        Err(e) => return Err(format!("read_dir {}: {e}", features_dir.display())),
    };
    let mut features: Vec<Feature> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name_str = name.to_string_lossy().to_string();
        let id = match name_str.strip_suffix(".md") {
            Some(s) if s.starts_with("FEAT-") => s.to_string(),
            _ => continue,
        };
        let path = entry.path();
        let content = read_optional(&path).await?;
        features.push(Feature { id, content });
    }
    features.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(features)
}

#[tauri::command]
async fn list_tasks(cwd: String) -> Result<Vec<Task>, String> {
    let tasks_dir = PathBuf::from(&cwd).join(".spec").join("tasks");
    if !tasks_dir.exists() {
        return Ok(vec![]);
    }
    let mut entries = match tokio::fs::read_dir(&tasks_dir).await {
        Ok(e) => e,
        Err(e) => return Err(format!("read_dir {}: {e}", tasks_dir.display())),
    };
    let mut tasks: Vec<Task> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name_str = name.to_string_lossy().to_string();
        if !name_str.starts_with("TASK-") {
            continue;
        }
        let path = entry.path();
        let is_dir = match tokio::fs::metadata(&path).await {
            Ok(m) => m.is_dir(),
            Err(_) => continue,
        };
        if !is_dir {
            continue;
        }
        let requirements = read_optional(&path.join("requirements.md")).await?;
        let questions = read_optional(&path.join("questions.md")).await?;
        let subtasks = read_optional(&path.join("subtasks.md")).await?;
        tasks.push(Task {
            id: name_str,
            requirements,
            questions,
            subtasks,
        });
    }
    tasks.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(tasks)
}

/// Delete a task folder under `.spec/tasks/`. Used by the dashboard's
/// "Mark complete" action — the user has folded the outcomes into the
/// product/ and codebase/ specs and is ready to retire the task.
#[tauri::command]
async fn remove_task(cwd: String, id: String) -> Result<(), String> {
    if !id.starts_with("TASK-") {
        return Err(format!("invalid task id: {id}"));
    }
    let dir = PathBuf::from(&cwd).join(".spec").join("tasks").join(&id);
    if !dir.exists() {
        return Err(format!("task {id} does not exist at {}", dir.display()));
    }
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|e| format!("remove {}: {e}", dir.display()))?;
    Ok(())
}

#[tauri::command]
async fn create_task(cwd: String, name: String) -> Result<Task, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("task name is required".to_string());
    }
    let tasks_dir = PathBuf::from(&cwd).join(".spec").join("tasks");
    tokio::fs::create_dir_all(&tasks_dir)
        .await
        .map_err(|e| format!("create {}: {e}", tasks_dir.display()))?;

    let mut max_n: u32 = 0;
    if let Ok(mut entries) = tokio::fs::read_dir(&tasks_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let n = entry.file_name();
            let s = n.to_string_lossy();
            if let Some(rest) = s.strip_prefix("TASK-") {
                if let Ok(num) = rest.parse::<u32>() {
                    if num > max_n {
                        max_n = num;
                    }
                }
            }
        }
    }
    let next_id = format!("TASK-{:03}", max_n + 1);
    let dir = tasks_dir.join(&next_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create {}: {e}", dir.display()))?;

    let initial_requirements = format!(
        "# {}\n\n## Goal\n_TBD_\n\n## Constraints\n_TBD_\n",
        trimmed
    );
    tokio::fs::write(dir.join("requirements.md"), &initial_requirements)
        .await
        .map_err(|e| format!("write requirements: {e}"))?;
    tokio::fs::write(dir.join("questions.md"), "")
        .await
        .map_err(|e| format!("write questions: {e}"))?;
    tokio::fs::write(dir.join("subtasks.md"), "")
        .await
        .map_err(|e| format!("write subtasks: {e}"))?;

    Ok(Task {
        id: next_id,
        requirements: initial_requirements,
        questions: String::new(),
        subtasks: String::new(),
    })
}

// ---------- git inspection ----------
//
// We shell out to the user's `git` binary rather than linking libgit2 — git
// is universally present on dev machines and the surface area we need is
// tiny (status + diff). Returns are best-effort: anything that fails returns
// an error string the frontend can surface, and a non-repo directory just
// returns hasRepo: false.

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GitFileChange {
    path: String,
    /// "modified" | "added" | "deleted" | "renamed" | "copied" | "unmerged" |
    /// "untracked" | "unknown"
    status: String,
    old_path: Option<String>,
    additions: u32,
    deletions: u32,
    /// True when the file has staged changes (porcelain X col is non-space).
    staged: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GitRemote {
    name: String,
    url: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct GitChanges {
    /// false if cwd is outside any git repo. Frontend shows an empty state.
    has_repo: bool,
    branch: Option<String>,
    /// `origin` remote URL when configured. Frontend uses this to render
    /// the remote line and decide whether `git push` will work.
    remote: Option<GitRemote>,
    files: Vec<GitFileChange>,
}

async fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("git not available: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn parse_porcelain_status(xy: &str, rest: &str) -> (String, Option<String>, String) {
    if xy == "??" {
        return ("untracked".into(), None, rest.to_string());
    }
    let chars: Vec<char> = xy.chars().collect();
    let staged = chars.first().copied().unwrap_or(' ');
    let unstaged = chars.get(1).copied().unwrap_or(' ');
    // Renames have " -> " in the path part (porcelain v1 format).
    let (old_path, path) = if let Some(idx) = rest.find(" -> ") {
        (
            Some(rest[..idx].to_string()),
            rest[idx + 4..].to_string(),
        )
    } else {
        (None, rest.to_string())
    };
    let primary = if staged != ' ' && staged != '?' {
        staged
    } else {
        unstaged
    };
    let status = match primary {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'U' => "unmerged",
        '?' => "untracked",
        _ => "unknown",
    };
    (status.into(), old_path, path)
}

#[tauri::command]
async fn git_changes(cwd: String) -> Result<GitChanges, String> {
    let cwd_path = PathBuf::from(&cwd);

    // Outside a git work tree → return cleanly with hasRepo: false. We don't
    // want to surface a "not a repo" error every time the user opens
    // a non-git project.
    if run_git(&cwd_path, &["rev-parse", "--is-inside-work-tree"])
        .await
        .is_err()
    {
        return Ok(GitChanges::default());
    }

    let branch = run_git(&cwd_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Origin URL, if any. `git remote get-url origin` errors when no
    // origin is configured; treat that as None rather than a hard error.
    let remote = run_git(&cwd_path, &["remote", "get-url", "origin"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|url| GitRemote {
            name: "origin".into(),
            url,
        });

    // -uall — include untracked files individually (not folded into "??").
    // --no-renames — keep simple per-path entries; we surface renames via
    // the porcelain X/Y codes.
    let status_out = run_git(
        &cwd_path,
        &["status", "--porcelain=v1", "-uall"],
    )
    .await?;

    // Numstat for both staged + unstaged; aggregate by path so a file that's
    // partially staged shows the combined delta.
    let unstaged = run_git(&cwd_path, &["diff", "--numstat"]).await.unwrap_or_default();
    let staged_n = run_git(&cwd_path, &["diff", "--numstat", "--cached"])
        .await
        .unwrap_or_default();
    let mut numstat: HashMap<String, (u32, u32)> = HashMap::new();
    for line in unstaged.lines().chain(staged_n.lines()) {
        let mut parts = line.split('\t');
        let adds = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let dels = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let path = parts.next().unwrap_or("").to_string();
        if !path.is_empty() {
            let entry = numstat.entry(path).or_insert((0, 0));
            entry.0 += adds;
            entry.1 += dels;
        }
    }

    let mut files: Vec<GitFileChange> = Vec::new();
    for line in status_out.lines() {
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        let rest = &line[3..];
        let (status, old_path, path) = parse_porcelain_status(xy, rest);
        let (additions, deletions) = numstat.get(&path).copied().unwrap_or((0, 0));
        let staged_flag = xy
            .chars()
            .next()
            .map(|c| c != ' ' && c != '?')
            .unwrap_or(false);
        files.push(GitFileChange {
            path,
            status,
            old_path,
            additions,
            deletions,
            staged: staged_flag,
        });
    }

    Ok(GitChanges {
        has_repo: true,
        branch,
        remote,
        files,
    })
}

#[tauri::command]
async fn git_file_diff(
    cwd: String,
    path: String,
    untracked: bool,
) -> Result<String, String> {
    let cwd_path = PathBuf::from(&cwd);
    if untracked {
        // No HEAD baseline to diff against. Render the full file as a
        // synthetic added-lines diff so the frontend's diff parser works
        // uniformly. Bail safely on read errors and on plausibly-binary
        // files (>1 MiB).
        let abs = cwd_path.join(&path);
        let meta = tokio::fs::metadata(&abs)
            .await
            .map_err(|e| format!("stat {path}: {e}"))?;
        if meta.len() > 1_000_000 {
            return Ok(format!("--- /dev/null\n+++ b/{path}\n(file too large to preview)\n"));
        }
        let content = match tokio::fs::read_to_string(&abs).await {
            Ok(s) => s,
            Err(_) => {
                return Ok(format!(
                    "--- /dev/null\n+++ b/{path}\n(binary or unreadable file)\n"
                ));
            }
        };
        let mut out = String::with_capacity(content.len() + path.len() + 32);
        out.push_str(&format!("--- /dev/null\n+++ b/{path}\n"));
        for line in content.split_inclusive('\n') {
            out.push('+');
            out.push_str(line.trim_end_matches('\n'));
            out.push('\n');
        }
        return Ok(out);
    }
    // Working tree vs HEAD — captures both staged and unstaged changes.
    run_git(&cwd_path, &["diff", "HEAD", "--", &path]).await
}

/// Stage every change in the work tree and commit with the given message.
/// Returns the commit's first-line summary on success so the UI can flash a
/// confirmation. Empty messages and empty repos return errors.
#[tauri::command]
async fn git_commit(cwd: String, message: String) -> Result<String, String> {
    let cwd_path = PathBuf::from(&cwd);
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message is empty".into());
    }
    run_git(&cwd_path, &["add", "-A"]).await?;
    run_git(&cwd_path, &["commit", "-m", trimmed]).await?;
    let head = run_git(&cwd_path, &["log", "-1", "--pretty=%h %s"])
        .await
        .unwrap_or_default()
        .trim()
        .to_string();
    Ok(head)
}

/// Push the current branch to its upstream. If no upstream is configured,
/// this returns the git error verbatim so the user sees what's missing.
#[tauri::command]
async fn git_push(cwd: String) -> Result<String, String> {
    let cwd_path = PathBuf::from(&cwd);
    // -u sets upstream on first push, so subsequent pushes don't need a
    // branch argument. For repos that already have an upstream this is a
    // no-op; for fresh remotes it's exactly what the user wants.
    let head = run_git(&cwd_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    if let Some(branch) = head {
        run_git(&cwd_path, &["push", "-u", "origin", &branch]).await
    } else {
        run_git(&cwd_path, &["push"]).await
    }
}

/// Minimal starter `.gitignore` that ships with every fresh repo
/// initialised through Outset. Generic — covers OS clutter, common
/// editor noise, JS toolchain output, and env files. Project-specific
/// patterns are still the user's responsibility.
const STARTER_GITIGNORE: &str = "# OS
.DS_Store
Thumbs.db

# Editor
.idea/
.vscode/
*.swp

# Logs
*.log

# Env
.env
.env.local
.env.*.local

# Node / build output
node_modules/
dist/
build/
.cache/
";

/// `git init` in the project folder. Used by the panel's "Initialize git
/// repo" button when the folder isn't a repo yet. Also seeds a starter
/// `.gitignore` when one doesn't exist — it's the first thing every new
/// repo should have, and skipping it leads to `.DS_Store` etc. ending
/// up in the first commit.
#[tauri::command]
async fn git_init(cwd: String) -> Result<(), String> {
    let cwd_path = PathBuf::from(&cwd);
    run_git(&cwd_path, &["init"]).await?;
    let gitignore = cwd_path.join(".gitignore");
    if !gitignore.exists() {
        tokio::fs::write(&gitignore, STARTER_GITIGNORE)
            .await
            .map_err(|e| format!("failed to write .gitignore: {e}"))?;
    }
    Ok(())
}

/// Clone a Git repo INTO an existing folder, without nesting it in a
/// subdirectory. Used by the Git panel's "Clone existing repo" affordance
/// for folders the user has already added as a project. Strategy:
/// `git init` + `remote add origin` + `fetch` + `checkout` of the remote
/// HEAD branch. Refuses to run when the folder already has a `.git`
/// directory, to avoid trampling history.
///
/// Files already in the folder are preserved by `git checkout` — git will
/// merge them with the remote tree where it can, or fail loudly when
/// there are conflicts. The `force_when_nonempty` flag isn't a power
/// override, just an acknowledgement from the UI that the user knows the
/// folder isn't empty.
#[tauri::command]
async fn git_clone_into(
    cwd: String,
    url: String,
    force_when_nonempty: bool,
) -> Result<String, String> {
    let cwd_path = PathBuf::from(&cwd);
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Repo URL is empty".into());
    }
    if cwd_path.join(".git").exists() {
        return Err(
            "This folder already has a .git directory; use a different folder or remove .git first."
                .into(),
        );
    }
    // Light non-empty guard — folder may have something the user wants
    // to keep. The frontend asks the user to confirm before sending
    // force_when_nonempty=true.
    if !force_when_nonempty {
        let mut entries = tokio::fs::read_dir(&cwd_path)
            .await
            .map_err(|e| format!("read {}: {e}", cwd_path.display()))?;
        if let Some(_first) = entries
            .next_entry()
            .await
            .map_err(|e| format!("read entries: {e}"))?
        {
            return Err("Folder is not empty. Confirm to clone into it anyway.".into());
        }
    }
    run_git(&cwd_path, &["init"]).await?;
    run_git(&cwd_path, &["remote", "add", "origin", trimmed]).await?;
    run_git(&cwd_path, &["fetch", "origin"]).await?;
    // Prefer the remote's HEAD branch (typically main / master). Fall
    // back to "main" if the symbolic-ref lookup fails (older git, or
    // detached remote HEAD).
    let head_ref = run_git(
        &cwd_path,
        &["symbolic-ref", "refs/remotes/origin/HEAD"],
    )
    .await
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
    let branch = head_ref
        .as_deref()
        .and_then(|s| s.strip_prefix("refs/remotes/origin/"))
        .unwrap_or("main")
        .to_string();
    // -B creates the branch if it doesn't exist locally yet. The
    // tracking ref (origin/<branch>) is what we actually want to check
    // out content from.
    let tracking = format!("origin/{branch}");
    run_git(&cwd_path, &["checkout", "-B", &branch, &tracking]).await?;
    Ok(branch)
}

/// Clone a Git repo into a freshly-created subfolder under the chosen
/// parent directory. Used by the dashboard's "Add project from Git"
/// flow. Returns the absolute path to the cloned subfolder so the
/// frontend can register it as a project.
///
/// `parent_dir` must exist. The subfolder name is derived from the URL
/// (last path segment, stripped of `.git`); collisions are surfaced as
/// errors rather than silently appending a suffix.
#[tauri::command]
async fn git_clone_to_parent(parent_dir: String, url: String) -> Result<String, String> {
    let parent_path = PathBuf::from(&parent_dir);
    if !parent_path.is_dir() {
        return Err(format!(
            "Parent folder doesn't exist: {}",
            parent_path.display()
        ));
    }
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Repo URL is empty".into());
    }
    let name = derive_clone_name(trimmed)
        .ok_or_else(|| format!("Couldn't infer a folder name from URL: {trimmed}"))?;
    let target = parent_path.join(&name);
    if target.exists() {
        return Err(format!(
            "A folder named '{name}' already exists in the chosen parent."
        ));
    }
    // Standard `git clone <url> <target>`. Cwd doesn't matter here
    // since we're passing both args explicitly.
    run_git(&parent_path, &["clone", trimmed, &name]).await?;
    Ok(target.to_string_lossy().to_string())
}

/// Pull a sensible default subfolder name out of a clone URL.
/// Handles the common shapes: HTTPS, SSH (`git@host:user/repo.git`),
/// and bare paths. Returns None if nothing usable is left after
/// trimming.
fn derive_clone_name(url: &str) -> Option<String> {
    // Drop trailing slashes and any URL fragment / query (rare but cheap).
    let cleaned = url.trim_end_matches('/').split(&['?', '#'][..]).next()?;
    // Last segment after `/` or `:` (the latter for SSH `git@host:user/repo`).
    let last = cleaned
        .rsplit(|c| c == '/' || c == ':')
        .next()?
        .trim();
    if last.is_empty() {
        return None;
    }
    let stripped = last.strip_suffix(".git").unwrap_or(last);
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

/// Add or update the `origin` remote. Idempotent — uses `set-url` when
/// origin already exists, `add` when it doesn't.
#[tauri::command]
async fn git_set_origin(cwd: String, url: String) -> Result<(), String> {
    let cwd_path = PathBuf::from(&cwd);
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Remote URL is empty".into());
    }
    let exists = run_git(&cwd_path, &["remote", "get-url", "origin"])
        .await
        .is_ok();
    if exists {
        run_git(&cwd_path, &["remote", "set-url", "origin", trimmed]).await?;
    } else {
        run_git(&cwd_path, &["remote", "add", "origin", trimmed]).await?;
    }
    Ok(())
}

/// Remove the `origin` remote entirely.
#[tauri::command]
async fn git_remove_origin(cwd: String) -> Result<(), String> {
    let cwd_path = PathBuf::from(&cwd);
    run_git(&cwd_path, &["remote", "remove", "origin"]).await?;
    Ok(())
}

async fn read_optional(path: &Path) -> Result<String, String> {
    match tokio::fs::read_to_string(path).await {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

// ---------- sidecar spawn plumbing ----------

/// Locate the bundled sidecar binary.
///
/// The sidecar is a `bun build --compile` output listed in
/// `tauri.conf.json` under `bundle.externalBin`, so Tauri ships it next
/// to the main app binary in every build:
///   - macOS .app:  `Outset.app/Contents/MacOS/outset-sidecar`
///   - dev / debug: `target/{debug,release}/outset-sidecar`
///
/// Both layouts are reachable via `current_exe().parent()`. We deliberately
/// don't use `env!("CARGO_MANIFEST_DIR")` anymore — that's a compile-time
/// constant baked from whatever path the binary was built on, which makes
/// CI builds fail to find anything when distributed.
fn sidecar_bin() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("can't locate current exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current exe has no parent dir".to_string())?;
    let bin_name = if cfg!(windows) {
        "outset-sidecar.exe"
    } else {
        "outset-sidecar"
    };
    let candidate = dir.join(bin_name);
    if candidate.exists() {
        Ok(candidate)
    } else {
        Err(format!(
            "Sidecar binary not found at {}. \
             Run `yarn sidecar:build` or `yarn tauri dev` (which runs it automatically).",
            candidate.display()
        ))
    }
}

/// Fallback project dir for the rare case a command JSON arrives without
/// a usable cwd. Used to be `repo_root()`; now resolves to the directory
/// of the running app — close enough for an error-path default.
fn fallback_project_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Kill a sidecar AND every process it spawned (the claude subprocess).
/// Sends SIGKILL to the negative pid, which targets the whole process group
/// (set up at spawn time via `process_group(0)`). Drops the stdin handle as
/// a side effect of consuming the entry.
async fn kill_session_tree(entry: &mut SessionEntry) {
    #[cfg(unix)]
    {
        if let Some(pid) = entry.child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            let _ = entry.child.wait().await;
            return;
        }
    }
    let _ = entry.child.kill().await;
}

/// Shared spawn-and-pipe logic for both `send_message` and
/// `load_session_history`. Preempts any prior sidecar for this session_id,
/// spawns a new one, writes the command JSON to its stdin, and forwards
/// stdout/stderr to the frontend tagged with the session id.
async fn spawn_sidecar_with_command(
    app: &AppHandle,
    state: &SessionState,
    session_id: String,
    command_json: String,
) -> Result<(), String> {
    // Preempt only THIS session's in-flight child.
    {
        let mut children = state.children.lock().await;
        if let Some(mut existing) = children.remove(&session_id) {
            kill_session_tree(&mut existing).await;
        }
    }

    let sidecar = sidecar_bin()?;

    // Decode the user-provided cwd from the command JSON so we can spawn the
    // sidecar in the project folder. This way the whole chain (sidecar →
    // Claude Code subprocess) runs with the project dir as its OS cwd, not
    // just the SDK's logical cwd. Falls back to a generic dir when the
    // command JSON is malformed (an error path that shouldn't really hit).
    let project_dir = serde_json::from_str::<serde_json::Value>(&command_json)
        .ok()
        .and_then(|v| v.get("cwd").and_then(|c| c.as_str()).map(PathBuf::from))
        .filter(|p| p.is_dir())
        .unwrap_or_else(fallback_project_dir);

    let mut cmd_builder = Command::new(&sidecar);
    cmd_builder
        .current_dir(&project_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Broaden PATH for the child. macOS GUI launches inherit a minimal
    // PATH from launchd (typically just /usr/bin:/bin:/usr/sbin:/sbin),
    // which won't include Homebrew (/opt/homebrew/bin), npm-global
    // installs (~/.npm-global/bin), or volta — all common claude-code
    // install locations. The sidecar's findClaudeBin() walks PATH first,
    // so prepending these here makes the lookup actually work in the
    // shipped app. No-op when the user's PATH already has them.
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let extras = [
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
            format!("{home}/.npm-global/bin"),
            format!("{home}/.npm/bin"),
            format!("{home}/.local/bin"),
            format!("{home}/.volta/bin"),
        ];
        let current = std::env::var("PATH").unwrap_or_default();
        let mut parts: Vec<String> = current
            .split(':')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        for p in extras {
            if !parts.iter().any(|x| x == &p) {
                parts.push(p);
            }
        }
        cmd_builder.env("PATH", parts.join(":"));
    }
    // Sidecar leader of its own process group so Stop takes down both the
    // Node process AND the claude subprocess it spawns.
    #[cfg(unix)]
    cmd_builder.process_group(0);
    let mut child = cmd_builder
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

    let mut stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;

    stdin
        .write_all(command_json.as_bytes())
        .await
        .map_err(|e| format!("write stdin: {e}"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("write stdin newline: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("flush stdin: {e}"))?;
    // KEEP stdin open: the host can send permission_response messages back
    // while the query runs. Stdin is closed implicitly when the SessionEntry
    // is dropped (e.g. on stop_session or preemption).

    // Forward stdout (NDJSON), tagged with session_id.
    let app_out = app.clone();
    let sid_out = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let _ = app_out.emit(
                        "sidecar-event",
                        SidecarEventPayload {
                            session_id: sid_out.clone(),
                            line,
                        },
                    );
                }
                Ok(None) => {
                    let _ = app_out.emit(
                        "sidecar-exit",
                        SessionExitPayload {
                            session_id: sid_out.clone(),
                        },
                    );
                    break;
                }
                Err(e) => {
                    let _ = app_out.emit(
                        "sidecar-event",
                        SidecarEventPayload {
                            session_id: sid_out.clone(),
                            line: format!(
                                "{{\"kind\":\"fatal\",\"message\":\"stdout read error: {e}\"}}"
                            ),
                        },
                    );
                    break;
                }
            }
        }
    });

    // Forward stderr line-by-line (also tagged).
    let app_err = app.clone();
    let sid_err = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "sidecar-stderr",
                SidecarEventPayload {
                    session_id: sid_err.clone(),
                    line,
                },
            );
        }
    });

    state
        .children
        .lock()
        .await
        .insert(session_id, SessionEntry { child, stdin });
    Ok(())
}

/// Write a JSON line to a running sidecar's stdin. Used for permission
/// responses (and, in the future, AskUserQuestion answers).
#[tauri::command]
async fn respond_to_session(
    state: State<'_, SessionState>,
    session_id: String,
    body: String,
) -> Result<(), String> {
    let mut children = state.children.lock().await;
    let entry = children.get_mut(&session_id).ok_or_else(|| {
        format!("no running sidecar for session {session_id}")
    })?;
    entry
        .stdin
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write stdin: {e}"))?;
    entry
        .stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("write stdin newline: {e}"))?;
    entry
        .stdin
        .flush()
        .await
        .map_err(|e| format!("flush stdin: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn send_message(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
    cwd: String,
    prompt: String,
    resume: Option<String>,
    mode: Option<String>,
    permission_mode: Option<String>,
) -> Result<(), String> {
    let mode = match mode.as_deref() {
        Some("spec") => "spec",
        _ => "free",
    };
    let perm = match permission_mode.as_deref() {
        Some("ask") => "ask",
        Some("bypassAll") => "bypassAll",
        _ => "acceptEdits",
    };
    let cmd = serde_json::json!({
        "kind": "send",
        "cwd": cwd,
        "prompt": prompt,
        "resume": resume,
        "mode": mode,
        "permission_mode": perm,
    });
    spawn_sidecar_with_command(&app, state.inner(), session_id, cmd.to_string()).await
}

#[tauri::command]
async fn load_session_history(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
    cwd: String,
    sdk_session_id: String,
) -> Result<(), String> {
    let cmd = serde_json::json!({
        "kind": "load_history",
        "cwd": cwd,
        "sdk_session_id": sdk_session_id,
    });
    spawn_sidecar_with_command(&app, state.inner(), session_id, cmd.to_string()).await
}

#[tauri::command]
async fn stop_session(
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<(), String> {
    let mut children = state.children.lock().await;
    if let Some(mut entry) = children.remove(&session_id) {
        kill_session_tree(&mut entry).await;
    }
    Ok(())
}

// ---------- entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Auto-updater. Production builds verify a signed manifest at
        // the endpoint configured in tauri.conf.json (plugins.updater).
        // The host calls @tauri-apps/plugin-updater's check() from JS to
        // surface available updates.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Used by the JS side to relaunch the app after an update.
        .plugin(tauri_plugin_process::init())
        .manage(SessionState::default())
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            send_message,
            load_session_history,
            stop_session,
            respond_to_session,
            read_product,
            read_codebase,
            list_features,
            list_tasks,
            create_task,
            remove_task,
            git_changes,
            git_file_diff,
            git_commit,
            git_push,
            git_init,
            git_clone_into,
            git_clone_to_parent,
            git_set_origin,
            git_remove_origin,
            detect_project_kind,
            watch_spec,
            unwatch_spec,
            load_app_state,
            save_app_state
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                match sidecar_bin() {
                    Ok(p) => println!("[outset] sidecar bin:   {}", p.display()),
                    Err(e) => println!("[outset] sidecar bin:   <missing> ({e})"),
                }
                if let Ok(p) = state_file_path(app.handle()) {
                    println!("[outset] state file:    {}", p.display());
                }
            }
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running outset");
}
